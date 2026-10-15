/* ============================================================================
 * HTML → Figma 1:1 复刻  ——  主线程 (Figma Plugin Sandbox)
 *
 * 输入：插件 UI 捕获的「渲染快照」（真实浏览器排版后的 DOM 测量 + 计算样式）
 * 输出：在当前页面生成与网页逐像素对齐的、可继续编辑的 Figma 图层树
 *
 * 约定：快照里所有坐标都是相对父节点的 CSS 像素；颜色为 0~1 的 {r,g,b(,a)}
 * ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ 状态 */

const S = {
  fontDB: null,             // Map<familyKey, {family, styles: Map<styleKey, style>}>
  loadedFonts: new Set(),   // 'Family|Style'
  fontCache: new Map(),     // 文本样式指纹 -> {family, style}
  images: new Map(),        // ref -> imageHash | null
  pendingImages: new Map(), // ref -> resolve(base64|null)
  cancel: false,
  warnings: [],
  maxNodes: 20000,
  pages: new Map(),         // 整包模式：页面名 -> 已生成的顶层画板
  pending: [],              // 待绑定的交互（等目标页画板就绪后统一处理）
  pkgRun: null,             // 整包排布游标 { id, y, nextX, gap }
};

const PLACEHOLDER_FILL = { type: 'SOLID', color: { r: 0.90, g: 0.90, b: 0.91 }, opacity: 1 };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }

/* ------------------------------------------------------------- base64 解码 */
/* Figma 主线程没有 atob，这里自带一个纯 JS 实现 */

let B64_TABLE = null;
function b64Table() {
  if (B64_TABLE) return B64_TABLE;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const t = new Uint8Array(256);
  for (let i = 0; i < t.length; i++) t[i] = 0;
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  B64_TABLE = t;
  return t;
}

function base64ToBytes(b64) {
  const table = b64Table();
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
  const len = clean.length;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0;
  let i = 0;
  while (i < len) {
    const c0 = table[clean.charCodeAt(i++)];
    const c1 = i < len ? table[clean.charCodeAt(i++)] : 0;
    const c2 = i < len ? table[clean.charCodeAt(i++)] : 0;
    const c3 = i < len ? table[clean.charCodeAt(i++)] : 0;
    if (o < out.length) out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < out.length) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (o < out.length) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

/* ------------------------------------------------------------------ 字体 */

const WEIGHT_STYLE_NAMES = {
  100: ['thin', 'hairline'],
  200: ['extralight', 'ultralight', 'thin'],
  300: ['light'],
  400: ['regular', 'book', 'normal', 'roman'],
  500: ['medium'],
  600: ['semibold', 'demibold', 'semibold'],
  700: ['bold'],
  800: ['extrabold', 'ultrabold', 'heavy'],
  900: ['black', 'heavy', 'ultra'],
};

/* CSS 通用字体族 / 系统字体 到 Figma 可用字体的映射 */
const FAMILY_ALIAS = {
  systemui: 'Inter',
  appleui: 'Inter',
  segoeui: 'Inter',
  sfprotext: 'Inter',
  sfprodisplay: 'Inter',
  helvetica: 'Inter',
  helveticaneue: 'Inter',
  arial: 'Inter',
  arialhelvetica: 'Inter',
  sansserif: 'Inter',
  uisansserif: 'Inter',
  cursive: 'Inter',
  fantasy: 'Inter',
  serif: 'Noto Serif',
  uiserif: 'Noto Serif',
  times: 'Noto Serif',
  timesnewroman: 'Noto Serif',
  georgia: 'Noto Serif',
  monospace: 'Roboto Mono',
  uimonospace: 'Roboto Mono',
  consolas: 'Roboto Mono',
  menlo: 'Roboto Mono',
  monaco: 'Roboto Mono',
  couriernew: 'Roboto Mono',
};

/* 中文字形缺失时的兜底字体链 */
const CJK_FALLBACKS = [
  'Noto Sans SC', 'Noto Sans TC', 'Noto Sans JP',
  'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei',
  'Hiragino Sans GB', 'Noto Sans',
];

function normKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s_\-]+/g, ''); }

