/* ============================================================================
 * core/engine.js — 排版测量与快照捕获引擎（插件与网页版共用）
 *
 * 在真实浏览器里排版，然后「测量而不是猜」：读 getBoundingClientRect() 与
 * getComputedStyle()，把整棵 DOM 记录成一份与 Figma 无关的快照（payload）。
 * 两个出口都消费同一份快照：
 *   - plugin/code.js   快照 → Figma 原生图层（FRAME / RECT / TEXT）
 *   - core/svg.js      快照 → SVG（供 Figma 网页版粘贴）
 *
 * 本文件不依赖 Figma API，只依赖一个沙箱 iframe（#stage）与浏览器测量能力。
 * 由原 ui.js 拆分而来：engine（捕获）与本文件同一目录的 session.js（输入/流程/界面）。
 * ========================================================================== */
/* ============================== 通用工具 ================================= */

const $ = (id) => document.getElementById(id);

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 按顶层分隔符切分（忽略括号内部），CSS 值解析必备 */
function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

const SKIP_TAGS = {
  SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, BASE: 1, TEMPLATE: 1,
  NOSCRIPT: 1, BR: 1, SOURCE: 1, TRACK: 1, PARAM: 1, COL: 1, COLGROUP: 1,
  MAP: 1, AREA: 1, DATALIST: 1,
};

const HOIST_TAGS = { PICTURE: 1, SLOT: 1 };

function describe(el) {
  let s = el.tagName ? el.tagName.toLowerCase() : 'node';
  if (el.id) s += '#' + el.id;
  else if (el.classList && el.classList.length) s += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
  return s;
}

/* ============================== 颜色解析 ================================= */

const COLOR_CANVAS = document.createElement('canvas');
COLOR_CANVAS.width = 1;
COLOR_CANVAS.height = 1;
const COLOR_CTX = COLOR_CANVAS.getContext('2d', { willReadFrequently: true });

function pctOrNum(tok) {
  const t = String(tok).trim();
  if (t === 'none') return 0;
  if (t.indexOf('%') >= 0) return parseFloat(t) * 255 / 100;
  return parseFloat(t);
}

/** 解析任意 CSS 颜色为 {r,g,b,a}（0~1）；解析不了返回 null */
function parseColor(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s || s === 'none') return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter((x) => x.length > 0);
    if (parts.length >= 3) {
      const r = pctOrNum(parts[0]);
      const g = pctOrNum(parts[1]);
      const b = pctOrNum(parts[2]);
      let a = 1;
      if (parts.length > 3) a = parts[3].indexOf('%') >= 0 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (!isFinite(a)) a = 1;
      return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a: clamp01(a) };
    }
  }

  /* 兜底：交给浏览器解析，可覆盖 oklch()/lab()/color()/命名色 等一切写法 */
  try {
    COLOR_CTX.clearRect(0, 0, 1, 1);
    COLOR_CTX.fillStyle = 'rgba(0,0,0,0)';
    COLOR_CTX.fillStyle = s;
    COLOR_CTX.fillRect(0, 0, 1, 1);
    const d = COLOR_CTX.getImageData(0, 0, 1, 1).data;
    return { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
  } catch (e) {
    return null;
  }
}

function sameColor(a, b, eps) {
  if (!a || !b) return a === b;
  const e = eps == null ? 0.004 : eps;
  return Math.abs(a.r - b.r) < e && Math.abs(a.g - b.g) < e && Math.abs(a.b - b.b) < e && Math.abs(a.a - b.a) < e;
}

/* ============================== 渐变解析 ================================= */

function parseAngleTok(tok) {
  const t = String(tok).trim().toLowerCase();
  if (/^-?[\d.]+deg$/.test(t)) return parseFloat(t);
  if (/^-?[\d.]+rad$/.test(t)) return parseFloat(t) * 180 / Math.PI;
  if (/^-?[\d.]+turn$/.test(t)) return parseFloat(t) * 360;
  if (/^-?[\d.]+grad$/.test(t)) return parseFloat(t) * 0.9;
  return null;
}

function posToken(tok, base) {
  const t = String(tok).trim();
  if (!t) return null;
  if (t.indexOf('%') >= 0) return parseFloat(t) / 100;
  if (/^-?[\d.]+px$/.test(t)) return parseFloat(t) / (base || 1);
  const n = parseFloat(t);
  return isFinite(n) ? n / (base || 1) : null;
}

/* 渐变中心点关键字（left/center/right/top/bottom）折算为 0~1 */
function posFraction(tok, base) {
  const t = String(tok == null ? '' : tok).trim().toLowerCase();
  if (!t) return 0.5;
  if (t === 'center') return 0.5;
  if (t === 'left' || t === 'top') return 0;
  if (t === 'right' || t === 'bottom') return 1;
  if (t.indexOf('%') >= 0) return parseFloat(t) / 100;
  if (/^-?[\d.]+px$/.test(t)) return base ? parseFloat(t) / base : 0.5;
  const n = parseFloat(t);
  return isFinite(n) ? (base ? n / base : 0.5) : 0.5;
}

/** 解析颜色 + 1~2 个位置，返回 {color, positions:[]} */
function parseStop(part, currentColor) {
  let text = String(part).trim();
  if (!text) return null;
  const positions = [];
  const m = /(?:\s|^)(-?[\d.]+(?:px|%|))(?:[\s]+(-?[\d.]+(?:px|%|)))?\s*$/.exec(text);
  if (m) {
    positions.push(m[1]);
    if (m[2]) positions.push(m[2]);
    text = text.slice(0, m.index).trim();
  }
  const color = parseColor(text === 'currentcolor' ? currentColor : text);
  if (!color) return null;
  return { color: color, positions: positions };
}

/** 按 CSS 规范补齐缺省位置 */
function fillStopPositions(stops, base) {
  const n = stops.length;
  if (!n) return stops;
  const vals = stops.map((s) => (s.positions.length ? posToken(s.positions[0], base) : null));
  if (vals[0] == null) vals[0] = 0;
  if (vals[n - 1] == null) vals[n - 1] = 1;
  let i = 0;
  while (i < n) {
    if (vals[i] != null) { i++; continue; }
    let j = i;
    while (j < n && vals[j] == null) j++;
    const prev = vals[i - 1];
    const next = vals[j];
    const steps = j - i + 1;
    for (let k = i; k < j; k++) vals[k] = prev + (next - prev) * (k - i + 1) / steps;
    i = j;
  }
  for (let k = 1; k < n; k++) if (vals[k] < vals[k - 1]) vals[k] = vals[k - 1];
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ position: clamp01(vals[k]), color: { r: stops[k].color.r, g: stops[k].color.g, b: stops[k].color.b, a: stops[k].color.a } });
    if (stops[k].positions.length > 1) {
      const p2 = posToken(stops[k].positions[1], base);
      if (p2 != null) out.push({ position: clamp01(p2), color: { r: stops[k].color.r, g: stops[k].color.g, b: stops[k].color.b, a: stops[k].color.a } });
    }
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

function expandRepeating(stops) {
  if (stops.length < 2) return stops;
  const first = stops[0].position;
  const last = stops[stops.length - 1].position;
  const period = last - first;
  if (!(period > 0.0001)) return stops;
  const out = [];
  const startK = Math.floor((0 - last) / period) - 1;
  const endK = Math.ceil((1 - first) / period) + 1;
  for (let k = startK; k <= endK; k++) {
    for (const s of stops) {
      const p = s.position + k * period;
      if (p >= -0.001 && p <= 1.001) out.push({ position: clamp01(p), color: s.color });
    }
  }
  out.sort((a, b) => a.position - b.position);
  return out.length >= 2 ? out : stops;
}

/* CSS 角度(0=上, 顺时针) -> Figma 线性渐变 transform（作用于单位正方形） */
function linearTransform(angleDeg, w, h) {
  const rad = angleDeg * Math.PI / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const L = Math.abs(w * ux) + Math.abs(h * uy);
  if (!(L > 0)) return [[1, 0, 0], [0, 1, 0]];
  const px = w / 2 - ux * L / 2;
  const py = h / 2 - uy * L / 2;
  const e = (-px * ux - py * uy) / L;
  const f = (px * uy - py * ux) / L;
  return [
    [(w * ux) / L, (h * uy) / L, e],
    [(-w * uy) / L, (h * ux) / L, f],
  ];
}

/* 径向渐变：把「中心 + 半径」折算成 Figma 的 transform */
function radialTransform(cx, cy, rx, ry) {
  const sx = rx > 0 ? 1 / (2 * rx) : 1;
  const sy = ry > 0 ? 1 / (2 * ry) : 1;
  return [
    [sx, 0, 0.5 - cx * sx],
    [0, sy, 0.5 - cy * sy],
  ];
}

function cornerAngle(w, h, vert, horiz) {
  let dx = 0;
  let dy = 0;
  if (horiz === 'right') dx = 1;
  else if (horiz === 'left') dx = -1;
  if (vert === 'bottom') dy = 1;
  else if (vert === 'top') dy = -1;
  if (!dx && !dy) return null;
  if (!dx) return dy > 0 ? 180 : 0;
  if (!dy) return dx > 0 ? 90 : 270;
  let vx = -dy * h;
  let vy = dx * w;
  if (vx * dx + vy * dy < 0) { vx = -vx; vy = -vy; }
  return Math.atan2(vx, -vy) * 180 / Math.PI;
}

