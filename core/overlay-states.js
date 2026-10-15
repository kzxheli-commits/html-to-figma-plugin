/* ============================================================================
 * core/overlay-states.js — 页内弹层单独成稿
 *
 * `.modal:target { display: flex }` 这类弹层在捕获时是**隐藏的**，快照里根本没有它 ——
 * 所以「打开弹层」这条交互以前只能被识别出来、没法连成原型（页内 3 里的那一条）。
 *
 * 做法和 hover 状态稿一样：把带 `:target` 的规则临时内联到目标元素上，
 * 重捕一张「弹层打开」的快照。它成为独立画板之后，触发它的链接就能在原型里用
 * OVERLAY 连过去 —— 演示时弹窗浮在当前页上，而不是整页换掉。
 *
 * 务必在 capture 与静态提取**之后**调用：它会临时改动内联样式（结束会还原）。
 * 纯浏览器侧逻辑，不需要 Figma API。
 * ========================================================================== */
(function (global) {
  'use strict';

  const DEFAULTS = {
    maxStates: 4,     // 最多产出几张弹层稿（每张都要重捕一次整页）
    settleMs: 24,     // 内联样式后等布局稳定的时间
  };
  const VERSION = 'h2f.overlay/v1';

  /** 从交互目标里取出「页内元素 id」：`#modal-tip` → `modal-tip`；`#/settings` 这类路由不算 */
  function idOf(target) {
    const s = String(target == null ? '' : target).trim();
    if (s.charAt(0) !== '#') return '';
    const raw = s.slice(1);
    if (!raw || raw.charAt(0) === '/' || raw.charAt(0) === '!') return '';
    return raw.split(/[?#]/)[0].trim();
  }

  /**
   * 文档里所有含 `:target` 的规则，形状与 hover 规则一致：{ selector, cssText }。
   * 两条通道都扫：CSSOM（能拿到解析后的选择器）与 <style> 文本（Shadow DOM 兜底）。
   */
  function collectTargetRules(doc) {
    const out = [];
    const seen = {};
    const push = (selector, cssText) => {
      const sel = String(selector || '').trim();
      if (!sel || !cssText) return;
      const key = sel + '|' + cssText;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ selector: sel, cssText: cssText });
    };

    /* 1) CSSOM */
    let sheets = [];
    try { sheets = Array.from(doc.styleSheets || []); } catch (e) { sheets = []; }
    for (const sheet of sheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (e) { rules = null; }   // 跨域样式表读不到，跳过
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        let sel = '';
        let decls = '';
        try { sel = rule.selectorText || ''; } catch (e) { sel = ''; }
        try { decls = rule.style ? rule.style.cssText : ''; } catch (e) { decls = ''; }
        if (!sel || sel.indexOf(':target') < 0 || !decls) continue;
        for (const one of sel.split(',')) {
          if (one.indexOf(':target') < 0) continue;
          const s = one.trim();
          push(s, s + '{' + decls + '}');
        }
      }
    }

    /* 2) <style> 文本（含 shadow root 里的） */
    const roots = [doc];
    try {
      if (doc.querySelectorAll) {
        const all = Array.from(doc.querySelectorAll('*'));
        for (const n of all) if (n && n.shadowRoot) roots.push(n.shadowRoot);
      }
    } catch (e) { /* 忽略 */ }
    const texts = [];
    for (const root of roots) {
      try {
        if (!root.querySelectorAll) continue;
        Array.from(root.querySelectorAll('style')).forEach((s) => texts.push(s.textContent || ''));
      } catch (e) { /* 忽略 */ }
    }
    const re = /([^{}]*:target[^{}]*)\{([^{}]*)\}/gi;
    for (const text of texts) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        for (const one of String(m[1]).split(',')) {
          if (one.indexOf(':target') < 0) continue;
          const s = one.trim();
          push(s, s + '{' + m[2] + '}');
        }
      }
    }
    return out;
  }

  /**
   * 给每个「打开页内弹层」的交互捕一张「弹层打开」的快照。
   *
   * @param stage      引擎的沙箱（需要 stage.doc）
   * @param opts       { maxStates, settleMs, captureOpts }
   * @param interactions 静态+运行时合并后的交互表
   * @param captureFn  引擎的 capture(stage, opts)
   * @param afterCapture 可选：(payload, stage) => Promise —— 在**还原之前**调用，
   *        此时弹层还开着，正好用来提取「弹层里的按钮」自己的交互
   * @returns [{ target:'#modal-tip', name:'#modal-tip', payload }]
   */
  async function captureOverlays(stage, opts, interactions, captureFn, afterCapture) {
    const conf = Object.assign({}, DEFAULTS, opts || {});
    if (typeof captureFn !== 'function' || !stage || !stage.doc) return [];
    const States = global.H2FStates;
    if (!States || typeof States.applyRule !== 'function') return [];

    /* 收集需要成稿的弹层 id（去重） */
    const ids = [];
    for (const ix of interactions || []) {
      if (!ix || String(ix.action || '') !== 'OPEN_OVERLAY') continue;
      const id = idOf(ix.target);
      if (id && ids.indexOf(id) < 0) ids.push(id);
    }
    if (!ids.length) return [];

    const allRules = collectTargetRules(stage.doc);
    const out = [];

    for (const id of ids.slice(0, conf.maxStates)) {
      let el = null;
      try { el = stage.doc.getElementById(id); } catch (e) { el = null; }
      if (!el) continue;

      const win = stage.doc.defaultView || global;

      /* 只挑「能命中这个元素」且带 :target 的规则。
         判据就靠它 —— 有 :target 规则，说明这个元素本来就是靠 :target 打开的覆盖层。
         不要去猜「当前是否可见」：既会把页面下方的普通锚点（#guide）误判成弹层，
         又会漏掉抽屉这种用 transform 移出屏幕的。 */
      const rules = allRules.filter((r) => {
        const base = States.baseSelector(r.selector);
        if (!base) return false;
        try { return el.matches(base); } catch (e) { return false; }
      });
      if (!rules.length) continue;

      const applied = [];
      let fallback = null;
      try {
        for (const r of rules) {
          const a = States.applyRule(stage.doc, r);
          if (a && a.decls && a.decls.length) applied.push(a);
        }
        /* 内联声明之后仍然藏着？那就直接显示出来。
           为什么需要这一步：大多数弹层就是 display:none ↔ flex 切换，
           而 hover 那套内联器会漏掉 display（实测内联后仍是 none）。 */
        let stillHidden = true;
        try {
          const cs2 = win.getComputedStyle(el);
          const r2 = el.getBoundingClientRect();
          stillHidden = cs2.display === 'none' || (!r2.width && !r2.height);
        } catch (e) { stillHidden = true; }
        if (stillHidden) {
          fallback = { el: el, display: el.style.display };
          el.style.display = 'flex';
          /* flex 是 :target 弹层最常见的打开方式；若站点用的是别的，block 也能显形 */
          if (el.getBoundingClientRect().width === 0) el.style.display = 'block';
        }

        await States.settle(stage, conf.settleMs);
        const payload = captureFn(stage, conf.captureOpts || {});
        /* 关键：此刻弹层是开着的，弹层里的按钮只有在这时候才提取得到 */
        if (typeof afterCapture === 'function') {
          try { await afterCapture(payload, stage); } catch (e) { /* 忽略 */ }
        }
        payload.overlayState = {
          version: VERSION,
          id: id,
          selector: rules.length ? rules.map((r) => r.selector).join(', ') : '#' + id,
          elements: applied.length
            ? applied.reduce((a, x) => a + ((x.els && x.els.length) || 0), 0)
            : 1,
        };
        out.push({ target: '#' + id, name: '#' + id, payload: payload });
      } catch (e) {
        /* 单张失败不影响其它弹层 */
      } finally {
        for (const a of applied) {
          try { States.restoreRule(a); } catch (e) { /* 忽略 */ }
        }
        if (fallback) fallback.el.style.display = fallback.display;
      }
    }
    return out;
  }

  global.H2FOverlay = {
    captureOverlays: captureOverlays,
    collectTargetRules: collectTargetRules,
    idOf: idOf,
    defaults: DEFAULTS,
    version: VERSION,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