function closestWeight(w) {
  const keys = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  let best = 400;
  let bestD = Infinity;
  for (const k of keys) {
    const d = Math.abs(k - w);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

async function ensureFontDB() {
  if (S.fontDB) return S.fontDB;
  const list = await figma.listAvailableFontsAsync();
  const db = new Map();
  for (const item of list) {
    const fam = item.fontName.family;
    const sty = item.fontName.style;
    const fk = normKey(fam);
    let entry = db.get(fk);
    if (!entry) { entry = { family: fam, styles: new Map() }; db.set(fk, entry); }
    entry.styles.set(normKey(sty), sty);
  }
  S.fontDB = db;
  return db;
}

function pickStyle(entry, weight, italic) {
  const names = WEIGHT_STYLE_NAMES[closestWeight(weight)] || WEIGHT_STYLE_NAMES[400];
  const cands = [];
  for (const n of names) {
    if (italic) { cands.push(n + 'italic'); cands.push(n + 'oblique'); }
    cands.push(n);
  }
  if (italic) { cands.push('italic'); cands.push('oblique'); }
  cands.push('regular', 'book', 'normal');
  for (const c of cands) {
    const s = entry.styles.get(c);
    if (s) return s;
  }
  const want = names[0];
  for (const pair of entry.styles) {
    const k = pair[0];
    if (k.indexOf(want) >= 0 && (!italic || k.indexOf('italic') >= 0 || k.indexOf('oblique') >= 0)) return pair[1];
  }
  if (italic) {
    for (const pair of entry.styles) {
      if (pair[0].indexOf('italic') >= 0 || pair[0].indexOf('oblique') >= 0) return pair[1];
    }
  }
  const first = entry.styles.values().next();
  return first.done ? null : first.value;
}

function resolveFont(tx) {
  const families = tx.families && tx.families.length ? tx.families : ['Inter'];
  const key = families.join(',') + '|' + (tx.weight || 400) + '|' + (tx.italic ? 1 : 0) + '|' + (tx.cjk ? 1 : 0);
  const cached = S.fontCache.get(key);
  if (cached) return cached;

  /* CJK 文本必须**优先**用 CJK 字体。
     Figma 的文本节点只有一个 fontName，不像 CSS 能沿 fallback 链逐字挑字形 ——
     顺序排错就会「中文也去用 Roboto」，而 Roboto 没有中文字形，
     Figma 只好自己回退，字形就变成系统字体了（这就是之前截图里不对的原因）。
     Noto Sans SC 自带拉丁字形，所以中文优先不会影响混排。 */
  const wanted = [];
  if (tx.cjk) {
    for (const f of CJK_FALLBACKS) if (wanted.indexOf(f) < 0) wanted.push(f);
  }
  for (const f of families) {
    const n = normKey(f);
    const mapped = FAMILY_ALIAS[n] || f;
    if (wanted.indexOf(mapped) < 0) wanted.push(mapped);
  }
  wanted.push('Inter');

  let result = { family: 'Inter', style: 'Regular' };
  for (const fam of wanted) {
    const entry = S.fontDB.get(normKey(fam));
    if (!entry) continue;
    const style = pickStyle(entry, tx.weight || 400, !!tx.italic);
    if (style) { result = { family: entry.family, style }; break; }
  }
  S.fontCache.set(key, result);
  return result;
}

async function ensureFont(font) {
  const k = font.family + '|' + font.style;
  if (S.loadedFonts.has(k)) return font;
  try {
    await figma.loadFontAsync(font);
    S.loadedFonts.add(k);
    return font;
  } catch (e) {
    const fb = { family: 'Inter', style: 'Regular' };
    try { await figma.loadFontAsync(fb); S.loadedFonts.add('Inter|Regular'); } catch (e2) { /* ignore */ }
    S.warnings.push('字体不可用，已回退 Inter：' + k);
    return fb;
  }
}

/* ------------------------------------------------------------------ 图片 */

function requestImageBytes(ref) {
  return new Promise((resolve) => {
    S.pendingImages.set(ref, resolve);
    figma.ui.postMessage({ type: 'get-image', ref });
    setTimeout(() => {
      if (S.pendingImages.has(ref)) {
        S.pendingImages.delete(ref);
        resolve(null);
      }
    }, 20000);
  });
}

function createImageFromBase64(b64) {
  try {
    const bytes = base64ToBytes(b64);
    if (!bytes.length) return null;
    return figma.createImage(bytes);
  } catch (e) {
    return null;
  }
}

async function loadImages(list) {
  if (!list || !list.length) return;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (S.cancel) return;
    let hash = null;
    try {
      if (item.data) {
        /* 已经内联成 dataURL：直接解码成字节交给 figma.createImage。
           别绕回 UI 要 base64 —— 那次往返依赖 UI 侧的图片表（历史上没人填过），
           真机上最典型的表现就是「图片全变灰底占位」。 */
        const m = /^data:([^;,]*);base64,(.*)$/i.exec(String(item.url || ''));
        if (m) {
          try { hash = createImageFromBase64(m[2]); } catch (e) { hash = null; }
        }
        if (!hash) hash = await requestImageBytes(item.ref);   /* 兜底：回 UI 要 */
      } else if (item.url) {
        if (typeof figma.createImageAsync === 'function') {
          try {
            const im = await figma.createImageAsync(item.url);
            hash = im ? im.hash : null;
          } catch (e) { hash = null; }
        }
        if (!hash) hash = await requestImageBytes(item.ref);
      }
    } catch (e) {
      hash = null;
    }
    S.images.set(item.ref, hash);
    if (!hash) S.warnings.push('图片获取失败，已用灰底占位：' + (item.url || item.ref));
    if (i % 3 === 0) {
      figma.ui.postMessage({ type: 'progress', phase: '下载图片', done: i, total: list.length });
      await tick();
    }
  }
}

/* ------------------------------------------------------- 快照 -> 图层属性 */

function resolvePaints(paints) {
  if (!paints || !paints.length) return [];
  const out = [];
  for (const p of paints) {
    if (!p) continue;
    if (p.type === 'IMAGE_REF') {
      const hash = S.images.get(p.ref);
      if (hash) {
        out.push({ type: 'IMAGE', scaleMode: p.scaleMode || 'FILL', imageHash: hash, visible: true });
      } else {
        out.push(PLACEHOLDER_FILL);
      }
    } else if (p.type === 'SOLID') {
      out.push({ type: 'SOLID', color: p.color, opacity: p.opacity == null ? 1 : p.opacity, visible: true });
    } else if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
      out.push({
        type: p.type,
        gradientTransform: p.gradientTransform,
        gradientStops: p.gradientStops,
        visible: true,
      });
    } else {
      out.push(p);
    }
  }
  return out;
}

