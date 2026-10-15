/* ============================================================================
 * core/lowfi.js — 低保真线框稿转换
 *
 * 把一份高保真快照（payload）转换成低保真线框稿：**整稿只由灰阶色块构成** ——
 * 文字变占位条，图片与图标变纯色块，阴影/渐变/混合模式/描边全部抹平，
 * 只留下结构与层级。不画任何描边，也不在图片上画交叉占位线。
 *
 * 关键设计：这是**快照层的变换**，不是新的渲染器。所以
 *   - 网页版：transform → core/svg.js  → 低保真 SVG
 *   - 插件端：transform → plugin/code.js → 低保真 Figma 图层
 * 两个出口自动共享同一套低保真规则，零重复实现。
 *
 * 纯逻辑（不碰 DOM、不碰 Figma），Node 里可直接单测。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* 三档灰 + 一档线：低保真稿只用这几档，避免看起来像「降饱和的高保真」 */
  const SKIN = {
    page: '#FFFFFF',      // 画板底
    block: '#EEF2F6',     // 浅块（浅色区域的填充）
    blockDeep: '#DDE3EA', // 深块（原本是深色/强调色的区域）
    bar: '#C7CDD6',       // 文字占位条
    ink: '#8A93A0',       // 保留文字时的字色
  };

  const DEFAULTS = {
    textMode: 'bars',      // bars：文字变占位条；keep：保留文字但灰化
    iconStyle: 'box',      // box：内联 svg 图标变纯色块；keep：原样保留 SVG
    keepRadius: true,      // 是否保留圆角（低保真里圆角通常无害）
    maxBarHeight: 12,      // 占位条最大高度
  };

  function hexToRgb(hex) {
    const h = String(hex).replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  }

  function solid(hex, opacity) {
    return { type: 'SOLID', color: hexToRgb(hex), opacity: opacity == null ? 1 : opacity };
  }

  /* 引擎协议里圆角是 [tl, tr, br, bl] 四元数组（svg.js 与 code.js 都按 length===4 读），
     这里统一归一化，避免低保真产出让渲染层炸掉 */
  function normRadius(v, keep) {
    if (!keep) return [0, 0, 0, 0];
    if (Array.isArray(v) && v.length === 4) return v.slice();
    if (v && typeof v === 'object') return [v.tl || 0, v.tr || 0, v.br || 0, v.bl || 0];
    return [0, 0, 0, 0];
  }

  function lumOf(color) {
    if (!color) return 1;
    return 0.2126 * (color.r || 0) + 0.7152 * (color.g || 0) + 0.0722 * (color.b || 0);
  }

  /* 引擎产出的图片填充是 IMAGE_REF（带 ref 字段）；IMAGE / imageHash 是另外的写法但一并认，
     这样插件出口与 SVG 出口拿到的是同一份判断 */
  function isImagePaint(paint) {
    if (!paint) return false;
    const t = String(paint.type || '');
    return t.indexOf('IMAGE') === 0 || paint.imageRef != null || paint.imageHash != null;
  }

  /** 任意填充 → 一档灰（保留「深色区域仍是深块」的层次感） */
  function grayPaint(paint) {
    if (!paint) return null;
    if (paint.type === 'SOLID' && paint.color) {
      const l = lumOf(paint.color);
      const hex = l < 0.45 ? SKIN.blockDeep : (l > 0.92 ? SKIN.page : SKIN.block);
      const op = paint.opacity == null ? 1 : paint.opacity;
      return solid(hex, op < 0.35 ? 0.35 : op);
    }
    /* 渐变 / 图片 / 其他 → 单色块 */
    return solid(SKIN.block, paint.opacity == null ? 1 : paint.opacity);
  }

  function convert(rec, o, isRoot) {
    if (!rec) return null;
    const out = {};
    for (const k in rec) {
      if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k];
    }

    out.fills = [];
    out.strokes = [];
    out.effects = [];
    out.blendMode = null;
    out._lowfiFrom = rec.t || rec.type || '';

    /* 1) 文字 */
    if (rec.t === 'text' || rec.characters != null) {
      if (o.textMode === 'keep') {
        out.fills = [solid(SKIN.ink)];
        out.strokes = [];
        out.effects = [];
        out.children = out.children || [];
        /* 保留文字，但去掉字重/字距这些「高保真」属性 */
        if (out.text) {
          out.text = Object.assign({}, out.text, { color: null });
        }
        /* 文字处理完就返回：否则会被下面的「普通矩形」分支按原填充色覆盖掉 */
        return out;
      } else {
        const size = (rec.text && rec.text.fontSize) || rec.fontSize || 14;
        const barH = Math.max(4, Math.min(rec.h, Math.min(o.maxBarHeight, size * 0.62)));
        return {
          name: (rec.name || 'text') + ' ▸ 占位条',
          t: 'rect',
          x: rec.x,
          y: rec.y + Math.max(0, (rec.h - barH) / 2),
          w: rec.w,
          h: barH,
          rotation: rec.rotation || 0,
          opacity: rec.opacity == null ? 1 : rec.opacity,
          radius: o.keepRadius ? [2, 2, 2, 2] : [0, 0, 0, 0],
          fills: [solid(SKIN.bar)],
          strokes: [],
          effects: [],
          children: [],
          clips: false,
          _lowfiFrom: 'text',
        };
      }
    }

    /* 2) 内联 SVG（多为图标）→ 纯色块（不描边） */
    if (rec.t === 'svg' && rec.svg) {
      if (o.iconStyle === 'box') {
        return {
          name: (rec.name || 'icon') + ' ▸ 色块',
          t: 'rect',
          x: rec.x,
          y: rec.y,
          w: rec.w,
          h: rec.h,
          rotation: rec.rotation || 0,
          opacity: rec.opacity == null ? 1 : rec.opacity,
          radius: [2, 2, 2, 2],
          fills: [solid(SKIN.block)],
          strokes: [],
          effects: [],
          children: [],
          clips: false,
          _lowfiFrom: 'svg',
        };
      }
      out.fills = [];
      out.strokes = [];
      out.effects = [];
      return out;
    }

    /* 3) 图片填充 / 图片节点 → 纯色块
       用比普通容器深一档的灰，仍然能一眼看出「这里原本是一张图」；
       但不画外框、不画对角线 —— 低保真稿里只要色块。
       注意这里不能提前 return：带图片填充的容器可能还有子节点。 */
    const paints = (rec.fills || []);
    const hasImage = paints.some(isImagePaint) || rec.isImage === true;

    if (hasImage) {
      /* 名字里带上标记：一眼能看出「这里原本是一张图」 */
      out.name = (rec.name || 'image') + ' ▸ 色块';
      out.fills = [solid(SKIN.blockDeep)];
      out.radius = normRadius(rec.radius, o.keepRadius);
      out._lowfiFrom = 'image';
    } else {
      /* 4) 普通容器 / 矩形 → 灰阶色块 */
      out.fills = paints.map(grayPaint).filter(Boolean);
      out.radius = normRadius(rec.radius, o.keepRadius);
    }

    /* 一律不描边：低保真稿只由色块构成 */
    out.strokes = [];

    /* 5) 子节点递归 */
    if (rec.children && rec.children.length) {
      out.children = rec.children.map((c) => convert(c, o, false)).filter(Boolean);
    } else {
      out.children = [];
    }
    return out;
  }

  /**
   * 把一份快照变换成低保真稿。返回**新的 payload**（不改动入参），
   * 结构与原快照一致，所以 svg.js / plugin code.js 都能直接渲染。
   */
  function transform(payload, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!payload || !payload.root) return payload;
    const meta = Object.assign({}, payload.meta || {});
    if (meta.rootFill) meta.rootFill = solid(SKIN.page);

    const out = {};
    for (const k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
    }
    out.meta = meta;
    out.root = convert(payload.root, o, true);
    out.lowfi = { version: 'h2f.lowfi/v1', options: o, skin: SKIN };
    if (out.meta) out.meta.title = (meta.title || 'HTML 快照') + ' · 低保真';
    return out;
  }

  global.H2FLowfi = {
    transform: transform,
    skin: SKIN,
    defaults: DEFAULTS,
    _convert: convert,
  };
})(typeof window !== 'undefined' ? window : globalThis);