/** 解析一个渐变函数，返回 Figma Paint（解析失败返回 null） */
function parseGradient(fn, w, h, currentColor) {
  const m = /^(-[a-z]+-)?(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/is.exec(fn.trim());
  if (!m) return null;
  const repeating = !!m[2];
  const kind = m[3];
  const body = m[4];
  const parts = splitTop(body, ',');
  if (parts.length < 2) return null;

  if (kind === 'conic') return null; /* Figma 无锥形渐变，交由调用方兜底 */

  let head = parts[0];
  let stopsRaw = parts.slice(1);
  let angle = 180;
  let isAngleHead = false;

  const angleVal = parseAngleTok(head);
  if (angleVal != null) { angle = angleVal; isAngleHead = true; }
  else if (/^to\s+/i.test(head)) {
    const toks = head.replace(/^to\s+/i, '').trim().split(/\s+/);
    let vert = null;
    let horiz = null;
    for (const t of toks) {
      if (t === 'top' || t === 'bottom') vert = t;
      else if (t === 'left' || t === 'right') horiz = t;
    }
    const a = cornerAngle(w, h, vert, horiz);
    angle = a == null ? 180 : a;
    isAngleHead = true;
  }

  if (kind === 'linear') {
    if (!isAngleHead) stopsRaw = parts; /* 没有方向参数，第一段就是色标 */
    let stops = [];
    for (const s of stopsRaw) {
      const p = parseStop(s, currentColor);
      if (p) stops.push(p);
    }
    if (stops.length < 2) return null;
    const L = Math.abs(w * Math.sin(angle * Math.PI / 180)) + Math.abs(h * Math.cos(angle * Math.PI / 180));
    let gs = fillStopPositions(stops, L);
    if (repeating) gs = expandRepeating(gs);
    if (gs.length < 2) return null;
    return { type: 'GRADIENT_LINEAR', gradientTransform: linearTransform(angle, w, h), gradientStops: gs };
  }

  /* radial */
  let shape = 'ellipse';
  let sizeSpec = null;
  let pos = { x: 0.5, y: 0.5 };
  let explicit = null;

  /* 首次参数其实是色标（如 radial-gradient(red, blue)）时单独处理 */
  if (!/\bat\s|circle|ellipse|closest-|farthest-|^-?[\d.]+(px|%)/i.test(head)) {
    stopsRaw = parts;
    head = '';
  }

  const sizeAt = head.split(/\s+at\s+/i);
  const shapePart = (sizeAt[0] || '').trim();
  if (sizeAt[1]) {
    const ptoks = sizeAt[1].trim().split(/\s+/);
    let px = 'center';
    let py = 'center';
    if (ptoks.length === 1) {
      if (/^(top|bottom)$/i.test(ptoks[0])) { py = ptoks[0]; px = 'center'; }
      else { px = ptoks[0]; py = 'center'; }
    } else {
      px = ptoks[0];
      py = ptoks[1];
    }
    pos = { x: posFraction(px, w), y: posFraction(py, h) };
  }
  if (shapePart) {
    const stoks = shapePart.split(/\s+/).filter((t) => t.length);
    const radii = [];
    for (const t of stoks) {
      if (t === 'circle' || t === 'ellipse') shape = t;
      else if (t === 'closest-side' || t === 'farthest-side' || t === 'closest-corner' || t === 'farthest-corner') sizeSpec = t;
      else if (/^-?[\d.]+(px|%)$/.test(t)) radii.push(t);
    }
    if (radii.length) explicit = radii;
    if (radii.length && shape === 'ellipse' && radii.length === 1) explicit = [radii[0], radii[0]];
  }

  const cx = pos.x * w;
  const cy = pos.y * h;
  let rx = 0;
  let ry = 0;
  if (explicit && explicit.length) {
    if (explicit[0].indexOf('%') >= 0) {
      rx = parseFloat(explicit[0]) / 100 * w;
      ry = explicit[1] ? parseFloat(explicit[1]) / 100 * h : rx * h / (w || 1);
    } else {
      rx = num(explicit[0], 0);
      ry = explicit[1] ? num(explicit[1], 0) : (shape === 'circle' ? rx : rx * h / (w || 1));
    }
  } else {
    const spec = sizeSpec || 'farthest-corner';
    const dLeft = cx;
    const dRight = w - cx;
    const dTop = cy;
    const dBottom = h - cy;
    if (spec === 'closest-side') {
      if (shape === 'circle') rx = ry = Math.min(dLeft, dRight, dTop, dBottom);
      else { rx = Math.min(dLeft, dRight); ry = Math.min(dTop, dBottom); }
    } else if (spec === 'farthest-side') {
      if (shape === 'circle') rx = ry = Math.max(dLeft, dRight, dTop, dBottom);
      else { rx = Math.max(dLeft, dRight); ry = Math.max(dTop, dBottom); }
    } else {
      const corners = [[0, 0], [w, 0], [0, h], [w, h]];
      const aspect = h > 0 ? w / h : 1;
      let best = spec === 'closest-corner' ? Infinity : 0;
      for (const c of corners) {
        const dx = Math.abs(c[0] - cx);
        const dy = Math.abs(c[1] - cy);
        /* circle 用真实的欧氏距离，ellipse 才按盒子宽高比缩放 */
        const a = shape === 'circle'
          ? Math.sqrt(dx * dx + dy * dy)
          : Math.sqrt(dx * dx + (dy * aspect) * (dy * aspect));
        best = spec === 'closest-corner' ? Math.min(best, a) : Math.max(best, a);
      }
      if (!isFinite(best) || best <= 0) best = Math.max(w, h) / 2;
      if (shape === 'circle') {
        rx = ry = best;
      } else {
        rx = best;
        ry = aspect > 0 ? best / aspect : best;
      }
    }
  }
  if (!(rx > 0) || !(ry > 0)) return null;

  let stops = [];
  for (const s of stopsRaw) {
    const p = parseStop(s, currentColor);
    if (p) stops.push(p);
  }
  if (stops.length < 2) return null;
  let gs = fillStopPositions(stops, rx);
  if (repeating) gs = expandRepeating(gs);
  if (gs.length < 2) return null;
  return {
    type: 'GRADIENT_RADIAL',
    gradientTransform: radialTransform(pos.x, pos.y, rx / (w || 1), ry / (h || 1)),
    gradientStops: gs,
  };
}

/* ============================== 阴影 / 滤镜 ============================== */

function parseShadowList(value, scale) {
  const effects = [];
  if (!value || value === 'none') return effects;
  const items = splitTop(value, ',');
  for (const item of items) {
    let s = item;
    const inset = /(^|\s)inset(\s|$)/.test(s);
    if (inset) s = s.replace(/(^|\s)inset(\s|$)/, ' ');
    const tokens = splitTop(s, ' ');
    const lens = [];
    let color = null;
    for (const tk of tokens) {
      if (/^-?[\d.]+(px)?$/.test(tk)) { lens.push(parseFloat(tk)); continue; }
      const c = parseColor(tk);
      if (c) color = c;
    }
    if (!lens.length) continue;
    const col = color || { r: 0, g: 0, b: 0, a: 0.25 };
    effects.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: col.r, g: col.g, b: col.b, a: col.a },
      offset: { x: lens[0] || 0, y: lens[1] || 0 },
      radius: Math.max(0, (lens[2] || 0) * scale),
      spread: lens[3] || 0,
      visible: true,
      blendMode: 'NORMAL',
    });
  }
  return effects;
}

function parseFilterEffects(cs, scale, ctx) {
  const out = [];
  const f = cs.filter;
  if (f && f !== 'none') {
    const bm = /blur\(([\d.]+)px\)/.exec(f);
    if (bm) out.push({ type: 'LAYER_BLUR', radius: Math.max(0, parseFloat(bm[1]) * scale), visible: true });
    const ds = /drop-shadow\(([^)]*)\)/.exec(f);
    if (ds) {
      const inner = parseShadowList(ds[1], scale);
      for (const e of inner) { e.type = 'DROP_SHADOW'; out.push(e); }
    }
    if (/hue-rotate|saturate|contrast|brightness|invert|sepia|grayscale/.test(f) && ctx) {
      ctx.warn('filter 中的颜色类滤镜（如 grayscale/saturate）暂不支持：' + describe(cs.__el || { tagName: 'element' }));
    }
  }
  const bf = cs.backdropFilter || cs.webkitBackdropFilter;
  if (bf && bf !== 'none') {
    const bm = /blur\(([\d.]+)px\)/.exec(bf);
    if (bm) out.push({ type: 'BACKGROUND_BLUR', radius: Math.max(0, parseFloat(bm[1]) * scale), visible: true });
  }
  return out;
}

/* ============================== 文本属性 ================================= */

const CJK_RE = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

function parseFamilies(list) {
  if (!list) return ['Inter'];
  const out = [];
  for (let part of splitTop(list, ',')) {
    part = part.trim().replace(/^["']|["']$/g, '');
    if (part) out.push(part);
  }
  return out.length ? out : ['Inter'];
}

function mapAlign(textAlign, direction) {
  const t = String(textAlign || 'start').toLowerCase();
  if (t === 'center') return 'CENTER';
  if (t === 'justify') return 'JUSTIFIED';
  if (t === 'right' || t === 'end') return 'RIGHT';
  if (t === 'left') return 'LEFT';
  if (t === 'start') return direction === 'rtl' ? 'RIGHT' : 'LEFT';
  return 'LEFT';
}

function mapTextCase(tt) {
  const t = String(tt || 'none').toLowerCase();
  if (t === 'uppercase') return 'UPPER';
  if (t === 'lowercase') return 'LOWER';
  if (t === 'capitalize') return 'TITLE';
  return 'ORIGINAL';
}

function mapDecoration(dl) {
  const t = String(dl || 'none').toLowerCase();
  if (t.indexOf('underline') >= 0) return 'UNDERLINE';
  if (t.indexOf('line-through') >= 0) return 'STRIKETHROUGH';
  return 'NONE';
}

function textStyleOf(cs, text) {
  const fontSize = num(cs.fontSize, 16);
  let lineHeight = null;
  const lh = cs.lineHeight;
  if (lh && lh !== 'normal') {
    const v = parseFloat(lh);
    if (isFinite(v) && v > 0) lineHeight = v;
  }
  let letterSpacing = 0;
  const ls = cs.letterSpacing;
  if (ls && ls !== 'normal') letterSpacing = num(ls, 0);
  const fams = parseFamilies(cs.fontFamily);
  const bold = num(cs.fontWeight, 400);
  return {
    families: fams,
    weight: isFinite(bold) ? bold : (/bold/i.test(cs.fontWeight) ? 700 : 400),
    italic: /italic|oblique/i.test(cs.fontStyle || ''),
    cjk: CJK_RE.test(text || ''),
    fontSize: fontSize,
    lineHeight: lineHeight,
    letterSpacing: letterSpacing,
    align: mapAlign(cs.textAlign, cs.direction),
    textCase: mapTextCase(cs.textTransform),
    decoration: mapDecoration(cs.textDecorationLine || cs.textDecoration),
  };
}

function textFillOf(cs) {
  const c = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
  if (c.a <= 0.001) return [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0 }];
  return [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
}

/* ============================== 渲染沙箱 ================================= */

const state = {
  stage: null,
  images: new Map(),      // ref -> item
  running: false,
  cancelled: false,
};

function makeStage(allowScripts) {
  const old = $('stage');
  const f = document.createElement('iframe');
  f.id = 'stage';
  f.setAttribute('sandbox', allowScripts ? 'allow-same-origin allow-scripts' : 'allow-same-origin');
  f.style.cssText = 'position:fixed;left:-30000px;top:0;border:0;margin:0;background:#fff;width:1px;height:1px;';
  if (old && old.parentNode) old.parentNode.replaceChild(f, old);
  else document.body.appendChild(f);
  return f;
}

const MEASURE_CSS = [
  '*,*::before,*::after{animation:none !important;transition:none !important;}',
  'html{scrollbar-width:none !important;}',
  'html::-webkit-scrollbar,body::-webkit-scrollbar{width:0 !important;height:0 !important;}',
].join('\n');

function buildDocument(html, opts) {
  let out = String(html || '');
  const inject = [];
  if (opts.baseHref && !/<base\s/i.test(out)) {
    inject.push('<base href="' + String(opts.baseHref).replace(/"/g, '&quot;') + '">');
  }
  if (!/<meta[^>]+charset/i.test(out)) inject.push('<meta charset="utf-8">');
  if (opts.disableAnimation) inject.push('<style>' + MEASURE_CSS + '</style>');
  if (!inject.length) return out;
  const head = inject.join('');
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head([^>]*)>/i, '<head$1>' + head);
  if (/<html[^>]*>/i.test(out)) return out.replace(/<html([^>]*)>/i, '<html$1><head>' + head + '</head>');
  return '<!doctype html><html><head>' + head + '</head><body>' + out + '</body></html>';
}

function waitLoad(frame, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      if (ok) resolve();
      else reject(err || new Error('timeout'));
    };
    frame.addEventListener('load', () => finish(true), { once: true });
    setTimeout(() => finish(false, new Error('渲染沙箱加载超时')), ms || 20000);
  });
}

