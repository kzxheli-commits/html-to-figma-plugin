/**
 * h2f backdrop —— 给高保真页面垫一块「白色衬底画板」
 *
 * 勾选之后，每个页面外面再包一层比它大一圈的白色画板：外层是白色 frame，
 * 原页面作为唯一子节点居中偏移进去。
 *
 * 为什么放在快照层：Figma 与 SVG 两条出口都吃同一份 payload，所以在快照上包一层，
 * 两边自然都得到同样的白边，不需要分别改两个渲染器（与 lowfi 同一个思路）。
 * 不依赖任何 DOM / Figma API。
 */
(function (global) {
  'use strict';

  /** 「稍大一圈」：每边留 40px 白边 */
  const PAD = 40;
  const VERSION = 'h2f.backdrop/v1';

  function rgb(r, g, b) {
    return { r: r / 255, g: g / 255, b: b / 255 };
  }

  const WHITE = { type: 'SOLID', color: rgb(255, 255, 255), opacity: 1 };

  function white() {
    return { type: 'SOLID', color: rgb(255, 255, 255), opacity: 1 };
  }

  /**
   * 包一层白色衬底。
   * @param {object} payload 高保真快照（也接受已经转好的低保真稿）
   * @param {object} [opts] { pad:number 每边留白，默认 40；name:string 画板名 }
   * @returns {object} 新的 payload（不改动入参）
   */
  function apply(payload, opts) {
    if (!payload || !payload.meta || !payload.root) return payload;

    const o = opts || {};
    const pad = Math.max(0, o.pad == null ? PAD : Number(o.pad) || 0);
    if (!pad) return payload;

    const w = Math.max(1, Number(payload.meta.w) || 1);
    const h = Math.max(1, Number(payload.meta.h) || 1);
    const outW = w + pad * 2;
    const outH = h + pad * 2;

    /* 原页面整体平移进衬底里；只改副本，不动原节点 */
    const inner = Object.assign({}, payload.root, { x: pad, y: pad });

    const out = Object.assign({}, payload);
    out.meta = Object.assign({}, payload.meta, {
      w: outW,
      h: outH,
      rootFill: white(),
      backdrop: { pad: pad, version: VERSION },
    });
    out.root = {
      t: 'frame',
      name: o.name || '白色衬底',
      x: 0,
      y: 0,
      w: outW,
      h: outH,
      fills: [white()],
      strokes: [],
      effects: [],
      radius: [0, 0, 0, 0],
      clips: false,
      rotation: 0,
      opacity: 1,
      children: [inner],
      _backdrop: true,
    };
    out.backdrop = { pad: pad, version: VERSION };
    return out;
  }

  global.H2FBackdrop = {
    apply: apply,
    PAD: PAD,
    version: VERSION,
    WHITE: WHITE,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