function applyVisuals(node, rec) {
  const fills = resolvePaints(rec.fills);
  try { node.fills = fills; } catch (e) { /* 某些节点不接受 fills */ }

  if (rec.strokes && rec.strokes.length) {
    try {
      node.strokes = resolvePaints(rec.strokes);
      node.strokeAlign = 'INSIDE';
      const w = rec.strokeWeights;
      if (typeof w === 'number') {
        node.strokeWeight = w;
      } else if (w && w.length === 4) {
        node.strokeTopWeight = w[0];
        node.strokeRightWeight = w[1];
        node.strokeBottomWeight = w[2];
        node.strokeLeftWeight = w[3];
      }
      if (rec.dash && rec.dash.length) node.dashPattern = rec.dash;
    } catch (e) {
      S.warnings.push('描边设置失败：' + (rec.name || ''));
    }
  }

  if (rec.radius && rec.radius.length === 4) {
    const r = rec.radius;
    const lim = Math.min(rec.w, rec.h) / 2 + 0.01;
    try {
      node.topLeftRadius = clamp(r[0], 0, lim);
      node.topRightRadius = clamp(r[1], 0, lim);
      node.bottomRightRadius = clamp(r[2], 0, lim);
      node.bottomLeftRadius = clamp(r[3], 0, lim);
    } catch (e) { /* 忽略 */ }
  }

  if (rec.effects && rec.effects.length) {
    try { node.effects = rec.effects; } catch (e) { /* 忽略 */ }
  }

  if (typeof rec.opacity === 'number' && rec.opacity < 1) {
    try { node.opacity = clamp(rec.opacity, 0, 1); } catch (e) { /* 忽略 */ }
  }
  if (rec.blendMode && rec.blendMode !== 'NORMAL') {
    try { node.blendMode = rec.blendMode; } catch (e) { /* 忽略 */ }
  }
}