/** 三级降级：srcdoc -> blob -> 同文档 Shadow DOM */
async function loadStage(html, opts) {
  const errors = [];
  const width = opts.viewportWidth;
  const height = opts.viewportHeight;

  /* 1) srcdoc：最接近真实页面（有 html/body 语义）
     例外：需要跑 SPA 路由时不能走这里 —— about:srcdoc 文档的 URL 就是 about:srcdoc，
     页面里的 history.pushState 会被浏览器直接拒绝（SecurityError），
     所以那种场景强制走下面的 blob: 路径（opts.preferBlobUrl）。 */
  if (!opts.preferBlobUrl) {
    try {
      const f = makeStage(opts.allowScripts);
      f.style.width = width + 'px';
      f.style.height = height + 'px';
      const p = waitLoad(f, 20000);
      f.srcdoc = html;
      await p;
      const doc = f.contentDocument;
      if (doc && doc.body) {
        return { kind: 'iframe', win: f.contentWindow, doc: doc, host: doc.documentElement, contentRoot: doc.body, root: doc.documentElement, scrollX: 0, scrollY: 0, frame: f };
      }
      errors.push('srcdoc 无法访问文档');
    } catch (e) {
      errors.push('srcdoc: ' + e.message);
    }
  }

  /* 2) blob:：文档 URL 是 blob:<origin>/uuid，与页面同源，
     因此 history.pushState / hash 路由在这里能正常工作 */
  try {
    const f = makeStage(opts.allowScripts);
    f.style.width = width + 'px';
    f.style.height = height + 'px';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const p = waitLoad(f, 20000);
    f.src = url;
    await p;
    const doc = f.contentDocument;
    if (doc && doc.body) {
      return { kind: 'iframe', win: f.contentWindow, doc: doc, host: doc.documentElement, contentRoot: doc.body, root: doc.documentElement, scrollX: 0, scrollY: 0, frame: f, blobUrl: url };
    }
    errors.push('blob 无法访问文档');
  } catch (e) {
    errors.push('blob: ' + e.message);
  }

  /* 3) Shadow DOM 兜底：不依赖 iframe，一定能读到样式 */
  try {
    const hostWrap = document.createElement('div');
    hostWrap.style.cssText = 'position:fixed;left:-30000px;top:0;width:' + width + 'px;height:' + height + 'px;overflow:auto;';
    document.body.appendChild(hostWrap);
    const sr = hostWrap.attachShadow({ mode: 'open' });

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const styles = [];
    parsed.querySelectorAll('style').forEach((s) => {
      styles.push('<style>' + s.textContent
        .replace(/:root\b/g, '.h2f-html')
        .replace(/(^|[^\w.#-])html\b/g, '$1.h2f-html')
        .replace(/(^|[^\w.#-])body\b/g, '$1.h2f-body') + '</style>');
    });
    let linkTags = '';
    parsed.querySelectorAll('link[rel~="stylesheet"]').forEach((l) => {
      if (l.getAttribute('href')) linkTags += '<link rel="stylesheet" href="' + l.getAttribute('href') + '">';
    });
    const base = opts.baseHref ? '<base href="' + String(opts.baseHref).replace(/"/g, '&quot;') + '">' : '';
    const bodyHtml = parsed.body ? parsed.body.innerHTML : html;
    /* 重置样式必须排在用户样式之前，否则 .h2f-body 的默认值会盖掉用户的 body{} 规则 */
    const reset = '<style>'
      + (opts.disableAnimation ? MEASURE_CSS : '')
      + ':host{display:block;}'
      + '.h2f-html{display:block;margin:0;padding:0;border:0;font-family:sans-serif;font-size:16px;'
      + 'font-style:normal;font-weight:400;line-height:normal;color:#000;background:#fff;text-align:left;}'
      + '.h2f-body{display:block;}</style>';
    sr.innerHTML = base + reset + linkTags + styles.join('')
      + '<div class="h2f-html"><div class="h2f-body">' + bodyHtml + '</div></div>';
    await delay(150);
    const hostEl = sr.querySelector('.h2f-html');
    const bodyEl = sr.querySelector('.h2f-body');
    if (!hostEl) throw new Error('shadow 容器创建失败');
    return {
      kind: 'shadow',
      win: window,
      doc: document,
      host: hostEl,
      contentRoot: bodyEl,
      root: hostEl,
      scrollX: 0,
      scrollY: 0,
      shadow: true,
      fallbackNote: 'iframe 被环境限制，已使用 Shadow DOM 兜底（html/body 选择器可能不生效）：' + errors.join(' / '),
    };
  } catch (e) {
    errors.push('shadow: ' + e.message);
  }

  throw new Error('无法创建渲染沙箱：' + errors.join(' | '));
}

/** 等资源就绪，保证测量的是稳定后的排版 */
async function settleStage(stage, opts) {
  const imgs = Array.from(stage.root.querySelectorAll('img'));
  const pending = imgs.filter((i) => !i.complete);
  if (pending.length) {
    await Promise.race([
      Promise.all(pending.map((i) => new Promise((res) => {
        i.addEventListener('load', res, { once: true });
        i.addEventListener('error', res, { once: true });
        setTimeout(res, 8000);
      }))),
      delay(opts.assetTimeout),
    ]);
  }
  try {
    const fonts = stage.doc.fonts;
    if (fonts && fonts.ready) await Promise.race([fonts.ready, delay(4000)]);
  } catch (e) { /* 忽略 */ }
  await delay(150);
}

/* ============================== 快照捕获 ================================= */

function createCtx(stage, opts) {
  const warnings = [];
  const seenWarn = new Set();
  const ctx = {
    win: stage.win,
    doc: stage.doc,
    opts: opts,
    scrollX: stage.scrollX || 0,
    scrollY: stage.scrollY || 0,
    images: new Map(),
    imageList: [],
    imageByRef: new Map(),
    stats: { elements: 0, texts: 0, images: 0, skipped: 0, pseudo: 0 },
    warn(msg) {
      if (seenWarn.has(msg) || warnings.length > 300) return;
      seenWarn.add(msg);
      warnings.push(msg);
    },
    warnings: warnings,
  };
  return ctx;
}

function absBox(el, ctx) {
  const r = el.getBoundingClientRect();

  /* position:fixed 的元素 rect 是视口坐标，这里**保持原样**：
     实测浏览器整页截图也是这个行为（底栏停在视口底 736，不是文档底 814）。
     「完美复刻」= 与浏览器一致 —— 所以不要自作聪明去偏移它。
     App / 手机页想要「底栏就在底部」，请用画板范围「一屏」。 */
  return {
    x: r.left + ctx.scrollX,
    y: r.top + ctx.scrollY,
    w: r.width,
    h: r.height,
    right: r.right + ctx.scrollX,
    bottom: r.bottom + ctx.scrollY,
  };
}

function clientBox(r, ctx) {
  return {
    x: r.left + ctx.scrollX,
    y: r.top + ctx.scrollY,
    w: r.width,
    h: r.height,
    right: r.right + ctx.scrollX,
    bottom: r.bottom + ctx.scrollY,
  };
}

function registerImage(url, ctx, extra) {
  if (!url) return null;
  let item = ctx.images.get(url);
  if (!item) {
    item = {
      ref: 'img' + (ctx.imageList.length + 1),
      url: url,
      dataUrl: (extra && extra.dataUrl) || null,
      isData: !!(extra && extra.dataUrl) || /^data:/i.test(url),
    };
    ctx.images.set(url, item);
    ctx.imageList.push({ ref: item.ref, url: item.url.indexOf('data:') === 0 ? '(内联 dataURL)' : item.url, data: item.isData });
    ctx.imageByRef.set(item.ref, item);
    state.images.set(item.ref, item);
    ctx.stats.images++;
  }
  return item.ref;
}

function rasterize(el, ctx, tag) {
  try {
    const vw = el.videoWidth || el.width || el.clientWidth;
    const vh = el.videoHeight || el.height || el.clientHeight;
    if (!vw || !vh) return null;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(vw));
    cv.height = Math.max(1, Math.round(vh));
    const c2 = cv.getContext('2d');
    c2.drawImage(el, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/png');
    return registerImage(url, ctx, { dataUrl: url });
  } catch (e) {
    ctx.warn('<' + tag + '> 内容无法读取（跨域污染），已跳过');
    return null;
  }
}

/* ------------------------------ 填充 / 描边 ------------------------------ */

function backgroundScaleMode(cs, ctx, el) {
  const sizes = splitTop(cs.backgroundSize || 'auto', ',');
  const reps = splitTop(cs.backgroundRepeat || 'repeat', ',');
  return function (index) {
    const size = (sizes[index] || sizes[0] || 'auto').trim().toLowerCase();
    const rep = (reps[index] || reps[0] || 'repeat').trim().toLowerCase();
    let mode = 'FILL';
    if (size === 'cover') mode = 'FILL';
    else if (size === 'contain') mode = 'FIT';
    else if (rep !== 'no-repeat') mode = 'TILE';
    else if (size === 'auto') mode = 'CROP';
    else if (/^100%(\s+100%)?$/.test(size)) mode = 'FILL';
    else {
      mode = 'CROP';
      ctx.warn('background-size:' + size + ' 暂无精确映射，已按原始像素裁切：' + describe(el));
    }
    return mode;
  };
}

/* ---------------------------------------------------------------------------
 * 锥形渐变（conic-gradient）
 *
 * Figma 的 Paint 里没有 CSS 那种锥形渐变（GRADIENT_ANGULAR 的语义与 CSS 偏差
 * 很大，且真机上不好离线验证），SVG 更是没有原生锥形渐变 —— 所以这里换个思路：
 * **在浏览器里把它画出来**（canvas 有 createConicGradient，和 CSS 同一套色标语义），
 * 栅格化成一张贴图，作为图片填充写进快照。
 *
 * 好处：Figma 与 SVG 两条出口用的是同一张图，画出来和浏览器逐像素一致。
 * 代价：这一层是图片填充，在 Figma 里不能再当渐变编辑（提示里会写明）。
 * ------------------------------------------------------------------------- */

/** {r,g,b,a}（0~1）→ canvas 能吃下的 rgba() 字符串 */
function colorToCss(c) {
  const to255 = (v) => Math.max(0, Math.min(255, Math.round((v || 0) * 255)));
  return 'rgba(' + to255(c.r) + ',' + to255(c.g) + ',' + to255(c.b) + ',' + (c.a == null ? 1 : c.a) + ')';
}

/** 锥形渐变的色标位置：只接受带单位的写法（deg/grad/rad/turn/%）。
    裸数字在 CSS 里本来就不是合法的 <angle-percentage>，而且 #123456 这种
    十六进制颜色末尾也是数字 —— 误当成位置会把颜色解析坏掉。 */
const CONIC_POS_RE = /(?:\s|^)(-?[\d.]+(?:deg|grad|rad|turn|%))(?:\s+(-?[\d.]+(?:deg|grad|rad|turn|%)))?\s*$/i;

function conicStopDeg(tok) {
  const t = String(tok == null ? '' : tok).trim().toLowerCase();
  if (!t) return null;
  if (/%$/.test(t)) return parseFloat(t) * 3.6;   /* 百分比是「一圈的百分比」 */
  const a = parseAngleTok(t);
  return a == null ? null : a;
}

function parseConicStop(part, currentColor) {
  let text = String(part == null ? '' : part).trim();
  if (!text) return null;
  const positions = [];
  const m = CONIC_POS_RE.exec(text);
  if (m) {
    positions.push(m[1]);
    if (m[2]) positions.push(m[2]);
    text = text.slice(0, m.index).trim();
  }
  const color = parseColor(text.toLowerCase() === 'currentcolor' ? currentColor : text);
  if (!color) return null;
  return { color: color, positions: positions };
}

/** 头部：`from <angle>`（0deg = 12 点方向，顺时针）与 `at <position>` */
function parseConicHead(head, w, h) {
  const text = String(head || '').trim();
  let angle = 0;
  const fm = /\bfrom\s+(-?[\d.]+(?:deg|grad|rad|turn))/i.exec(text);
  if (fm) { const a = parseAngleTok(fm[1]); if (a != null) angle = a; }
  let cx = 0.5;
  let cy = 0.5;
  const am = /\bat\s+([\s\S]+)$/i.exec(text);
  if (am) {
    const toks = am[1].trim().split(/\s+/).filter(Boolean);
    if (toks.length === 1) {
      const t0 = toks[0].toLowerCase();
      if (t0 === 'top' || t0 === 'bottom') cy = posFraction(t0, h);
      else cx = posFraction(t0, w);
    } else if (toks.length >= 2) {
      cx = posFraction(toks[0], w);
      cy = posFraction(toks[1], h);
    }
  }
  return { angle: angle, cx: cx, cy: cy };
}

/** 重复锥形渐变：色标可以超出 0~360，而 canvas 的 addColorStop 不接受越界偏移，
    所以按等角重采样成一段一段的色标（steps+1 个点） */
function resampleConicStops(list, steps) {
  if (!list.length) return list;
  const period = list[list.length - 1].position;
  if (!(period > 0)) return list;
  const colorAt = (t) => {
    const x = ((t % period) + period) % period;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (x >= a.position && x <= b.position) {
        const span = (b.position - a.position) || 1;
        const k = (x - a.position) / span;
        return {
          r: a.color.r + (b.color.r - a.color.r) * k,
          g: a.color.g + (b.color.g - a.color.g) * k,
          b: a.color.b + (b.color.b - a.color.b) * k,
          a: a.color.a + (b.color.a - a.color.a) * k,
        };
      }
    }
    return list[list.length - 1].color;
  };
  const out = [];
  for (let i = 0; i <= steps; i++) out.push({ position: i / steps, color: colorAt(i / steps) });
  return out;
}

/**
 * 把锥形渐变栅格化并登记成图片，返回 ref（失败返回 null）。
 * w/h 是元素的盒子尺寸；贴图与盒子同宽高比，所以图片填充用 FILL 就是贴合的。
 */
function conicGradientRef(layer, w, h, currentColor, ctx, el, place) {
  const m = /^(-[a-z]+-)?(repeating-)?conic-gradient\((.*)\)$/is.exec(String(layer).trim());
  if (!m) return null;
  const repeating = !!m[2];
  const parts = splitTop(m[3], ',');
  if (parts.length < 2) return null;
  let head = parts[0];
  let stopsRaw = parts.slice(1);
  if (!/\bfrom\b|\bat\b/i.test(head)) { stopsRaw = parts; head = ''; }   /* 第一段就是色标 */

  const info = parseConicHead(head, w, h);
  const parsed = [];
  for (const s of stopsRaw) {
    const st = parseConicStop(s, currentColor);
    if (!st) continue;
    parsed.push({
      color: st.color,
      /* 位置换算成「度」，再借 fillStopPositions(base=360) 的补位规则 */
      positions: st.positions.map(conicStopDeg).filter((x) => x != null).map((x) => String(x)),
    });
  }
  if (parsed.length < 2) return null;

  let stops = fillStopPositions(parsed, 360);
  if (stops.length < 2) return null;
  if (repeating) stops = resampleConicStops(stops, 96);

  const boxW = Math.max(1, w);
  const boxH = Math.max(1, h);
  /* place 存在时：画布仍是整个元素盒子（图片填充会铺满盒子），
     只在 place 那个小框里画渐变并裁掉其余部分 */
  const sub = (place && place.w > 0 && place.h > 0) ? place : { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.max(1, Math.min(2, 512 / Math.max(boxW, boxH)));
  const cw = Math.max(1, Math.round(boxW * scale));
  const ch = Math.max(1, Math.round(boxH * scale));
  try {
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const c2 = cv.getContext('2d');
    if (!c2 || typeof c2.createConicGradient !== 'function') return null;
    if (place) {
      c2.beginPath();
      c2.rect(sub.x * scale, sub.y * scale, sub.w * scale, sub.h * scale);
      c2.clip();
    }
    /* canvas 的 0 弧度在 3 点方向、顺时针为正；CSS 的 0deg 在 12 点方向 —— 差 90° */
    const g = c2.createConicGradient((info.angle - 90) * Math.PI / 180,
      (sub.x + info.cx * sub.w) * scale, (sub.y + info.cy * sub.h) * scale);
    for (const s of stops) {
      const p = clamp01(s.position);
      try { g.addColorStop(p, colorToCss(s.color)); } catch (e) { /* 颜色/位置非法，跳过 */ }
    }
    c2.fillStyle = g;
    c2.fillRect(0, 0, cw, ch);
    const url = cv.toDataURL('image/png');
    const ref = registerImage(url, ctx, { dataUrl: url });
    if (ref) ctx.warn('锥形渐变已栅格化成图片填充（Figma 里是贴图，不能再当渐变编辑）：' + describe(el || {}));
    return ref;
  } catch (e) {
    return null;
  }
}

/** 渐变层 → 填充。锥形走栅格化，其余走几何解析。 */
function gradientPaint(layer, w, h, currentColor, ctx, el, place, box) {
  if (/conic-gradient/i.test(layer)) {
    const ref = (box && place)
      ? conicGradientRef(layer, box.w, box.h, currentColor, ctx, el, place)
      : conicGradientRef(layer, w, h, currentColor, ctx, el, null);
    if (ref) return { type: 'IMAGE_REF', ref: ref, scaleMode: 'FILL' };
    return null;
  }
  return parseGradient(layer, w, h, currentColor);
}

/* ------------------- 背景层的尺寸/位置（渐变也要遵守） ------------------- */

/** 极简长度求值：把 `calc(100% - 16px)` / `5px` / `50%` 解析成 {px, pct} 线性组合 */
function parseLenExpr(text) {
  const full = String(text == null ? '' : text).trim();
  const m = /^calc\(([\s\S]*)\)$/i.exec(full);
  const src = m ? m[1] : full;
  let i = 0;
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  function number() {
    skip();
    const mm = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(src.slice(i));
    if (!mm) return null;
    i += mm[0].length;
    return parseFloat(mm[0]);
  }
  function unit() {
    skip();
    if (src.slice(i, i + 2).toLowerCase() === 'px') { i += 2; return 'px'; }
    if (src[i] === '%') { i += 1; return '%'; }
    return '';
  }
  function factor() {
    skip();
    if (src[i] === '(') { i++; const v = sum(); skip(); if (src[i] === ')') i++; return v; }
    if (src[i] === '-') { i++; const v = factor(); return { px: -v.px, pct: -v.pct }; }
    if (src[i] === '+') { i++; return factor(); }
    const n = number();
    if (n == null) { i++; return { px: 0, pct: 0 }; }
    const u = unit();
    return u === '%' ? { px: 0, pct: n } : { px: n, pct: 0 };
  }
  function term() {
    let v = factor();
    for (;;) {
      skip();
      const c = src[i];
      if (c !== '*' && c !== '/') break;
      i++;
      const r = factor();
      const k = r.px || 1;
      v = c === '*' ? { px: v.px * k, pct: v.pct * k } : { px: v.px / k, pct: v.pct / k };
    }
    return v;
  }
  function sum() {
    let v = term();
    for (;;) {
      skip();
      const c = src[i];
      if (c !== '+' && c !== '-') break;
      i++;
      const r = term();
      v = { px: v.px + (c === '-' ? -r.px : r.px), pct: v.pct + (c === '-' ? -r.pct : r.pct) };
    }
    return v;
  }
  const v = sum();
  return isFinite(v.px) && isFinite(v.pct) ? v : { px: 0, pct: 0 };
}

function lenPx(tok, base) {
  const v = parseLenExpr(tok);
  return v.px + (v.pct / 100) * (base || 0);
}

const POS_KEYWORD = { left: '0%', top: '0%', center: '50%', right: '100%', bottom: '100%' };

function posPx(tok, area, size) {
  const t = String(tok == null ? '' : tok).trim().toLowerCase();
  const v = parseLenExpr(POS_KEYWORD[t] || t);
  return v.px + (v.pct / 100) * ((area || 0) - (size || 0));
}

/**
 * 背景层的放置框（相对元素盒子）：`background-size: 5px 5px` +
 * `background-position: calc(100% - 16px) 50%` + `no-repeat` 这种「小图案」写法
 * 在真实项目里到处都是（下拉箭头、图标、条纹）。
 *
 * 以前渐变层**完全忽略** size/position，把渐变铺满整个盒子 ——
 * uikit 的 select 箭头就这么变成了横贯整个控件的巨大三角。
 * 返回 null 表示「按整框铺」（auto / cover / contain / 平铺）。
 */
function bgLayerPlace(cs, box, index) {
  const sizes = splitTop(cs.backgroundSize || 'auto', ',');
  const poss = splitTop(cs.backgroundPosition || '0% 0%', ',');
  const reps = splitTop(cs.backgroundRepeat || 'repeat', ',');
  const sizeTok = String(sizes[index] || sizes[0] || 'auto').trim().toLowerCase();
  const posTok = String(poss[index] || poss[0] || '0% 0%').trim().toLowerCase();
  const rep = String(reps[index] || reps[0] || 'repeat').trim().toLowerCase();
  if (!sizeTok || sizeTok === 'auto' || /cover|contain/.test(sizeTok)) return null;
  if (rep.indexOf('no-repeat') < 0) return null;   /* 平铺的渐变：保持整框近似 */

  const bl = num(cs.borderLeftWidth, 0);
  const br = num(cs.borderRightWidth, 0);
  const bt = num(cs.borderTopWidth, 0);
  const bb = num(cs.borderBottomWidth, 0);
  /* 定位区默认是 padding-box */
  const aw = Math.max(1, box.w - bl - br);
  const ah = Math.max(1, box.h - bt - bb);

  /* 注意用 splitTop（忽略括号）而不是 split(/\s+/)：
     `calc(100% - 16px)` 里有空格，按空白拆会把 calc 拆碎，位置直接算成 0 */
  const sizeParts = splitTop(sizeTok, ' ');
  const w = lenPx(sizeParts[0], aw);
  const h = sizeParts[1] ? lenPx(sizeParts[1], ah) : w;
  if (!(w > 0) || !(h > 0)) return null;

  const posParts = splitTop(posTok, ' ');
  const x = posPx(posParts[0] || '0%', aw, w);
  const y = posPx(posParts[1] || '50%', ah, h);
  return { x: x + bl, y: y + bt, w: w, h: h };
}

/** 把「整框渐变」的仿射矩阵，改成只作用在 place 这个子矩形上 */
function composePlace(t, place, boxW, boxH) {
  if (!t || !place) return t;
  const sw = place.w / (boxW || 1);
  const sh = place.h / (boxH || 1);
  const tx = place.x / (boxW || 1);
  const ty = place.y / (boxH || 1);
  return [
    [t[0][0] * sw, t[0][1] * sh, t[0][0] * tx + t[0][1] * ty + t[0][2]],
    [t[1][0] * sw, t[1][1] * sh, t[1][0] * tx + t[1][1] * ty + t[1][2]],
  ];
}

function buildFills(el, cs, box, ctx) {
  const fills = [];
  const bg = parseColor(cs.backgroundColor);
  if (bg && bg.a > 0.002) fills.push({ type: 'SOLID', color: { r: bg.r, g: bg.g, b: bg.b }, opacity: bg.a });

  const layers = splitTop(cs.backgroundImage || 'none', ',');
  if (!layers.length || (layers.length === 1 && layers[0] === 'none')) return fills;

  const scaleOf = backgroundScaleMode(cs, ctx, el);

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer || layer === 'none') continue;

    if (/gradient\(/i.test(layer)) {
      /* 小图案写法：渐变只画在 size/position 指定的那个小框里 */
      const place = bgLayerPlace(cs, box, i);
      const gw = place ? place.w : box.w;
      const gh = place ? place.h : box.h;
      const paint = gradientPaint(layer, gw, gh, cs.color, ctx, el, place, box);
      if (paint) {
        if (place && paint.gradientTransform) {
          /* 两条出口要的东西不一样：
             Figma 的 Paint 没有「渐变盒子」这个概念，只能把子矩形烘进仿射矩阵；
             SVG 的 <linearGradient> 可以直接用 userSpaceOnUse 坐标平移，
             而 soff.js 那套「从矩阵反解端点」的公式只对整框渐变成立 ——
             所以原始矩阵和盒子都留着，让 svg.js 用原始矩阵 + 平移。 */
          paint.gradientTransformBase = paint.gradientTransform;
          paint.gradientBox = { x: place.x, y: place.y, w: place.w, h: place.h };
          paint.gradientTransform = composePlace(paint.gradientTransform, place, box.w, box.h);
        }
        fills.push(paint);
      } else {
        if (/conic-gradient/i.test(layer)) {
          /* 栅格化失败（极老的浏览器没有 createConicGradient）才退到近似纯色 */
          const stops = [];
          const inner = splitTop(layer, ',');
          for (const s of inner) {
            const p = parseStop(s, cs.color) || parseConicStop(s, cs.color);
            if (p) stops.push(p.color);
          }
          const mid = stops.length ? stops[Math.floor(stops.length / 2)] : { r: 0.5, g: 0.5, b: 0.5, a: 1 };
          fills.push({ type: 'SOLID', color: { r: mid.r, g: mid.g, b: mid.b }, opacity: mid.a });
          ctx.warn('锥形渐变栅格化失败（浏览器不支持 createConicGradient），已用近似纯色代替：' + describe(el));
        } else {
          ctx.warn('渐变解析失败，已跳过：' + describe(el));
        }
      }
      continue;
    }

    const um = /url\((['"]?)(.*?)\1\)/.exec(layer);
    if (um && um[2]) {
      const url = um[2];
      const ref = registerImage(url, ctx);
      if (ref) fills.push({ type: 'IMAGE_REF', ref: ref, scaleMode: scaleOf(i) });
      continue;
    }
  }
  return fills;
}

function imageScaleMode(cs, ctx, el) {
  const fit = String(cs.objectFit || 'fill').toLowerCase();
  if (fit === 'contain') return 'FIT';
  if (fit === 'cover') return 'FILL';
  if (fit === 'none') return 'CROP';
  if (fit === 'scale-down') {
    const r = el.getBoundingClientRect();
    if (el.naturalWidth && el.naturalHeight && el.naturalWidth <= r.width + 1 && el.naturalHeight <= r.height + 1) return 'CROP';
    return 'FIT';
  }
  return 'FILL';
}

function buildStrokes(el, cs, box, ctx) {
  const res = { strokes: null, weights: null, dash: null, overlays: [] };
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  const widths = [];
  const colors = [];
  const styles = [];
  for (const s of sides) {
    const wv = num(cs['border' + s + 'Width'], 0);
    const cv = parseColor(cs['border' + s + 'Color']);
    const st = String(cs['border' + s + 'Style'] || 'none').toLowerCase();
    widths.push(st === 'none' || st === 'hidden' ? 0 : wv);
    colors.push(cv);
    styles.push(st);
  }
  const visible = widths.map((w, i) => w > 0.01 && colors[i] && colors[i].a > 0.002);
  const count = visible.filter(Boolean).length;
  if (!count) return res;

  const allSameColor = visible.every((v, i) => !v || sameColor(colors[i], colors[visible.findIndex(Boolean)]));

  if (allSameColor) {
    const firstIdx = visible.findIndex(Boolean);
    const c = colors[firstIdx];
    res.strokes = [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
    const allSameWidth = widths.every((w) => Math.abs(w - widths[firstIdx]) < 0.01);
    res.weights = allSameWidth ? widths[firstIdx] : widths;
    for (let i = 0; i < 4; i++) {
      /* Chromium 实测的虚线节奏：dashed 段长 2w、间隔 w（周期 3w）；
         dotted 段长与间隔都是 w（周期 2w）。照这个来，复刻出的虚线和原页面
         才能在同一条线上重合（之前 dashed 用 [3w,2w]、dotted 用 [w,1.6w]，
         周期不对，整条线逐像素都是错位的）。 */
      if (styles[i] === 'dashed') res.dash = [widths[i] * 2, widths[i]];
      else if (styles[i] === 'dotted') res.dash = [Math.max(widths[i], 1), Math.max(widths[i], 1)];
      if (res.dash) break;
    }
    return res;
  }

  /* 四边颜色不同：拆成 1~4 个纯色矩形，保证颜色正确。
     但**边框样式不能丢**：虚线/点线要带 dash（画成描边而不是实心矩形），
     double 则是两条细线（CSS 的规则：线宽与间距各占 1/3）。 */
  const pushSide = (side, idx) => {
    const wv = widths[idx];
    if (!visible[idx] || wv <= 0.01) return;
    const col = colors[idx];
    const st = String(styles[idx] || 'solid').toLowerCase();
    const geo = side === 'top' ? { w: box.w, h: wv, x: 0, y: 0 }
      : side === 'right' ? { w: wv, h: box.h, x: box.w - wv, y: 0 }
        : side === 'bottom' ? { w: box.w, h: wv, x: 0, y: box.h - wv }
          : { w: wv, h: box.h, x: 0, y: 0 };

    if (st === 'double') {
      const t = wv / 3;
      const first = side === 'top' ? { w: box.w, h: t, x: 0, y: 0 }
        : side === 'bottom' ? { w: box.w, h: t, x: 0, y: box.h - wv }
          : side === 'right' ? { w: t, h: box.h, x: box.w - wv, y: 0 }
            : { w: t, h: box.h, x: 0, y: 0 };
      const second = side === 'top' ? { w: box.w, h: t, x: 0, y: wv - t }
        : side === 'bottom' ? { w: box.w, h: t, x: 0, y: box.h - t }
          : side === 'right' ? { w: t, h: box.h, x: box.w - t, y: 0 }
            : { w: t, h: box.h, x: wv - t, y: 0 };
      res.overlays.push(Object.assign({ side: side, color: col, style: 'solid', dash: null }, first));
      res.overlays.push(Object.assign({ side: side, color: col, style: 'solid', dash: null }, second));
      return;
    }
    if (st === 'dashed' || st === 'dotted') {
      res.overlays.push(Object.assign({ side: side, color: col, style: st,
        dash: st === 'dashed' ? [wv * 2, wv] : [Math.max(wv, 1), Math.max(wv, 1)] }, geo));
      return;
    }
    res.overlays.push(Object.assign({ side: side, color: col, style: 'solid', dash: null }, geo));
  };
  pushSide('top', 0);
  pushSide('right', 1);
  pushSide('bottom', 2);
  pushSide('left', 3);
  res.overlays = res.overlays.filter((o) => o.w > 0.01 && o.h > 0.01);
  return res;
}

/* -------------------------------- 伪元素 -------------------------------- */

function pseudoRecords(el, cs, box, ctx) {
  const out = [];
  if (!ctx.opts.capturePseudo) return out;
  for (const which of ['::before', '::after']) {
    let pcs;
    try { pcs = ctx.win.getComputedStyle(el, which); } catch (e) { continue; }
    if (!pcs) continue;
    const content = pcs.content;
    if (!content || content === 'none' || content === 'normal') continue;
    if (pcs.display === 'none' || pcs.visibility === 'hidden') continue;

    const pos = pcs.position;
    const pw = parseFloat(pcs.width);
    const ph = parseFloat(pcs.height);
    if (!isFinite(pw) || !isFinite(ph) || (pw <= 0 && ph <= 0)) continue;

    let px = null;
    let py = null;
    if (pos === 'absolute' || pos === 'fixed') {
      const l = pcs.left === 'auto' ? null : num(pcs.left, NaN);
      const r = pcs.right === 'auto' ? null : num(pcs.right, NaN);
      const t = pcs.top === 'auto' ? null : num(pcs.top, NaN);
      const b = pcs.bottom === 'auto' ? null : num(pcs.bottom, NaN);
      if (l != null && isFinite(l)) px = box.x + l;
      else if (r != null && isFinite(r)) px = box.right - r - pw;
      if (t != null && isFinite(t)) py = box.y + t;
      else if (b != null && isFinite(b)) py = box.bottom - b - ph;
    }
    if (px == null || py == null) continue;

    const fills = [];
    const bgc = parseColor(pcs.backgroundColor);
    if (bgc && bgc.a > 0.002) fills.push({ type: 'SOLID', color: { r: bgc.r, g: bgc.g, b: bgc.b }, opacity: bgc.a });
    const bgi = pcs.backgroundImage;
    if (bgi && bgi !== 'none' && /gradient\(/i.test(bgi)) {
      const paint = gradientPaint(splitTop(bgi, ',')[0], pw, ph, pcs.color, ctx, el);
      if (paint) fills.push(paint);
    } else if (bgi && bgi !== 'none') {
      const um = /url\((['"]?)(.*?)\1\)/.exec(bgi);
      if (um && um[2]) {
        const ref = registerImage(um[2], ctx);
        if (ref) fills.push({ type: 'IMAGE_REF', ref: ref, scaleMode: 'FILL' });
      }
    }
    const pw4 = [num(pcs.borderTopWidth, 0), num(pcs.borderRightWidth, 0), num(pcs.borderBottomWidth, 0), num(pcs.borderLeftWidth, 0)];
    const bc = parseColor(pcs.borderTopColor);
    const strokes = (pw4[0] > 0 && bc && bc.a > 0.002) ? [{ type: 'SOLID', color: { r: bc.r, g: bc.g, b: bc.b }, opacity: bc.a }] : null;
    const radius = [num(pcs.borderTopLeftRadius, 0), num(pcs.borderTopRightRadius, 0), num(pcs.borderBottomRightRadius, 0), num(pcs.borderBottomLeftRadius, 0)];

    if (fills.length || strokes) {
      ctx.stats.pseudo++;
      out.push({
        t: 'rect',
        name: which,
        x: px - box.x,
        y: py - box.y,
        w: pw,
        h: ph,
        fills: fills,
        strokes: strokes,
        strokeWeights: strokes ? pw4[0] : null,
        radius: radius,
        effects: parseShadowList(pcs.boxShadow, ctx.opts.shadowScale),
        opacity: num(pcs.opacity, 1),
      });
    }

    /* 伪元素里的图标/文案：没有真实文本节点可测，按盒子居中放置 */
    const raw = String(content);
    const text = raw.replace(/^["']|["']$/g, '').replace(/\\"/g, '"').replace(/\\A\s?/g, '');
    if (text && text.trim() && text !== 'none') {
      const disp = pcs.display;
      const just = String(pcs.justifyContent || '').toLowerCase();
      const align = String(pcs.alignItems || '').toLowerCase();
      let alignH = mapAlign(pcs.textAlign, pcs.direction);
      let valign = 'TOP';
      let autosize = 'W';
      if (/flex|grid/.test(disp) && (just.indexOf('center') >= 0 || align.indexOf('center') >= 0)) {
        alignH = just.indexOf('center') >= 0 ? 'CENTER' : alignH;
        valign = align.indexOf('center') >= 0 ? 'CENTER' : 'TOP';
        autosize = 'N';
      }
      out.push({
        t: 'text',
        name: text.slice(0, 32),
        x: px - box.x,
        y: py - box.y,
        w: pw,
        h: ph,
        fills: textFillOf(pcs),
        effects: parseShadowList(pcs.textShadow, ctx.opts.shadowScale),
        opacity: num(pcs.opacity, 1),
        text: Object.assign(textStyleOf(pcs, text), { characters: text, autosize: autosize, valign: valign, align: alignH }),
      });
    }
  }
  return out;
}

/* -------------------------------- 文本节点 ------------------------------ */

function groupLines(rects) {
  const sorted = rects.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.top - last.top) < Math.max(1.5, last.h * 0.45)) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
      last.h = Math.max(last.h, r.height);
    } else {
      lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height });
    }
  }
  return lines;
}

function splitByLines(tn, raw, lines, ctx) {
  const range = ctx.doc.createRange();
  const bounds = [];
  let start = 0;
  const charTop = (i) => {
    try {
      range.setStart(tn, i);
      range.setEnd(tn, Math.min(i + 1, raw.length));
      const r = range.getBoundingClientRect();
      return r && r.height > 0 ? r : null;
    } catch (e) {
      return null;
    }
  };
  for (let li = 0; li < lines.length; li++) {
    if (li === lines.length - 1) { bounds.push([start, raw.length]); break; }
    const nextTop = lines[li + 1].top;
    let lo = start;
    let hi = raw.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = charTop(mid);
      if (r && r.top >= nextTop - 0.6) hi = mid;
      else lo = mid + 1;
    }
    if (lo <= start) lo = start + 1;
    bounds.push([start, lo]);
    start = lo;
  }
  return bounds;
}

function collapseText(raw, ws) {
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return raw.replace(/\r\n?/g, '\n');
  let t = raw.replace(/[\t\n\r ]+/g, ' ');
  if (ws === 'pre-line') t = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
  return t;
}

function walkTextNode(tn, parentAbs, ctx) {
  const raw = tn.nodeValue;
  if (!raw) return [];
  const parent = tn.parentElement;
  if (!parent) return [];
  let cs;
  try { cs = ctx.win.getComputedStyle(parent); } catch (e) { return []; }
  if (!cs || cs.display === 'none' || cs.visibility !== 'visible') return [];

  const ws = cs.whiteSpace || 'normal';
  const range = ctx.doc.createRange();
  range.selectNodeContents(tn);
  const rawRects = Array.from(range.getClientRects()).filter((r) => r.width > 0.2 || r.height > 0.2);
  if (!rawRects.length) return [];

  const style = textStyleOf(cs, raw);
  if (!style.fontSize || style.fontSize <= 0) return [];
  const fills = textFillOf(cs);
  const effects = parseShadowList(cs.textShadow, ctx.opts.shadowScale);
  const opacity = num(cs.opacity, 1);
  const lines = groupLines(rawRects);

  const out = [];
  const useLineMode = ctx.opts.textMode === 'line' && raw.length <= 4000;

  const pushLine = (text, rectClient, autosize, w, h, valign) => {
    if (!text || !text.replace(/\s+/g, '').length) return;
    const rect = clientBox(rectClient, ctx);
    const L = style.lineHeight != null ? style.lineHeight : rect.h;
    const y = rect.y - (L - rect.h) / 2;
    const tx = Object.assign({}, textStyleOf(cs, text), {
      characters: text,
      autosize: autosize || 'W',
      valign: valign || 'TOP',
    });
    const rec = {
      t: 'text',
      name: text.replace(/\s+/g, ' ').trim().slice(0, 48),
      x: rect.x - parentAbs.x,
      y: y - parentAbs.y,
      w: w == null ? rect.w : w,
      h: h == null ? rect.h : h,
      fills: fills,
      effects: effects,
      opacity: opacity,
      text: tx,
    };
    ctx.stats.texts++;
    out.push(rec);
  };

  if (lines.length <= 1 || !useLineMode) {
    const text = collapseText(raw, ws).replace(/\s+$/, '').replace(/^\s+/, (m) => (/pre/.test(ws) ? m : ''));
    const line = lines[0] || { top: rawRects[0].top, bottom: rawRects[0].bottom, left: rawRects[0].left, right: rawRects[0].right, h: rawRects[0].height };
    if (lines.length <= 1) {
      pushLine(text, { left: line.left, right: line.right, top: line.top, bottom: line.bottom, height: line.h, width: line.right - line.left }, 'W', null, null, 'TOP');
      return out;
    }
    /* 多行但按整块处理：用父容器内容宽度换行，保留可编辑性 */
    let cb = null;
    try {
      const pr = parent.getBoundingClientRect();
      const pl = num(cs.paddingLeft, 0);
      const prr = num(cs.paddingRight, 0);
      const bl = num(cs.borderLeftWidth, 0);
      const br = num(cs.borderRightWidth, 0);
      cb = { left: pr.left + ctx.scrollX + bl + pl, width: Math.max(1, pr.width - bl - br - pl - prr), top: pr.top + ctx.scrollY, height: pr.height };
    } catch (e) { cb = null; }
    const first = lines[0];
    const lastR = lines[lines.length - 1];
    const rectClient = {
      left: cb ? cb.left : Math.min.apply(null, lines.map((l) => l.left)),
      right: cb ? cb.left + cb.width : Math.max.apply(null, lines.map((l) => l.right)),
      top: first.top,
      bottom: lastR.bottom,
      height: lastR.bottom - first.top,
      width: cb ? cb.width : Math.max.apply(null, lines.map((l) => l.right)) - Math.min.apply(null, lines.map((l) => l.left)),
    };
    pushLine(text, rectClient, 'H', rectClient.width, rectClient.height, 'TOP');
    return out;
  }

  const bounds = splitByLines(tn, raw, lines, ctx);
  for (let i = 0; i < lines.length; i++) {
    const a = bounds[i] ? bounds[i][0] : 0;
    const b = bounds[i] ? bounds[i][1] : raw.length;
    const slice = collapseText(raw.slice(a, b), ws).trim();
    if (!slice) continue;
    const line = lines[i];
    pushLine(slice, { left: line.left, right: line.right, top: line.top, bottom: line.bottom, height: line.h, width: line.right - line.left }, 'W', null, null, 'TOP');
  }
  return out;
}

/* -------------------------------- 表单文本 ------------------------------ */

/** 控件内建文本的纵向位置：把**文档坐标**对齐到整数像素。
    Chromium 在 Windows 上把文本基线落在整像素上，而快照里的盒子坐标常常是小数
    （实测 uikit 控件页的控件 y = xxx.9375）—— 不对齐的话，同一行文字的墨迹会差 1px，
    细笔画文字逐像素一比就是「整行都是差异」。
    普通文本走的是浏览器量出来的行盒，本来就和渲染一致，不需要这一步。 */
function snapLocal(absBase, local) {
  return Math.round(absBase + local) - absBase;
}

function formControlText(el, cs) {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return null;
  if (tag === 'input') {
    const t = String(el.type || 'text').toLowerCase();
    if (/^(checkbox|radio|range|color|file|submit|button|reset|image|hidden)$/.test(t)) return null;
  }
  /* 多选下拉（multiple / size>1）：每一行 option 都有自己的盒子，
     文字要落在各自那一行里 —— 整块居中会在控件中央堆成一团（实测差 50+）。 */
  if (tag === 'select' && (el.multiple || num(el.getAttribute('size'), 0) > 1)) return null;
  let text = '';
  if (tag === 'select') {
    const o = el.selectedOptions && el.selectedOptions[0];
    text = o ? (o.textContent || '') : '';
  } else {
    text = el.value != null ? String(el.value) : '';
  }
  let placeholder = false;
  if (!text) { text = el.placeholder || ''; placeholder = true; }
  if (!text) return null;
  return { text: text, placeholder: placeholder };
}

/**
 * 多行控件（textarea）的文本按**浏览器的真实折行**拆成一行一条记录。
 *
 * 为什么必须拆：控件里的文字在 DOM 里不是文本节点，量不到行盒；
 * 而 Figma 与 SVG 都会拿自己的字体度量重新折行 —— 断点一旦不同，
 * 整段文字的版式就全变了（实测 uikit 控件页的 textarea 差 20px 以上）。
 * 做法是临时造一个同样宽度/字体的隐藏 div，让浏览器排一遍，
 * 再用与正文完全相同的 groupLines / splitByLines 取行。
 */
function wrapControlText(el, cs, ctx, availW) {
  const doc = ctx.doc;
  const raw = String(el.value == null ? '' : el.value);
  if (!raw) return null;
  let probe = null;
  try {
    probe = doc.createElement('div');
    probe.setAttribute('style', 'position:absolute;left:-99999px;top:0;visibility:hidden;'
      + 'white-space:pre-wrap;overflow-wrap:break-word;margin:0;padding:0;border:0;'
      + 'font-family:' + cs.fontFamily + ';font-size:' + cs.fontSize + ';font-style:' + cs.fontStyle + ';'
      + 'font-weight:' + cs.fontWeight + ';line-height:' + cs.lineHeight + ';'
      + 'letter-spacing:' + cs.letterSpacing + ';text-align:' + cs.textAlign + ';'
      + 'width:' + availW + 'px;');
    const tn = doc.createTextNode(raw);
    probe.appendChild(tn);
    doc.body.appendChild(probe);
    const range = doc.createRange();
    range.selectNodeContents(tn);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.2 || r.height > 0.2);
    if (!rects.length) return null;
    const lines = groupLines(rects);
    const bounds = splitByLines(tn, raw, lines, ctx);
    const base = probe.getBoundingClientRect().top;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const a = bounds[i] ? bounds[i][0] : 0;
      const b = bounds[i] ? bounds[i][1] : raw.length;
      out.push({ text: raw.slice(a, b), top: lines[i].top - base, h: lines[i].h });
    }
    return out;
  } catch (e) {
    return null;
  } finally {
    if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
  }
}

/* ------------------------- 原生控件的「系统绘制」 -------------------------
 * 复选框的勾、单选的点、取色控件的色块都是**浏览器自己画的**（UA 绘制），
 * DOM 里没有对应盒子 —— 不补出来的话，快照里就只剩一个空框：
 * 实测 uikit 的控件页里，那一排 checkbox/radio/color 是差异最大的区域之一。
 * 这里按 Chromium 的观感补几条矢量记录，颜色取 computed 的 accent-color。
 * ------------------------------------------------------------------------ */

function accentOf(cs) {
  const a = parseColor(cs.accentColor);
  if (a && a.a > 0.02) return a;
  return { r: 0, g: 0.46, b: 1, a: 1 };   /* Chromium 的默认强调色 */
}

function checkboxGlyph(w, h, disabled) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 16 16">'
    + '<path d="M3.4 8.5l3 3 6-6.8" fill="none" stroke="#ffffff" stroke-width="2.2"'
    + ' stroke-linecap="round" stroke-linejoin="round"'
    + (disabled ? ' stroke-opacity="0.7"' : '') + '/></svg>';
  return { t: 'svg', name: 'check', x: 0, y: 0, w: w, h: h, svg: svg, children: [] };
}

function nativeControlRecords(el, cs, box, ctx) {
  if (el.tagName.toLowerCase() !== 'input') return [];
  const type = String(el.type || 'text').toLowerCase();
  const out = [];
  const bl = num(cs.borderLeftWidth, 0);
  const br = num(cs.borderRightWidth, 0);
  const bt = num(cs.borderTopWidth, 0);
  const bb = num(cs.borderBottomWidth, 0);
  const pl = num(cs.paddingLeft, 0);
  const prr = num(cs.paddingRight, 0);
  const pt = num(cs.paddingTop, 0);
  const pb = num(cs.paddingBottom, 0);
  const iw = Math.max(1, box.w - bl - br - pl - prr);
  const ih = Math.max(1, box.h - bt - bb - pt - pb);

  if (type === 'color') {
    /* 取色控件：内容区就是那块色板 */
    const c = parseColor(el.value) || { r: 0, g: 0, b: 0, a: 1 };
    out.push({
      t: 'rect', name: 'color-swatch', x: bl + pl, y: bt + pt, w: iw, h: ih,
      fills: [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: 1 }],
      radius: [1, 1, 1, 1],
    });
    return out;
  }

  if (type === 'checkbox' || type === 'radio') {
    const w = Math.max(1, box.w);
    const h = Math.max(1, box.h);
    const accent = accentOf(cs);
    const disabled = !!el.disabled;
    const half = Math.min(w, h) / 2;
    const radius = type === 'radio'
      ? [half, half, half, half]
      : [Math.min(3, half), Math.min(3, half), Math.min(3, half), Math.min(3, half)];
    if (el.checked) {
      out.push({
        t: 'rect', name: type + '-on', x: 0, y: 0, w: w, h: h, radius: radius,
        fills: [{ type: 'SOLID', color: { r: accent.r, g: accent.g, b: accent.b }, opacity: disabled ? 0.45 : 1 }],
      });
      if (type === 'checkbox') out.push(checkboxGlyph(w, h, disabled));
      else {
        const d = Math.max(2, Math.min(w, h) * 0.42);
        out.push({
          t: 'rect', name: 'radio-dot', x: (w - d) / 2, y: (h - d) / 2, w: d, h: d,
          radius: [d / 2, d / 2, d / 2, d / 2],
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: disabled ? 0.75 : 1 }],
        });
      }
    } else {
      out.push({
        t: 'rect', name: type + '-off', x: 0, y: 0, w: w, h: h, radius: radius, fills: [],
        strokes: [{ type: 'SOLID', color: { r: 0.46, g: 0.46, b: 0.46 }, opacity: disabled ? 0.5 : 1 }],
        strokeWeights: 1.5,
      });
    }
    return out;
  }

  if (type === 'range') {
    /* 滑块：按 Chromium 实测的几何补出来（轨道 8px、带 1px 深色描边；
       已填充段 6px 强调色；滑块头 16px 强调色圆）。
       数据来自对真实渲染的逐像素测量：轨道在控件垂直居中，
       滑块头行程是 [thumb/2, w - thumb/2]。 */
    const w = Math.max(1, box.w);
    const h = Math.max(1, box.h);
    const min = num(el.min === '' ? 0 : el.min, 0);
    const max = num(el.max === '' ? 100 : el.max, 100);
    const val = num(el.value, min);
    const ratio = clamp01((val - min) / ((max - min) || 1));
    const accent = accentOf(cs);
    const dim = el.disabled ? 0.45 : 1;
    const thumbD = 16;
    const trackH = 8;
    const cx = thumbD / 2 + ratio * Math.max(0, w - thumbD);
    const ty = (h - trackH) / 2;
    const solid = (r, g, b, a) => ({ type: 'SOLID', color: { r: r, g: g, b: b }, opacity: a == null ? 1 : a });
    out.push({
      t: 'rect', name: 'range-track', x: 0, y: ty, w: w, h: trackH,
      radius: [trackH / 2, trackH / 2, trackH / 2, trackH / 2],
      fills: [solid(0.937, 0.937, 0.937, dim)],
      strokes: [solid(0.698, 0.698, 0.698, dim)],
      strokeWeights: 1,
    });
    if (cx > 1) {
      out.push({
        t: 'rect', name: 'range-fill', x: 1, y: ty + 1, w: Math.max(0.01, cx - 1), h: trackH - 2,
        radius: [(trackH - 2) / 2, (trackH - 2) / 2, (trackH - 2) / 2, (trackH - 2) / 2],
        fills: [solid(accent.r, accent.g, accent.b, dim)],
      });
    }
    out.push({
      t: 'rect', name: 'range-thumb', x: cx - thumbD / 2, y: (h - thumbD) / 2, w: thumbD, h: thumbD,
      radius: [thumbD / 2, thumbD / 2, thumbD / 2, thumbD / 2],
      fills: [solid(accent.r, accent.g, accent.b, dim)],
    });
    return out;
  }

  return out;
}

/* -------------------------------- 主遍历 -------------------------------- */

function walkNode(node, parentAbs, ctx) {
  if (!node) return [];
  if (node.nodeType === 3) return walkTextNode(node, parentAbs, ctx);
  if (node.nodeType !== 1) return [];
  return walkElement(node, parentAbs, ctx);
}

function walkElement(el, parentAbs, ctx) {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS[el.tagName]) return [];
  let cs;
  try { cs = ctx.win.getComputedStyle(el); } catch (e) { return []; }
  if (!cs || cs.display === 'none') { ctx.stats.skipped++; return []; }

  const hidden = cs.visibility === 'hidden' || cs.visibility === 'collapse';
  const opacity = num(cs.opacity, 1);
  const box = absBox(el, ctx);
  const isContentRoot = ctx.opts.hostElement === el;

  /* display:contents / picture 等无盒容器：子内容上提 */
  if ((cs.display === 'contents' || HOIST_TAGS[el.tagName]) && !isContentRoot) {
    const hoisted = [];
    for (let i = 0; i < el.childNodes.length; i++) {
      hoisted.push.apply(hoisted, walkNode(el.childNodes[i], parentAbs, ctx));
    }
    return hoisted;
  }

  const isSvg = tag === 'svg';
  const isImg = tag === 'img';
  const isCanvas = tag === 'canvas';
  const isVideo = tag === 'video';
  const isForm = tag === 'input' || tag === 'textarea' || tag === 'select';

  /* 还原未变换尺寸（旋转/缩放前） */
  let w = box.w;
  let h = box.h;
  let rotation = null;
  const tf = cs.transform;
  if (tf && tf !== 'none') {
    try {
      const m = new DOMMatrixReadOnly(tf);
      const det = m.a * m.d - m.b * m.c;
      if (Math.abs(det) > 1e-6) {
        const sx = Math.hypot(m.a, m.b);
        const sy = Math.hypot(m.c, m.d);
        const skewDot = (m.a * m.c + m.b * m.d) / ((sx * sy) || 1);
        if (Math.abs(skewDot) > 0.02) ctx.warn('检测到斜切(skew)变换，已按旋转近似：' + describe(el));
        const deg = Math.atan2(m.b, m.a) * 180 / Math.PI;
        const scaled = Math.abs(sx - 1) > 0.004 || Math.abs(sy - 1) > 0.004;
        const rotated = Math.abs(deg) > 0.02;
        /* 只要发生旋转或缩放，尺寸必须回到「未变换」的 offset 尺寸，
           否则旋转会把包围盒尺寸当成原始尺寸，再次放大一圈 */
        if ((scaled || rotated) && el.offsetWidth > 0 && el.offsetHeight > 0) {
          w = el.offsetWidth * sx;
          h = el.offsetHeight * sy;
        }
        if (rotated) rotation = -deg;   /* CSS 顺时针 -> Figma 逆时针 */
      }
    } catch (e) { /* 忽略非法 transform */ }
  }

  const children = [];
  if (!isSvg && !isImg && !isCanvas && !isVideo) {
    for (let i = 0; i < el.childNodes.length; i++) {
      children.push.apply(children, walkNode(el.childNodes[i], box, ctx));
    }
  }

  /* 表单控件的内建文本 */
  const ctl = isForm && !hidden ? formControlText(el, cs) : null;
  if (ctl) {
    const style = textStyleOf(cs, ctl.text);
    const pl = num(cs.paddingLeft, 0);
    const prr = num(cs.paddingRight, 0);
    const bl = num(cs.borderLeftWidth, 0);
    const br = num(cs.borderRightWidth, 0);
    const pt = num(cs.paddingTop, 0);
    const pb = num(cs.paddingBottom, 0);
    const bt = num(cs.borderTopWidth, 0);
    const bb = num(cs.borderBottomWidth, 0);
    const multi = tag === 'textarea';
    const align = mapAlign(cs.textAlign, cs.direction);
    const color = ctl.placeholder ? parseColor(cs.color) : parseColor(cs.color);
    const fillsFor = [{
      type: 'SOLID',
      color: { r: color ? color.r : 0, g: color ? color.g : 0, b: color ? color.b : 0 },
      opacity: ctl.placeholder ? 0.55 : (color ? color.a : 1),
    }];
    /* 多行控件：按浏览器折行逐行成记录，两条出口都不会再自己折一次 */
    const wrapped = multi ? wrapControlText(el, cs, ctx, Math.max(1, box.w - bl - br - pl - prr)) : null;
    if (wrapped && wrapped.length) {
      for (const ln of wrapped) {
        if (!ln.text) continue;
        children.push({
          t: 'text',
          name: ln.text.trim().slice(0, 40) || ' ',
          x: bl + pl,
          y: snapLocal(box.y, bt + pt + ln.top),
          w: Math.max(1, box.w - bl - br - pl - prr),
          h: Math.max(1, ln.h || (box.h - bt - bb - pt - pb)),
          fills: fillsFor,
          opacity: opacity,
          text: Object.assign(textStyleOf(cs, ln.text), {
            characters: ln.text,
            autosize: 'W',
            valign: 'TOP',
            align: align,
          }),
        });
      }
    } else {
      children.push({
        t: 'text',
        name: ctl.text.slice(0, 40),
        x: bl + pl,
        y: snapLocal(box.y, bt + pt),
        w: Math.max(1, box.w - bl - br - pl - prr),
        h: Math.max(1, box.h - bt - bb - pt - pb),
        fills: fillsFor,
        opacity: opacity,
        text: Object.assign(style, {
          characters: ctl.text,
          autosize: multi ? 'H' : 'N',
          valign: multi ? 'TOP' : 'CENTER',
          align: align,
        }),
      });
    }
  }

  /* 原生控件的系统绘制（复选框的勾、单选的点、取色块、滑块） */
  if (isForm && !hidden) {
    const nat = nativeControlRecords(el, cs, box, ctx);
    if (nat.length) children.push.apply(children, nat);
  }

  /* 多选下拉的每一行 option：文本落在自己那一行的左内缩处，垂直居中。
     选中行的底色（Chrome 的选中高亮）已经随 option 自己的盒子填好了，
     文字颜色也直接取 computed color（选中行 Chrome 会给浅色）。 */
  if (tag === 'option' && !hidden && box.w > 1 && box.h > 1) {
    const label = String(el.textContent || '').trim();
    if (label) {
      const oc = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      /* Chrome 的 option 文本：实测墨迹从「select 左沿 +16px」开始，
         option 盒子本身从 +12px 起，所以行内再缩 2px（不是 4px ——
         CJK 字形在 SVG 里的起始侧承重会让墨迹再偏 1~2px）。
         垂直方向同样按实测抬 1px。 */
      const inset = 2;
      children.push({
        t: 'text',
        name: label.slice(0, 40),
        x: inset,
        y: snapLocal(box.y, 0),
        w: Math.max(1, box.w - inset),
        h: Math.max(1, box.h),
        fills: [{ type: 'SOLID', color: { r: oc.r, g: oc.g, b: oc.b }, opacity: oc.a }],
        opacity: opacity,
        text: Object.assign(textStyleOf(cs, label), {
          characters: label,
          autosize: 'N',
          valign: 'CENTER',
          align: 'LEFT',
        }),
      });
    }
  }

  /* 视觉属性 */
  const fills = hidden ? [] : buildFills(el, cs, box, ctx);
  if ((isImg || isCanvas || isVideo) && !hidden) {
    let ref = null;
    if (isImg) {
      const src = el.currentSrc || el.src || '';
      if (src && el.naturalWidth > 0) {
        ref = registerImage(src, ctx);
      } else if (src) {
        ctx.warn('图片未加载成功：' + (src.length > 80 ? src.slice(0, 80) + '…' : src));
      }
    } else if (isCanvas) {
      ref = rasterize(el, ctx, 'canvas');
    } else if (isVideo) {
      ref = rasterize(el, ctx, 'video');
      if (!ref && el.poster) ref = registerImage(el.poster, ctx);
    }
    if (ref) {
      const paint = { type: 'IMAGE_REF', ref: ref, scaleMode: isImg ? imageScaleMode(cs, ctx, el) : 'FILL' };
      /* 记录原始像素尺寸：<img> 的 object-fit:none 与「平铺」两条路都要用自然尺寸，
         Figma 侧不需要（它的 CROP/TILE 自己知道图片多大），但 SVG 侧需要 */
      if (isImg && el.naturalWidth > 0 && el.naturalHeight > 0) {
        paint.natural = { w: el.naturalWidth, h: el.naturalHeight };
      }
      fills.push(paint);
    }
  }

  const strokeInfo = hidden ? { strokes: null, weights: null, dash: null, overlays: [] } : buildStrokes(el, cs, box, ctx);

  const radius = [
    num(cs.borderTopLeftRadius, 0),
    num(cs.borderTopRightRadius, 0),
    num(cs.borderBottomRightRadius, 0),
    num(cs.borderBottomLeftRadius, 0),
  ];

  const effects = hidden ? [] : (parseShadowList(cs.boxShadow, ctx.opts.shadowScale).concat(parseFilterEffects(cs, ctx.opts.shadowScale, null)));

  const overflowX = cs.overflowX || cs.overflow;
  const overflowY = cs.overflowY || cs.overflow;
  const clips = children.length > 0 && (overflowX !== 'visible' || overflowY !== 'visible');

  /* 伪元素（::before 在最底层，::after 在最上层） */
  if (!hidden && !isSvg && !isImg && !isCanvas && !isVideo) {
    const pr = pseudoRecords(el, cs, box, ctx);
    if (pr.length) children.push.apply(children, pr);
  }

  /* 四边异色边框：拆成矩形压在内容之上。
     虚线/点线的边不能画成实心矩形（那是「实线」），改成**带 dashPattern 的单边描边**：
     Figma 侧走 strokeTop/Right/Bottom/LeftWeight + dashPattern，SVG 侧走 stroke-dasharray，
     两边都能画出真正的虚线。 */
  if (strokeInfo.overlays && strokeInfo.overlays.length) {
    for (const o of strokeInfo.overlays) {
      const radiusFor = o.side === 'top' ? [radius[0], radius[1], 0, 0]
        : o.side === 'right' ? [0, radius[1], radius[2], 0]
          : o.side === 'bottom' ? [0, 0, radius[2], radius[3]]
            : [radius[0], 0, 0, radius[3]];
      const color = { r: o.color.r, g: o.color.g, b: o.color.b };
      if (o.dash && o.dash.length) {
        children.push({
          t: 'rect',
          name: '__border-' + o.side,
          x: o.x,
          y: o.y,
          w: o.w,
          h: o.h,
          fills: [],
          strokes: [{ type: 'SOLID', color: color, opacity: o.color.a }],
          strokeWeights: o.side === 'top' ? [o.h, 0, 0, 0]
            : o.side === 'right' ? [0, o.w, 0, 0]
              : o.side === 'bottom' ? [0, 0, o.h, 0]
                : [0, 0, 0, o.w],
          dash: o.dash,
          radius: radiusFor,
        });
        continue;
      }
      children.push({
        t: 'rect',
        name: '__border-' + o.side,
        x: o.x,
        y: o.y,
        w: o.w,
        h: o.h,
        fills: [{ type: 'SOLID', color: color, opacity: o.color.a }],
        radius: radiusFor,
      });
    }
  }

  ctx.stats.elements++;
  const rec = {
    t: (isSvg) ? 'svg' : (children.length ? 'frame' : 'rect'),
    name: describe(el) + (isImg ? ' · 图片' : ''),
    x: box.x - parentAbs.x,
    y: box.y - parentAbs.y,
    w: w,
    h: h,
    fills: fills,
    strokes: strokeInfo.strokes,
    strokeWeights: strokeInfo.weights,
    dash: strokeInfo.dash,
    radius: radius,
    effects: effects,
    opacity: opacity,
    clips: clips,
    rotation: rotation,
    children: children,
    _abs: { x: box.x, y: box.y, w: box.w, h: box.h },
    _self: el,
  };

  if (isSvg) {
    rec.svg = serializeSvg(el, ctx);
    rec.children = [];
  }

  /* 旋转过的元素：x/y/宽高分别是「包围盒左上角」与「未变换尺寸」，
     两者不是同一个盒子，SVG 路线需要包围盒尺寸才能算出正确的旋转中心 */
  if (rec.rotation) rec.rotBox = { w: box.w, h: box.h };

  if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') rec.blendMode = blendModeOf(cs.mixBlendMode);
  if (cs.writingMode && /vertical/.test(cs.writingMode)) ctx.warn('竖排文本(writing-mode)暂不支持：' + describe(el));
  if (cs.clipPath && cs.clipPath !== 'none') ctx.warn('clip-path 裁剪暂不支持：' + describe(el));
  if (cs.maskImage && cs.maskImage !== 'none') ctx.warn('mask 遮罩暂不支持：' + describe(el));

  return [rec];
}

const BLEND_MODES = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY',
  darken: 'DARKEN', lighten: 'LIGHTEN', 'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN',
  'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT', difference: 'DIFFERENCE', exclusion: 'EXCLUSION',
  hue: 'HUE', saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

function blendModeOf(v) { return BLEND_MODES[String(v).toLowerCase()] || null; }

/* ------------------------------ SVG 序列化 ------------------------------ */

function serializeSvg(el, ctx) {
  try {
    const clone = el.cloneNode(true);
    const src = el.querySelectorAll('*');
    const dst = clone.querySelectorAll('*');
    const attrs = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
      'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'font-size',
      'font-family', 'font-weight', 'text-anchor', 'stop-color', 'stop-opacity', 'visibility', 'display'];
    for (let i = 0; i < src.length; i++) {
      let s;
      try { s = ctx.win.getComputedStyle(src[i]); } catch (e) { continue; }
      if (!s) continue;
      for (const a of attrs) {
        const v = s.getPropertyValue(a);
        if (v && v !== 'none' || a === 'fill' || a === 'stroke') {
          if (v) dst[i].setAttribute(a, v);
        }
      }
    }
    const rect = el.getBoundingClientRect();
    if (!clone.getAttribute('viewBox') && rect.width > 0 && rect.height > 0) {
      clone.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
    }
    clone.setAttribute('width', String(Math.max(rect.width, 1)));
    clone.setAttribute('height', String(Math.max(rect.height, 1)));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const xml = new XMLSerializer().serializeToString(clone);
    return xml;
  } catch (e) {
    return null;
  }
}

/* ------------------------------ z-index 排序 ---------------------------- */

function sortByZ(children, elMap) {
  /* CSS 的真实绘制顺序：先「流内非定位」元素，再「定位」元素（absolute / fixed），
     同一层里才看 z-index，同 z 保持 DOM 顺序。

     以前只比 z-index，于是绝对定位的浮层会被**后来的流内元素**盖住 ——
     MD3 filled text field 的浮动标签就是这么丢的（input 的背景盖在它上面）。
     角标、覆盖层、伪元素挂角都有同样的问题。 */
  const infoOf = (r) => (r._self && elMap.get(r._self)) || null;
  const layerOf = (r) => {
    const info = infoOf(r);
    const z = info ? info.z : 0;
    if (z > 0) return 2;
    return (info && info.pos) ? 1 : 0;
  };
  const zOf = (r) => { const info = infoOf(r); return info ? info.z : 0; };
  return children
    .map((r, idx) => ({ r: r, i: idx }))
    .sort((a, b) => {
      const la = layerOf(a.r);
      const lb = layerOf(b.r);
      if (la !== lb) return la - lb;
      const za = zOf(a.r);
      const zb = zOf(b.r);
      if (za !== zb) return za - zb;
      return a.i - b.i;
    })
    .map((x) => x.r);
}


/* ------------------------------- 生成快照 ------------------------------- */

function capture(stage, opts) {
  const ctx = createCtx(stage, opts);
  ctx.opts.hostElement = stage.contentRoot;

  const hostCs = (() => { try { return ctx.win.getComputedStyle(stage.host); } catch (e) { return null; } })();
  const bodyCs = (() => { try { return ctx.win.getComputedStyle(stage.contentRoot); } catch (e) { return null; } })();

  let rootFillColor = null;
  if (hostCs) {
    const hb = parseColor(hostCs.backgroundColor);
    if (hb && hb.a > 0.002) rootFillColor = { type: 'SOLID', color: { r: hb.r, g: hb.g, b: hb.b }, opacity: hb.a };
  }
  if (!rootFillColor && bodyCs) {
    const bb = parseColor(bodyCs.backgroundColor);
    if (bb && bb.a > 0.002) {
      rootFillColor = { type: 'SOLID', color: { r: bb.r, g: bb.g, b: bb.b }, opacity: bb.a };
      /* 背景已提升到画布，body 自身不再重复绘制（与 CSS 传播规则一致） */
      ctx.suppressBodyFill = true;
    }
  }

  const top = [];
  const hostChildren = stage.host.children;
  for (let i = 0; i < hostChildren.length; i++) {
    const ch = hostChildren[i];
    if (ch.tagName === 'HEAD') continue;
    top.push.apply(top, walkElement(ch, { x: 0, y: 0 }, ctx));
  }

  /* 记录 z-index（同层排序用） */
  const zMap = new Map();
  (function collectZ(el) {
    let cs = null;
    try { cs = ctx.win.getComputedStyle(el); } catch (e) { cs = null; }
    if (cs) {
      /* 定位元素即使 z-index 是 auto 也要记：它默认绘制在流内元素之上。
         只记非 auto 的 z-index 会漏掉这一整类。 */
      const raw = (cs.zIndex && cs.zIndex !== 'auto') ? parseInt(cs.zIndex, 10) : 0;
      const z = isFinite(raw) ? raw : 0;
      const pos = (cs.position === 'absolute' || cs.position === 'fixed');
      if (pos || z !== 0) zMap.set(el, { z: z, pos: pos });
    }
    for (let i = 0; i < el.children.length; i++) collectZ(el.children[i]);
  })(stage.host);
  (function applyZ(list) {
    for (const r of list) {
      if (r._self && zMap.has(r._self)) {
        const zi = zMap.get(r._self);
        r._z = zi.z;
        r._pos = zi.pos;
      }
      if (r.children && r.children.length) {
        if (opts.zIndexSort) r.children = sortByZ(r.children, zMap);
        applyZ(r.children);
      }
    }
  })(top);

  /* body 去重 */
  if (ctx.suppressBodyFill) {
    (function strip(list) {
      for (const r of list) {
        if (r._self === stage.contentRoot) r.fills = [];
        if (r.children) strip(r.children);
      }
    })(top);
  }

  /* 裁剪范围 */
  let ox = 0;
  let oy = 0;
  let rw = 0;
  let rh = 0;
  if (opts.cropMode === 'viewport') {
    /* 一屏：App / 手机页通常一屏一稿，滚出首屏的内容不要 */
    ox = 0;
    oy = 0;
    const w0 = opts.viewportWidth || (stage.win && stage.win.innerWidth) || 360;
    const h0 = opts.viewportHeight || (stage.win && stage.win.innerHeight) || 800;
    rw = Math.max(1, Math.round(w0));
    rh = Math.max(1, Math.round(h0));
  } else if (opts.cropMode === 'document') {
    const hostRect = stage.host.getBoundingClientRect();
    ox = hostRect.left + ctx.scrollX;
    oy = hostRect.top + ctx.scrollY;
    rw = Math.max(stage.doc.documentElement ? stage.doc.documentElement.scrollWidth : stage.host.scrollWidth, stage.host.scrollWidth);
    rh = Math.max(stage.doc.documentElement ? stage.doc.documentElement.scrollHeight : stage.host.scrollHeight, stage.host.scrollHeight);
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of top) {
      if (!r._abs) continue;
      minX = Math.min(minX, r._abs.x);
      minY = Math.min(minY, r._abs.y);
      maxX = Math.max(maxX, r._abs.x + r._abs.w);
      maxY = Math.max(maxY, r._abs.y + r._abs.h);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    ox = Math.floor(minX);
    oy = Math.floor(minY);
    rw = Math.max(1, Math.ceil(maxX) - ox);
    rh = Math.max(1, Math.ceil(maxY) - oy);
  }

  /* 平移到裁剪原点：只平移「顶层」记录。
     子节点坐标是相对父节点的，递归相减会把原点重复扣除 N 次（N=深度），
     页面内容从 x/y=0 开始时恰好看不出问题，一旦有居中留白就会整体跑飞。 */
  for (const r of top) {
    r.x = r.x - ox;
    r.y = r.y - oy;
  }
  (function cleanTmp(list) {
    for (const r of list) {
      /* _abs 是引擎自己量到的绝对盒子，_self 是 DOM 引用。
         _self 必须删（DOM 节点不能 postMessage）；_abs 默认也删（payload 要发给
         Figma 主线程，能省则省），但精度体检要拿它验证
         「相对坐标链式累加 == 绝对坐标」，所以留一个开关：opts.keepAbs。
         注意 _abs 也要跟着裁剪原点一起平移 —— 只平移顶层会让子记录的 _abs 停在平移前，
         链式累加永远对不上（体检会报一堆假偏差）。 */
      if (r._abs) { r._abs.x -= ox; r._abs.y -= oy; }
      if (!opts.keepAbs) delete r._abs;
      delete r._self;
      delete r._z;
      if (r.children && r.children.length) cleanTmp(r.children);
    }
  })(top);

  return {
    meta: {
      title: (stage.doc.title || '').trim() || 'HTML 快照',
      url: opts.sourceUrl || '',
      w: rw,
      h: rh,
      clips: opts.cropMode === 'document',
      rootFill: rootFillColor,
      maxNodes: opts.maxNodes,
    },
    root: { t: 'frame', name: 'HTML 快照', x: 0, y: 0, w: rw, h: rh, fills: [], children: top },
    images: ctx.imageList,
    stats: ctx.stats,
    warnings: ctx.warnings.concat(stage.fallbackNote ? [stage.fallbackNote] : []),
  };
}


/* ============================== 模块导出 ================================ */
/* 新增模块（vfs / interactions / flow）与测试从这里取引擎能力。
   经典脚本加载下这些函数本来就是全局的，导出只是给新代码一个稳定入口。 */
window.H2FEngine = {
  state: state,
  makeStage: makeStage,
  buildDocument: buildDocument,
  loadStage: loadStage,
  settleStage: settleStage,
  capture: capture,
  parseColor: parseColor,
  clamp: clamp,
  num: num,
  delay: delay,
  splitTop: splitTop,
  describe: describe,
};
