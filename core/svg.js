/* ============================================================================
 * 快照 → SVG 渲染器
 *
 * 输入：ui.js 的 capture() 快照（与 Figma 插件主线程用的是同一份数据）
 * 输出：一个自带内嵌图片、扁平结构的 SVG 字符串，可直接拖进 Figma 网页版画布
 *
 * 设计取舍：
 *  - 默认「扁平」：不使用嵌套 <g> 表达层级，所有形状带绝对坐标，导入 Figma 后
 *    是一堆平铺的矢量图层，而不是层层套娃的空组。
 *  - 只有在旋转 / 裁剪 / 透明度 / 混合模式这些「必须成组」的场景才产生 <g>。
 *  - 对齐方式依赖 SVG 的 text-anchor，baseline 用 canvas 字体度量算出来，
 *    这样文本落点和浏览器里一致。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------- 基础工具 ------------------------------- */

  function f(n) {
    const v = Math.round((n || 0) * 1000) / 1000;
    return Object.is(v, -0) ? '0' : String(v);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hex(c) {
    const h = (v) => {
      const n = Math.max(0, Math.min(255, Math.round((v || 0) * 255)));
      return (n < 16 ? '0' : '') + n.toString(16);
    };
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  function opacityOf(p) { return p && p.opacity != null ? p.opacity : 1; }

  const BLEND_CSS = {
    MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten',
    COLOR_DODGE: 'color-dodge', COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light',
    DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation',
    COLOR: 'color', LUMINOSITY: 'luminosity',
  };

  /* ----------------------------- 字体度量缓存 ----------------------------- */

  const FONT_CTX = document.createElement('canvas').getContext('2d');
  const METRIC_CACHE = new Map();

  function cssFamilies(families) {
    return (families && families.length ? families : ['sans-serif']).map((n) => {
      const name = String(n).trim();
      if (!name) return 'sans-serif';
      return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(name) ? name : '"' + name.replace(/"/g, '') + '"';
    }).join(', ');
  }

  /** 用 canvas 量同一字体的 ascent/descent，用来把 CSS 行盒换算成 baseline */
  function metrics(spec) {
    const key = [spec.fontSize, spec.weight || 400, spec.italic ? 1 : 0, cssFamilies(spec.families)].join('|');
    const hit = METRIC_CACHE.get(key);
    if (hit) return hit;
    let ascent = spec.fontSize * 0.8;
    let descent = spec.fontSize * 0.2;
    try {
      FONT_CTX.font = (spec.italic ? 'italic ' : '') + (spec.weight || 400) + ' ' + spec.fontSize + 'px ' + cssFamilies(spec.families);
      const tm = FONT_CTX.measureText('Hg中');
      if (isFinite(tm.fontBoundingBoxAscent) && tm.fontBoundingBoxAscent > 0) ascent = tm.fontBoundingBoxAscent;
      if (isFinite(tm.fontBoundingBoxDescent) && tm.fontBoundingBoxDescent >= 0) descent = tm.fontBoundingBoxDescent;
    } catch (e) { /* 用兜底值 */ }
    const m = { ascent: ascent, descent: descent, contentH: ascent + descent };
    METRIC_CACHE.set(key, m);
    return m;
  }

  /* --------------------------------- 路径 --------------------------------- */

  function roundRectPath(x, y, w, h, r) {
    const tl = Math.max(0, Math.min(r[0], w / 2, h / 2));
    const tr = Math.max(0, Math.min(r[1], w / 2, h / 2));
    const br = Math.max(0, Math.min(r[2], w / 2, h / 2));
    const bl = Math.max(0, Math.min(r[3], w / 2, h / 2));
    const x1 = x + w;
    const y1 = y + h;
    const p = [];
    p.push('M' + f(x + tl) + ' ' + f(y));
    p.push('H' + f(x1 - tr));
    if (tr) p.push('A' + f(tr) + ' ' + f(tr) + ' 0 0 1 ' + f(x1) + ' ' + f(y + tr));
    p.push('V' + f(y1 - br));
    if (br) p.push('A' + f(br) + ' ' + f(br) + ' 0 0 1 ' + f(x1 - br) + ' ' + f(y1));
    p.push('H' + f(x + bl));
    if (bl) p.push('A' + f(bl) + ' ' + f(bl) + ' 0 0 1 ' + f(x) + ' ' + f(y1 - bl));
    p.push('V' + f(y + tl));
    if (tl) p.push('A' + f(tl) + ' ' + f(tl) + ' 0 0 1 ' + f(x + tl) + ' ' + f(y));
    p.push('Z');
    return p.join(' ');
  }

  /* ------------------------------ 渲染会话状态 ---------------------------- */

  function Session(imageMap, opts) {
    this.defs = [];
    this.images = imageMap || new Map();
    this.opts = opts || {};
    this.uid = 0;
    this.warnings = [];
    this.counts = { rect: 0, path: 0, text: 0, image: 0, group: 0, gradient: 0, filter: 0, svg: 0, clip: 0 };
    this._seenWarn = new Set();
  }

  Session.prototype.warn = function (msg) {
    if (this._seenWarn.has(msg) || this.warnings.length > 200) return;
    this._seenWarn.add(msg);
    this.warnings.push(msg);
  };

  Session.prototype.id = function (prefix) {
    this.uid++;
    return 'h2f' + prefix + this.uid;
  };

  /** 生成形状：圆角一致用 <rect>，逐角不同用 <path> */
  Session.prototype.shape = function (x, y, w, h, radius, attrs) {
    const r = radius && radius.length === 4 ? radius : [0, 0, 0, 0];
    const uniform = Math.abs(r[0] - r[1]) < 0.01 && Math.abs(r[1] - r[2]) < 0.01 && Math.abs(r[2] - r[3]) < 0.01;
    const lim = Math.min(w, h) / 2;
    const a = attrs ? ' ' + attrs : '';
    if (uniform) {
      const rr = Math.max(0, Math.min(r[0], lim));
      this.counts.rect++;
      return '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) + '"'
        + (rr > 0.01 ? ' rx="' + f(rr) + '" ry="' + f(rr) + '"' : '') + a + '/>';
    }
    this.counts.path++;
    return '<path d="' + roundRectPath(x, y, w, h, r) + '"' + a + '/>';
  };

  /* -------------------------------- 渐变 def ------------------------------ */

  Session.prototype.gradientDef = function (paint, w, h) {
    const id = this.id('g');
    const stops = (paint.gradientStops || []).map((s) => {
      const op = s.color.a == null ? 1 : s.color.a;
      return '<stop offset="' + f(Math.max(0, Math.min(1, s.position)) * 100) + '%" stop-color="' + hex(s.color) + '"'
        + (op < 1 ? ' stop-opacity="' + f(op) + '"' : '') + '/>';
    }).join('');

    /* 渐变可能只画在元素里的一小块（background-size + background-position）：
       原始矩阵按「小框」算，再把坐标整体平移到小框的位置。
       反解公式只对整框渐变成立，所以这里必须用 gradientTransformBase 而不是
       烘过子矩形的 gradientTransform（那个是给 Figma 用的）。 */
    const box = paint.gradientBox || null;
    const base = (box && paint.gradientTransformBase) ? paint.gradientTransformBase : paint.gradientTransform;
    const gw = box ? box.w : w;
    const gh = box ? box.h : h;
    const ox = box ? box.x : 0;
    const oy = box ? box.y : 0;

    if (paint.type === 'GRADIENT_LINEAR') {
      const t = base || [[1, 0, 0], [0, 1, 0]];
      const a = t[0][0], b = t[0][1], e = t[0][2];
      /* t = a*u + b*v + e（u,v 为单位正方形坐标）→ 换算成像素空间的起点/终点 */
      const dx = a / (gw || 1), dy = b / (gh || 1);
      const len = Math.hypot(dx, dy);
      let x0 = 0, y0 = gh / 2, x1 = gw, y1 = gh / 2;
      if (len > 1e-9) {
        const ux = dx / len, uy = dy / len;
        const L = 1 / len;
        const tc = a * 0.5 + b * 0.5 + e;
        x0 = gw / 2 - ux * tc * L; y0 = gh / 2 - uy * tc * L;
        x1 = gw / 2 + ux * (1 - tc) * L; y1 = gh / 2 + uy * (1 - tc) * L;
      }
      this.defs.push('<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + f(x0 + ox) + '" y1="' + f(y0 + oy)
        + '" x2="' + f(x1 + ox) + '" y2="' + f(y1 + oy) + '">' + stops + '</linearGradient>');
      this.counts.gradient++;
      return id;
    }

    /* 径向：用单位圆 + matrix 表达椭圆，中心与半径由 Figma transform 反解 */
    const t = base || [[1, 0, 0], [0, 1, 0]];
    const sx = t[0][0] || 1, sy = t[1][1] || 1, e = t[0][2] || 0, ff = t[1][2] || 0;
    const cx = (0.5 - e) / sx * gw + ox;
    const cy = (0.5 - ff) / sy * gh + oy;
    const rx = sx > 0 ? gw / (2 * sx) : gw / 2;
    const ry = sy > 0 ? gh / (2 * sy) : gh / 2;
    this.defs.push('<radialGradient id="' + id + '" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix('
      + f(rx) + ' 0 0 ' + f(ry) + ' ' + f(cx) + ' ' + f(cy) + ')">' + stops + '</radialGradient>');
    this.counts.gradient++;
    return id;
  };

  /* -------------------------------- 滤镜 def ------------------------------ */

  Session.prototype.filterDef = function (effects) {
    const parts = [];
    let dropped = 0;
    for (const fx of effects || []) {
      if (!fx || fx.visible === false) continue;
      if (fx.type === 'DROP_SHADOW') {
        parts.push('<feDropShadow dx="' + f(fx.offset ? fx.offset.x : 0) + '" dy="' + f(fx.offset ? fx.offset.y : 0)
          + '" stdDeviation="' + f(Math.max(0, (fx.radius || 0) / 2)) + '" flood-color="' + hex(fx.color || { r: 0, g: 0, b: 0 })
          + '" flood-opacity="' + f(fx.color && fx.color.a != null ? fx.color.a : 0.25) + '"/>');
        if (fx.spread) dropped++;
      } else if (fx.type === 'LAYER_BLUR') {
        parts.push('<feGaussianBlur stdDeviation="' + f(Math.max(0, (fx.radius || 0) / 2)) + '"/>');
      } else if (fx.type === 'INNER_SHADOW') {
        dropped++;
      } else if (fx.type === 'BACKGROUND_BLUR') {
        dropped++;
      }
    }
    if (dropped) this.warn('SVG 不支持内阴影 / 背景模糊 / 阴影扩散，已省略 ' + dropped + ' 处效果');
    if (!parts.length) return null;
    const id = this.id('fx');
    this.defs.push('<filter id="' + id + '" x="-60%" y="-60%" width="220%" height="220%">' + parts.join('') + '</filter>');
    this.counts.filter++;
    return id;
  };

  /* -------------------------------- 填充 -------------------------------- */

  Session.prototype.fillShapes = function (rec, x, y, w, h, extra) {
    const out = [];
    const radius = rec.radius || [0, 0, 0, 0];
    const tf = 'transform="translate(' + f(x) + ' ' + f(y) + ')"';
    const attrs = extra ? tf + ' ' + extra : tf;
    let hasRadius = radius.some((v) => v > 0.01);
    const fills = rec.fills || [];
    let solidIdx = 0;

    for (const p of fills) {
      if (!p) continue;
      if (p.type === 'SOLID') {
        solidIdx++;
        const op = opacityOf(p);
        out.push(this.shape(0, 0, w, h, radius,
          attrs + ' fill="' + hex(p.color) + '"' + (op < 1 ? ' fill-opacity="' + f(op) + '"' : '')));
      } else if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
        const gid = this.gradientDef(p, w, h);
        let shape = this.shape(0, 0, w, h, radius, attrs + ' fill="url(#' + gid + ')"');
        if (p.gradientBox) {
          /* CSS 里的小尺寸渐变（background-size）只画在那个小框内，
             而 SVG 渐变默认把端色 pad 到整个形状 —— 不裁的话，
             一个 5×5 的下拉箭头会铺满整个控件。 */
          const cid = this.id('clip');
          const b = p.gradientBox;
          this.defs.push('<clipPath id="' + cid + '">'
            + this.shape(b.x, b.y, Math.max(0.01, b.w), Math.max(0.01, b.h), [0, 0, 0, 0], '') + '</clipPath>');
          shape = '<g clip-path="url(#' + cid + ')">' + shape + '</g>';
          this.counts.clip++;
        }
        out.push(shape);
      } else if (p.type === 'IMAGE_REF') {
        const href = this.images.get(p.ref);
        if (!href) {
          this.warn('图片未能内嵌，已用灰底占位：' + (p.ref || ''));
          out.push(this.shape(0, 0, w, h, radius, attrs + ' fill="#e6e8ec"'));
          continue;
        }
        /* scaleMode 的语义要和 Figma 对齐（engine 侧：cover→FILL、contain→FIT、
           自然像素尺寸→CROP、平铺→TILE）：
             FILL = cover   → slice
             FIT  = contain → meet
             CROP = 原始像素尺寸（object-fit:none）→ 按自然尺寸画、居中、裁到盒子里
             TILE = 平铺    → pattern
           以前 FILL 落到 'none'（拉伸）：带背景图的卡片会被横向拉扁，
           这是最显眼的一类失真（uikit 首页的图片卡实测就是这样）。 */
        const nat = (p.natural && p.natural.w > 0 && p.natural.h > 0) ? p.natural : null;
        const needClip = hasRadius || (p.scaleMode === 'CROP' && nat);
        let clip = '';
        if (needClip) {
          const cid = this.id('clip');
          this.defs.push('<clipPath id="' + cid + '">' + this.shape(0, 0, w, h, radius, '') + '</clipPath>');
          clip = ' clip-path="url(#' + cid + ')"';
          this.counts.clip++;
        }
        this.counts.image++;
        if (p.scaleMode === 'TILE' && nat) {
          const pid = this.id('pat');
          this.defs.push('<pattern id="' + pid + '" patternUnits="userSpaceOnUse" width="' + f(nat.w) + '" height="' + f(nat.h) + '">'
            + '<image x="0" y="0" width="' + f(nat.w) + '" height="' + f(nat.h) + '" preserveAspectRatio="none"'
            + ' href="' + esc(href) + '" xlink:href="' + esc(href) + '"/></pattern>');
          out.push(this.shape(0, 0, w, h, radius, attrs + ' fill="url(#' + pid + ')"'));
        } else if (p.scaleMode === 'CROP' && nat) {
          out.push('<image x="' + f((w - nat.w) / 2) + '" y="' + f((h - nat.h) / 2) + '" width="' + f(nat.w)
            + '" height="' + f(nat.h) + '" preserveAspectRatio="none" href="' + esc(href)
            + '" xlink:href="' + esc(href) + '"' + clip + ' ' + attrs + '/>');
        } else {
          const par = p.scaleMode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice';
          out.push('<image x="0" y="0" width="' + f(w) + '" height="' + f(h) + '" preserveAspectRatio="' + par + '"'
            + ' href="' + esc(href) + '" xlink:href="' + esc(href) + '"' + clip + ' ' + attrs + '/>');
        }
      }
    }
    void solidIdx;
    return out;
  };

  /* -------------------------------- 描边 -------------------------------- */

  Session.prototype.borderShapes = function (rec, x, y, w, h, extra) {
    const strokes = rec.strokes;
    if (!strokes || !strokes.length) return [];
    const p = strokes[0];
    if (!p || p.type !== 'SOLID') return [];
    const col = hex(p.color);
    const op = opacityOf(p);
    const paint = ' fill="' + col + '"' + (op < 1 ? ' fill-opacity="' + f(op) + '"' : '');
    const radius = rec.radius || [0, 0, 0, 0];
    const W = rec.strokeWeights;
    const tf = 'transform="translate(' + f(x) + ' ' + f(y) + ')"';
    const attrs = extra ? tf + ' ' + extra : tf;

    /* 四边等宽：等价于居中的 stroke 画在内缩半个线宽的矩形上（CSS 的 border 是画在内侧） */
    if (typeof W === 'number' && W > 0) {
      const inset = W / 2;
      const iw = Math.max(w - W, 0.01);
      const ih = Math.max(h - W, 0.01);
      const ir = radius.map((v) => Math.max(0, v - inset));
      const dash = rec.dash && rec.dash.length ? ' stroke-dasharray="' + rec.dash.map(f).join(' ') + '"' : '';
      return ['<g ' + attrs + '>'
        + this.shape(inset, inset, iw, ih, ir,
          'fill="none" stroke="' + col + '" stroke-width="' + f(W) + '"'
          + (op < 1 ? ' stroke-opacity="' + f(op) + '"' : '') + dash)
        + '</g>'];
    }

    /* 四边不同宽：拆成条形矩形，接缝按 CSS 的对接方式留白。
       虚线/点线（带 dash）不能画实心矩形 —— 改成一条带 stroke-dasharray 的线，
       线宽就是这一边的边框宽度，位置落在这一边的中线上。 */
    if (W && W.length === 4) {
      const t = W[0] || 0, r = W[1] || 0, b = W[2] || 0, l = W[3] || 0;
      const out = ['<g ' + attrs + '>'];
      const dash = rec.dash && rec.dash.length ? ' stroke-dasharray="' + rec.dash.map(f).join(' ') + '"' : '';
      if (dash) {
        const stroke = ' stroke="' + col + '"' + (op < 1 ? ' stroke-opacity="' + f(op) + '"' : '') + dash;
        if (t > 0.01) out.push('<line x1="0" y1="' + f(t / 2) + '" x2="' + f(w) + '" y2="' + f(t / 2) + '" stroke-width="' + f(t) + '"' + stroke + '/>');
        if (b > 0.01) out.push('<line x1="0" y1="' + f(h - b / 2) + '" x2="' + f(w) + '" y2="' + f(h - b / 2) + '" stroke-width="' + f(b) + '"' + stroke + '/>');
        if (l > 0.01) out.push('<line x1="' + f(l / 2) + '" y1="0" x2="' + f(l / 2) + '" y2="' + f(h) + '" stroke-width="' + f(l) + '"' + stroke + '/>');
        if (r > 0.01) out.push('<line x1="' + f(w - r / 2) + '" y1="0" x2="' + f(w - r / 2) + '" y2="' + f(h) + '" stroke-width="' + f(r) + '"' + stroke + '/>');
        out.push('</g>');
        return out.length > 2 ? out : [];
      }
      if (t > 0.01) out.push(this.shape(l, 0, Math.max(w - l - r, 0.01), t, [radius[0], radius[1], 0, 0], paint));
      if (b > 0.01) out.push(this.shape(l, h - b, Math.max(w - l - r, 0.01), b, [0, 0, radius[2], radius[3]], paint));
      if (l > 0.01) out.push(this.shape(0, t, l, Math.max(h - t - b, 0.01), [radius[0], 0, 0, radius[3]], paint));
      if (r > 0.01) out.push(this.shape(w - r, t, r, Math.max(h - t - b, 0.01), [0, radius[1], radius[2], 0], paint));
      out.push('</g>');
      return out.length > 2 ? out : [];
    }
    return [];
  };

  /* -------------------------------- 文本 -------------------------------- */

  function applyTextCase(text, mode) {
    if (mode === 'UPPER') return text.toUpperCase();
    if (mode === 'LOWER') return text.toLowerCase();
    if (mode === 'TITLE') return text.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
    return text;
  }

  Session.prototype.textEl = function (rec, x, y, extra) {
    const spec = rec.text;
    const m = metrics(spec);
    const L = spec.lineHeight && spec.lineHeight > 0 ? spec.lineHeight : m.contentH;
    const chars = applyTextCase(String(spec.characters == null ? '' : spec.characters), spec.textCase);

    /* baseline：CSS 行盒 -> 字体基线 */
    let base;
    if (spec.autosize === 'N') {
      if (spec.valign === 'CENTER') base = (rec.h - m.contentH) / 2 + m.ascent;
      else if (spec.valign === 'BOTTOM') base = rec.h - m.descent;
      else base = m.ascent;
    } else {
      base = (L - m.contentH) / 2 + m.ascent;
    }

    const align = spec.align || 'LEFT';
    let ax = 0;
    let anchor = 'start';
    if (align === 'CENTER') { ax = rec.w / 2; anchor = 'middle'; }
    else if (align === 'RIGHT') { ax = rec.w; anchor = 'end'; }

    const attrs = [
      'transform="translate(' + f(x) + ' ' + f(y) + ')"',
      'font-family="' + esc(cssFamilies(spec.families)) + '"',
      'font-size="' + f(spec.fontSize || 16) + '"',
    ];
    if (spec.weight && spec.weight !== 400) attrs.push('font-weight="' + f(spec.weight) + '"');
    if (spec.italic) attrs.push('font-style="italic"');
    if (spec.letterSpacing) attrs.push('letter-spacing="' + f(spec.letterSpacing) + '"');
    if (anchor !== 'start') attrs.push('text-anchor="' + anchor + '"');
    if (spec.decoration === 'UNDERLINE') attrs.push('text-decoration="underline"');
    else if (spec.decoration === 'STRIKETHROUGH') attrs.push('text-decoration="line-through"');

    const fill = (rec.fills && rec.fills[0]) || { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 };
    attrs.push('fill="' + hex(fill.color) + '"');
    if (opacityOf(fill) < 1) attrs.push('fill-opacity="' + f(opacityOf(fill)) + '"');
    if (extra) attrs.push(extra);

    this.counts.text++;
    const lines = chars.split('\n');
    if (lines.length <= 1) {
      return '<text x="' + f(ax) + '" y="' + f(base) + '" ' + attrs.join(' ') + ' xml:space="preserve">' + esc(chars) + '</text>';
    }
    const spans = lines.map((ln, i) => '<tspan x="' + f(ax) + '"' + (i === 0 ? ' y="' + f(base) + '"' : ' dy="' + f(L) + '"')
      + '>' + (ln.length ? esc(ln) : ' ') + '</tspan>').join('');
    return '<text ' + attrs.join(' ') + ' xml:space="preserve">' + spans + '</text>';
  };

  /* ------------------------------ 内联 SVG ------------------------------- */

  Session.prototype.nestedSvg = function (rec, x, y, w, h) {
    try {
      const doc = new DOMParser().parseFromString(rec.svg, 'image/svg+xml');
      const root = doc.documentElement;
      if (!root || root.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
        this.warn('内联 SVG 无法解析，已跳过：' + (rec.name || ''));
        return null;
      }
      root.setAttribute('width', String(f(w)));
      root.setAttribute('height', String(f(h)));
      root.setAttribute('x', '0');
      root.setAttribute('y', '0');
      if (!root.getAttribute('preserveAspectRatio')) root.setAttribute('preserveAspectRatio', 'none');
      const xml = new XMLSerializer().serializeToString(root);
      this.counts.svg++;
      return '<g transform="translate(' + f(x) + ' ' + f(y) + ')">' + xml + '</g>';
    } catch (e) {
      this.warn('内联 SVG 处理失败，已跳过：' + (rec.name || ''));
      return null;
    }
  };

  /* ------------------------------ 递归渲染 ------------------------------- */

  function opacityBlend(rec) {
    const a = [];
    if (rec.opacity != null && rec.opacity < 1) a.push('opacity="' + f(rec.opacity) + '"');
    if (rec.blendMode && BLEND_CSS[rec.blendMode]) a.push('style="mix-blend-mode:' + BLEND_CSS[rec.blendMode] + '"');
    return a.join(' ');
  }

  function injectAttrs(tag, attrs) {
    if (!attrs) return tag;
    return tag.replace(/\/>$/, ' ' + attrs + '/>');
  }

  Session.prototype.emit = function (rec, ox, oy, out) {
    if (!rec) return;
    const x = ox + rec.x;
    const y = oy + rec.y;
    const w = Math.max(rec.w, 0.01);
    const h = Math.max(rec.h, 0.01);
    /* 旋转元素：rec.x/y 是「包围盒左上角」，rec.w/h 是「未变换尺寸」。
       形状必须画在未变换盒子的位置，再绕包围盒中心旋转，两者才重合。 */
    const rb = rec.rotBox || { w: w, h: h };
    const bx = x + (rb.w - w) / 2;
    const by = y + (rb.h - h) / 2;
    const cx = x + rb.w / 2;
    const cy = y + rb.h / 2;

    const kids = [];
    if (rec.children && rec.children.length) {
      for (const c of rec.children) this.emit(c, x, y, kids);
    }
    const hasKids = kids.length > 0;
    const wrapAttrs = opacityBlend(rec);

    /* 阴影/模糊：box-shadow 只作用于元素自身的盒子，所以挂在形状上而不是整组 */
    let fxAttr = '';
    if (rec.effects && rec.effects.length) {
      const fx = this.filterDef(rec.effects);
      if (fx) fxAttr = 'filter="url(#' + fx + ')"';
    }

    const self = [];
    if (rec.t === 'text') {
      let el = this.textEl(rec, bx, by, fxAttr);
      if (wrapAttrs) el = '<g ' + wrapAttrs + '>' + el + '</g>';
      out.push(el);
      return;
    }

    if (rec.t === 'svg' && rec.svg) {
      const n = this.nestedSvg(rec, bx, by, w, h);
      if (n) self.push(n);
    } else {
      const fills = this.fillShapes(rec, bx, by, w, h, '');
      const borders = this.borderShapes(rec, bx, by, w, h, '');
      self.push.apply(self, fills);
      self.push.apply(self, borders);
    }

    /* 只有一个形状且无子节点无旋转时，所有属性直接写在它身上，省掉一层组 */
    const single = !hasKids && !rec.rotation && self.length === 1;
    let content = self.join('');
    if (fxAttr && !single && content) content = '<g ' + fxAttr + '>' + content + '</g>';

    /* 自身形状绕包围盒中心旋转；子节点不参与——
       它们的位置已经是「父级旋转之后」的绝对坐标，再转一次会偏 */
    if (rec.rotation && content) {
      content = '<g transform="rotate(' + f(-rec.rotation) + ' ' + f(cx) + ' ' + f(cy) + ')">' + content + '</g>';
      if (hasKids) this.warn('旋转容器(<' + (rec.name || '?') + '>)内的子元素位置正确但没有继承旋转角度，属 SVG 路线限制');
    }

    if (hasKids) {
      let inner = kids.join('');
      if (rec.clips) {
        const cid = this.id('clip');
        this.defs.push('<clipPath id="' + cid + '" clipPathUnits="userSpaceOnUse">'
          + this.shape(x, y, rb.w, rb.h, rec.radius || [0, 0, 0, 0], '') + '</clipPath>');
        this.counts.clip++;
        inner = '<g clip-path="url(#' + cid + ')">' + inner + '</g>';
      }
      content += inner;
    }

    if (!content) return;

    if (single) {
      content = injectAttrs(content, (wrapAttrs + ' ' + fxAttr).trim());
    } else if (wrapAttrs) {
      content = '<g ' + wrapAttrs + '>' + content + '</g>';
    }
    out.push(content);
  };

  /* -------------------------------- 入口 --------------------------------- */

  function build(payload, imageMap, opts) {
    const s = new Session(imageMap, opts);
    const w = Math.max(payload.meta.w, 1);
    const h = Math.max(payload.meta.h, 1);
    const body = [];

    const rf = payload.meta.rootFill;
    if (rf && rf.type === 'SOLID') {
      body.push('<rect width="' + f(w) + '" height="' + f(h) + '" fill="' + hex(rf.color) + '"'
        + (opacityOf(rf) < 1 ? ' fill-opacity="' + f(opacityOf(rf)) + '"' : '') + '/>');
    }
    for (const c of (payload.root && payload.root.children) || []) s.emit(c, 0, 0, body);

    const svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
      + ' width="' + f(w) + '" height="' + f(h) + '" viewBox="0 0 ' + f(w) + ' ' + f(h) + '">'
      + (s.defs.length ? '<defs>' + s.defs.join('') + '</defs>' : '')
      + body.join('')
      + '</svg>';

    return { svg: svg, warnings: s.warnings, counts: s.counts, bytes: svg.length };
  }

  global.H2FSvg = {
    build: build,
    metrics: metrics,
    roundRectPath: roundRectPath,
    _session: Session,
  };
})(typeof window !== 'undefined' ? window : this);