function makeTextNode(rec) {
  const tx = rec.text;
  const t = figma.createText();
  const font = resolveFont(tx);
  try { t.fontName = font; } catch (e) { t.fontName = { family: 'Inter', style: 'Regular' }; }
  t.characters = tx.characters;
  t.fontSize = tx.fontSize || 16;
  try {
    if (tx.lineHeight && tx.lineHeight > 0) t.lineHeight = { unit: 'PIXELS', value: tx.lineHeight };
    else t.lineHeight = { unit: 'AUTO' };
  } catch (e) { /* 忽略 */ }
  if (tx.letterSpacing) {
    try { t.letterSpacing = { unit: 'PIXELS', value: tx.letterSpacing }; } catch (e) { /* 忽略 */ }
  }
  if (tx.align && tx.align !== 'LEFT') {
    try { t.textAlignHorizontal = tx.align; } catch (e) { /* 忽略 */ }
  }
  if (tx.textCase && tx.textCase !== 'ORIGINAL') {
    try { t.textCase = tx.textCase; } catch (e) { /* 忽略 */ }
  }
  if (tx.decoration && tx.decoration !== 'NONE') {
    try { t.textDecoration = tx.decoration; } catch (e) { /* 忽略 */ }
  }
  if (rec.effects && rec.effects.length) {
    try { t.effects = rec.effects; } catch (e) { /* 忽略 */ }
  }
  t.fills = (rec.fills && rec.fills.length) ? resolvePaints(rec.fills) : [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
  t.name = String(tx.characters || 'text').replace(/\s+/g, ' ').trim().slice(0, 48) || 'text';
  if (rec.opacity != null && rec.opacity < 1) {
    try { t.opacity = clamp(rec.opacity, 0, 1); } catch (e) { /* 忽略 */ }
  }
  if (tx.autosize === 'H') {
    t.textAutoResize = 'HEIGHT';
    t.resize(Math.max(rec.w, 1), t.height);
  } else if (tx.autosize === 'N') {
    t.textAutoResize = 'NONE';
    t.resize(Math.max(rec.w, 1), Math.max(rec.h, 1));
    if (tx.valign && tx.valign !== 'TOP') {
      try { t.textAlignVertical = tx.valign; } catch (e) { /* 忽略 */ }
    }
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  return t;
}

/* --------------------------------------------------------------- 构建图层 */

function countNodes(rec) {
  let n = 1;
  if (rec && rec.children) for (const c of rec.children) n += countNodes(c);
  return n;
}

async function buildNode(rec, parent, parentAbs, ctx) {
  if (S.cancel) return null;
  if (!rec) return null;
  ctx.count++;
  if (ctx.count > S.maxNodes) { ctx.truncated = true; return null; }
  if (ctx.count % 150 === 0) {
    figma.ui.postMessage({ type: 'progress', phase: '生成图层', done: ctx.count, total: ctx.total });
    await tick();
  }

  const abs = { x: parentAbs.x + rec.x, y: parentAbs.y + rec.y };
  const w = Math.max(rec.w, 0.01);
  const h = Math.max(rec.h, 0.01);
  let node = null;
  let host = null;   // 承载 fills/strokes 的外层节点（SVG 需要）

  if (rec.t === 'text') {
    node = makeTextNode(rec);
  } else if (rec.t === 'svg' && rec.svg) {
    const needsHost = (rec.fills && rec.fills.length) || (rec.strokes && rec.strokes.length) || (rec.radius && rec.radius.some((v) => v > 0));
    try {
      const svgNode = figma.createNodeFromSvg(rec.svg);
      try { svgNode.resize(w, h); } catch (e) { /* 保持 SVG 原始尺寸 */ }
      svgNode.name = rec.name || 'svg';
      if (needsHost) {
        host = figma.createFrame();
        host.name = rec.name || 'svg-box';
        host.resize(w, h);
        host.clipsContent = false;
        host.appendChild(svgNode);
        svgNode.x = 0;
        svgNode.y = 0;
        node = host;
      } else {
        node = svgNode;
      }
    } catch (e) {
      S.warnings.push('SVG 解析失败，已用占位矩形：' + (rec.name || ''));
      node = figma.createRectangle();
      node.resize(w, h);
      node.name = rec.name || 'svg';
      /* 改成矩形记录，后续 applyVisuals 才会把填充/圆角/阴影套上去 */
      rec.t = 'rect';
      rec.svg = null;
      rec.fills = [PLACEHOLDER_FILL];
    }
  } else if (rec.children && rec.children.length) {
    const f = figma.createFrame();
    f.name = rec.name || 'div';
    f.resize(w, h);
    f.clipsContent = !!rec.clips;
    node = f;
  } else {
    const r = figma.createRectangle();
    r.name = rec.name || 'rect';
    r.resize(w, h);
    node = r;
  }

  if (!node) return null;

  parent.appendChild(node);

  /* 位置：相对父节点（快照坐标已经是相对父节点，但文字需要按对齐方式微调） */
  node.x = rec.x;
  node.y = rec.y;

  if (rec.t === 'text' && rec.text.autosize === 'W') {
    const align = rec.text.align;
    if (align === 'CENTER') node.x = rec.x + (rec.w - node.width) / 2;
    else if (align === 'RIGHT') node.x = rec.x + (rec.w - node.width);
  }

  /* 只给自己的节点套用视觉属性（SVG 外层 host 用同一份记录） */
  if (rec.t !== 'svg' || host) applyVisuals(node, rec);
  else if (rec.opacity != null && rec.opacity < 1) node.opacity = clamp(rec.opacity, 0, 1);

  /* 子节点 */
  if (rec.children && rec.children.length && (node.type === 'FRAME')) {
    for (const child of rec.children) await buildNode(child, node, abs, ctx);
  }

  /* 旋转：Figma 的 rotation 为逆时针且绕中心，用包围盒回读校正位置 */
  if (rec.rotation) {
    try {
      node.rotation = rec.rotation;
      const bb = node.absoluteBoundingBox;
      if (bb) {
        const dx = abs.x - bb.x;
        const dy = abs.y - bb.y;
        if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
          node.x = node.x + dx;
          node.y = node.y + dy;
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  return node;
}

/* ------------------------------------------------------------------ 入口 */

function walkRecords(rec, fn) {
  if (!rec) return;
  fn(rec);
  if (rec.children) for (const c of rec.children) walkRecords(c, fn);
}

/* 在画板里找到覆盖 rect 中心、且面积最小的节点（最贴近触发元素的那一层） */
function findNodeAt(frame, rect) {
  if (!frame || !rect || !frame.findAll) return null;
  /* 交互 rect 是「页面内坐标」，而 absoluteBoundingBox 是画布坐标 ——
     必须先加上顶层画板的绝对原点，否则永远命中不到任何节点 */
  const base = frame.absoluteBoundingBox || { x: 0, y: 0 };
  const cx = base.x + rect.x + rect.w / 2;
  const cy = base.y + rect.y + rect.h / 2;
  let best = null;
  let bestArea = Infinity;
  let list = [];
  try { list = frame.findAll(() => true); } catch (e) { return null; }
  for (const n of list) {
    let bb = null;
    try { bb = n.absoluteBoundingBox; } catch (e) { bb = null; }
    if (!bb) continue;
    if (cx < bb.x || cx > bb.x + bb.width || cy < bb.y || cy > bb.y + bb.height) continue;
    const area = bb.width * bb.height;
    if (area < bestArea) { best = n; bestArea = area; }
  }
  if (best) return best;

  /* 中心点没落在任何节点上（inline 链接跨行、元素被裁剪时很常见）：
     退一步找与 rect 重叠面积最大的节点，别再白白丢掉一条连线 */
  const rx1 = base.x + rect.x;
  const ry1 = base.y + rect.y;
  const rx2 = rx1 + (rect.w || 0);
  const ry2 = ry1 + (rect.h || 0);
  let bestOverlap = 0;
  for (const n of list) {
    if (n === frame) continue;
    let bb = null;
    try { bb = n.absoluteBoundingBox; } catch (e) { bb = null; }
    if (!bb) continue;
    const ox = Math.max(0, Math.min(rx2, bb.x + bb.width) - Math.max(rx1, bb.x));
    const oy = Math.max(0, Math.min(ry2, bb.y + bb.height) - Math.max(ry1, bb.y));
    const ov = ox * oy;
    if (ov > bestOverlap) { bestOverlap = ov; best = n; }
  }
  /* 阈值：重叠面积不到 rect 的一小部分就放弃。
     宁可这条连线不建，也不能把反应写到「恰好重叠一点点的别的元素」上 ——
     那会让用户点 A 跳到 B。 */
  const area = Math.max(1, (rect.w || 0) * (rect.h || 0));
  if (!best || bestOverlap < Math.max(4, area * 0.2)) return null;
  return best;
}

/* 把快照里的交互表写成 Figma 的 Prototype 连接：点触发元素 → 跳到目标页画板 */
/* 统一收口：绑定连线并把结果汇报给 UI（避免多处重复） */
async function finishInteractions() {
  const r = await applyReactions();
  /* 原型起点：Figma 进入演示时需要一个 flow starting point，
     没有它虽然也能从第一个画板开始，但手动指一下更稳（老版本不支持就跳过）。 */
  try {
    const fps = figma.currentPage.flowStartingPoints;
    if (!fps || !fps.length) {
      /* 每个画板都给一个起点：演示时能从任意视图开始点，
         不必先手动跑回第一页（App 有多个视图时体验差很多）。 */
      const live = (S.frames || []).filter((f) => f && f.removed !== true).slice(0, 12);
      if (live.length) {
        figma.currentPage.flowStartingPoints = live.map((f, i) => ({
          nodeId: f.id,
          name: i === 0 ? '起点' : String(f.name || ('画板 ' + (i + 1))).slice(0, 60),
        }));
        S.startNote = 'set:' + live.length;
      } else {
        S.startNote = 'no-frame';
      }
    } else {
      S.startNote = 'exists:' + fps.length;
    }
  } catch (e) {
    S.startNote = 'err:' + (e && e.message ? e.message : String(e));
  }
  /* 诊断：原型起点的结果（UI 收到未知类型会忽略，不影响使用） */
  try { figma.ui.postMessage({ type: 'start-point', note: S.startNote }); } catch (e) { /* 忽略 */ }
  if (r.bound || r.skipped) {
    S.warnings.push('原型连线：已连接 ' + r.bound + ' 条，跳过 ' + r.skipped
      + ' 条（目标页不在本次整包里，或该图层不支持交互）');
    const whyText = r.why
      ? ['外链 ' + r.why.external, '页内 ' + r.why.inPage, '同页 ' + r.why.samePage,
        '找不到目标页 ' + r.why.noTarget, '找不到元素 ' + r.why.noNode,
        '图层不吃反应 ' + r.why.noReaction].join(' · ')
      : '';
    figma.ui.postMessage({
      type: 'interactions', bound: r.bound, skipped: r.skipped,
      total: (r.why && r.why.total) || 0,
      why: r.why, whyText: whyText,
      pages: Array.from(S.pages.keys()),
    });
  }
  return r;
}

async function applyReactions() {
  let bound = 0;
  let skipped = 0;
  /* 分类计数：用户看到的「跳过 N 条」要能拆开看，不然无从判断是哪一环断了 */
  const why = { total: 0, external: 0, inPage: 0, samePage: 0, noTarget: 0, noNode: 0, noReaction: 0 };
  const jobs = S.pending.slice();
  S.pending = [];
  for (const job of jobs) {
    for (const ix of job.interactions) {
      why.total++;
      const node = findNodeAt(job.frame, ix.rect);
      const target = ix.target != null ? S.pages.get(String(ix.target)) : null;
      /* 目标页不在本次整包里（外链 / 页内弹层 / 单独一页），或没找到触发元素：跳过。
         但「为什么跳过」必须说出来 —— 否则用户只看到「一条线都没连上」，无从下手。 */
      if (!target) {
        skipped++;
        if (ix.action === 'EXTERNAL') why.external++;
        else if (ix.action === 'OPEN_OVERLAY' || ix.action === 'SCROLL' || ix.action === 'BACK'
          || String(ix.target || '').charAt(0) === '#') why.inPage++;
        else why.noTarget++;
        if (S.reactionErrors < 5) {
          S.reactionErrors++;
          S.warnings.push('连线跳过：找不到目标页「' + String(ix.target) + '」。本次整包的页面表是：'
            + Array.from(S.pages.keys()).slice(0, 8).join('、'));
        }
        continue;
      }
      if (target === job.frame) { skipped++; why.samePage++; continue; }
      if (!node) {
        skipped++;
        why.noNode++;
        if (S.reactionErrors < 5) {
          S.reactionErrors++;
          S.warnings.push('连线跳过：在画板「' + (job.frame.name || '') + '」上没找到触发元素（'
            + Math.round(ix.rect && ix.rect.x) + ',' + Math.round(ix.rect && ix.rect.y) + '）');
        }
        continue;
      }
      const overlay = ix.action === 'OPEN_OVERLAY';
      const nav = ix.action === 'BACK' ? 'BACK' : (overlay ? 'OVERLAY' : 'NAVIGATE');
      const reaction = {
        trigger: { type: 'ON_CLICK' },
        actions: [{
          type: 'NODE',
          destinationId: target.id,
          navigation: nav,
          /* 过渡必须写成具体类型：早先这里是 transition: null，
             在真机上反应会落不进去 —— 表现就是「打开演示点了没反应」 */
          transition: { type: 'DISSOLVE', easing: { type: 'EASE_IN_AND_OUT' }, duration: 0.2 },
          preserveScrollPosition: false,
        }],
      };

      /* 触发元素本身 + 它最近的容器，各写一份反应。
         为什么：演示时点击的命中判定取**最上层元素**。只写在小文字层上，
         用户点图标或按钮空白处就落到别的图层 —— 反应不触发。
         App 的底部导航正好是「图标 + 文字」，所以这一步很关键。 */
      const cands = [node];
      let up = node && node.parent;
      let d0 = 0;
      while (up && d0 < 3) {
        if (up !== job.frame && up.type !== 'PAGE'
          && (up.width || 0) >= 24 && (up.height || 0) >= 16) {
          cands.push(up);
          break;
        }
        up = up.parent;
        d0++;
      }

      let placedCount = 0;
      for (const cand of cands) {
        let placed = false;
        let tried = cand;
        let depth = 0;
        while (tried && depth < 5 && !placed) {
          try {
            if (tried.type !== 'PAGE') {
              /* documentAccess: "dynamic-page" 下 reactions 不能直接赋值，
                 必须走 setReactionsAsync / getReactionsAsync；旧环境留回退。 */
              let list = [];
              if (typeof tried.getReactionsAsync === 'function') {
                try { list = await tried.getReactionsAsync(); } catch (e) { list = []; }
              }
              if (!Array.isArray(list)) list = [];
              list = list.slice();

              /* 已经有指向同一目标的反应就不再写：重复会让一次点击连跳多次。
                 （提取阶段去过重了，这里是兜底 —— 比如同一条交互落到元素和容器两个节点上时。） */
              const dup = list.some((x) => {
                const a0 = x && x.actions && x.actions[0];
                return !!a0 && a0.destinationId === destId && a0.navigation === nav;
              });
              if (dup) {
                placed = true;
              } else {
                list.push(reaction);

                if (typeof tried.setReactionsAsync === 'function') {
                  await tried.setReactionsAsync(list);
                  const back = typeof tried.getReactionsAsync === 'function'
                    ? await tried.getReactionsAsync() : null;
                  placed = Array.isArray(back) ? back.length >= list.length : true;
                } else {
                  tried.reactions = list;
                  placed = Array.isArray(tried.reactions) && tried.reactions.length >= list.length;
                }
              }
            }
          } catch (e) {
            placed = false;
          }
          if (!placed) {
            tried = tried.parent;
            depth++;
          }
        }
        if (placed) placedCount++;
      }

      if (placedCount) {
        bound++;
      } else {
        skipped++;
        why.noReaction++;
        if (S.reactionErrors < 5) {
          S.reactionErrors++;
          S.warnings.push('交互未写入（' + ((node && node.type) || '节点') + ' '
            + ((node && node.name) || '') + '）：这个节点及其父级都不接受原型反应');
        }
      }
    }
  }
  return { bound: bound, skipped: skipped, why: why };
}

async function handleRender(payload) {
  S.cancel = false;
  S.warnings = [];
  S.images = new Map();
  S.fontCache = new Map();
  if (!S.frames) S.frames = [];
  if (S.reactionErrors == null) S.reactionErrors = 0;
  S.maxNodes = payload.meta.maxNodes || 20000;

  figma.ui.postMessage({ type: 'progress', phase: '读取字体列表', done: 0, total: 1 });
  await ensureFontDB();

  /* 1) 收集并预加载字体 */
  const textRecs = [];
  walkRecords(payload.root, (r) => { if (r.t === 'text' && r.text) textRecs.push(r); });
  const fontSet = new Map();
  for (const r of textRecs) {
    const f = resolveFont(r.text);
    fontSet.set(f.family + '|' + f.style, f);
  }
  let fi = 0;
  for (const f of fontSet.values()) {
    if (S.cancel) throw new Error('已取消');
    await ensureFont(f);
    fi++;
    if (fi % 4 === 0) {
      figma.ui.postMessage({ type: 'progress', phase: '加载字体', done: fi, total: fontSet.size });
      await tick();
    }
  }

  /* 2) 预加载图片 */
  if (payload.images && payload.images.length) {
    figma.ui.postMessage({ type: 'progress', phase: '下载图片', done: 0, total: payload.images.length });
    await loadImages(payload.images);
  }

  /* 3) 生成图层 */
  const pkg = payload.package || null;
  const root = figma.createFrame();
  const baseName = pkg
    ? ((pkg.index + 1) + '. ' + (pkg.name || 'page') + '   ' + Math.round(payload.meta.w) + '×' + Math.round(payload.meta.h))
    : (payload.meta.title || 'HTML 快照');
  /* 垫了白色衬底的画板，把衬底名缀在后面：页码/页面名照旧可见，图层里也能认出这是衬底稿 */
  root.name = (payload.root && payload.root._backdrop && payload.root.name)
    ? (baseName + ' · ' + payload.root.name)
    : baseName;
  root.resize(Math.max(payload.meta.w, 1), Math.max(payload.meta.h, 1));
  if (!S.frames) S.frames = [];
  S.frames.push(root);
  root.clipsContent = payload.meta.clips !== false;
  root.fills = payload.meta.rootFill ? resolvePaints([payload.meta.rootFill]) : [];
  figma.currentPage.appendChild(root);

  const vp = figma.viewport;
  if (pkg) {
    /* 整包模式：所有页面并排铺开，页间留出原型连线的走线间距 */
    if (!S.pkgRun || S.pkgRun.id !== pkg.id) {
      S.pkgRun = {
        id: pkg.id,
        y: Math.round(vp.center.y - root.height / 2),
        nextX: Math.round(vp.center.x - root.width / 2),
        gap: pkg.gap || 160,
      };
      S.pages.clear();
      S.pending = [];
    }
    root.x = Math.round(S.pkgRun.nextX);
    root.y = Math.round(S.pkgRun.y);
    S.pkgRun.nextX = root.x + root.width + S.pkgRun.gap;
    S.pages.set(String(pkg.name || ''), root);
  } else {
    root.x = Math.round(vp.center.x - root.width / 2);
    root.y = Math.round(vp.center.y - root.height / 2);
    /* 单页复刻与上一批整包无关：不清掉的话，这一页的跳转会连到
       上一次整包遗留的画板上（看起来「连上了」，其实是错的） */
    S.pages.clear();
    S.pkgRun = null;
  }

  const ctx = { count: 0, total: countNodes(payload.root), truncated: false };
  figma.ui.postMessage({ type: 'progress', phase: '生成图层', done: 0, total: ctx.total });

  const children = payload.root.children || [];
  for (const child of children) {
    if (S.cancel) break;
    /* 初始绝对原点要带上画板自身位置，旋转校正依赖真实场景坐标 */
    await buildNode(child, root, { x: root.x, y: root.y }, ctx);
  }

  figma.currentPage.selection = [root];
  try { figma.viewport.scrollAndZoomIntoView([root]); } catch (e) { /* 忽略 */ }

  /* 4) 交互 → Prototype 连线
     跨页跳转要等目标页画板也建出来：整包由 UI 在全部画板发完后发 package-end 统一绑定
     （也支持在 payload.package 上直接标 last / total 的旧写法） */
  let ixResult = { bound: 0, skipped: 0 };
  if (payload.interactions && payload.interactions.length) {
    S.pending.push({ frame: root, name: (pkg && pkg.name) || '', interactions: payload.interactions });
  }
  if (!pkg || pkg.last || (pkg.total > 0 && pkg.index >= pkg.total - 1)) {
    ixResult = await finishInteractions();
  }

  const stats = {
    nodes: ctx.count,
    texts: textRecs.length,
    images: (payload.images || []).length,
    fonts: fontSet.size,
    warnings: S.warnings.length,
    cancelled: S.cancel,
    truncated: ctx.truncated,
    reactions: ixResult.bound,
    reactionsSkipped: ixResult.skipped,
  };
  if (ctx.truncated) S.warnings.push('图层数超过上限 ' + S.maxNodes + '，已截断。可调高「最大图层数」后重试。');

  figma.notify(S.cancel ? '已取消' : ('复刻完成：' + ctx.count + ' 个图层'), { timeout: 2500 });
  figma.ui.postMessage({ type: 'done', stats: stats, warnings: S.warnings.slice(0, 200) });
}

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'render') {
    try {
      await handleRender(msg.payload);
    } catch (e) {
      const message = (e && e.message) || String(e);
      figma.ui.postMessage({ type: 'error', message: message });
      figma.notify('复刻失败：' + message, { error: true });
    }
    return;
  }

  if (msg.type === 'package-end') {
    /* 整包（含 :hover 状态稿）全部画板发完后，统一建立跨画板的原型连线 */
    await finishInteractions();
    return;
  }

  if (msg.type === 'cancel') {
    S.cancel = true;
    figma.notify('正在取消…', { timeout: 1200 });
    return;
  }

  if (msg.type === 'image-bytes') {
    const resolve = S.pendingImages.get(msg.ref);
    if (!resolve) return;
    S.pendingImages.delete(msg.ref);
    let hash = null;
    if (msg.base64) {
      const im = createImageFromBase64(msg.base64);
      hash = im ? im.hash : null;
    }
    resolve(hash);
    return;
  }

  if (msg.type === 'notify') {
    figma.notify(String(msg.message || ''), { timeout: 1600 });
  }
};

figma.showUI(__html__, { width: 520, height: 780, themeColors: true, title: 'HTML → Figma 1:1 复刻' });
