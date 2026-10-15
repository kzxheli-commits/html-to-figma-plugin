/* ============================================================================
 * core/hover-states.js — :hover 状态稿
 *
 * 以前 :hover 只是「被记录下来的规则」（一堆选择器文本），对设计稿没有产出。
 * 这里把规则落到画面上：把某条 :hover 规则里的声明**临时内联**到匹配元素上，
 * 重新捕获一次整页 —— 得到的就是「鼠标悬停时这个页面长什么样」的完整快照。
 *
 * 于是 hover 态可以像普通页面一样：并排成画板、进全景连线画布、导出 SVG / Figma 图层。
 *
 * 两部分：
 *   captureStates()  需要真实的沙箱与引擎（浏览器里跑）
 *   diffStates()     纯逻辑：对比基线与各状态，列出「hover 时哪些元素变了」
 *
 * 务必在 capture 与静态提取**之后**调用：它会临时改动 DOM 内联样式（结束会还原）。
 * ========================================================================== */
(function (global) {
  'use strict';

  const DEFAULTS = {
    maxStates: 4,        // 最多产出几张状态稿（每张都要重捕一次整页，成本不低）
    settleMs: 24,        // 内联样式后等一次布局稳定的时间
  };

  const STYLE_ATTR = 'style';

  function parseDecls(cssText) {
    /* 上游可能给完整规则（`.drawer-wrap:target{transform:none;}`），
       也可能只给声明（`transform:none;`）—— 这里统一切掉选择器再解析。
       不这么做，`.drawer-wrap:target{transform:none}` 会被切成
       prop=".drawer-wrap:target{transform" 这种鬼东西，setProperty 静默失败，
       表现就是「状态稿里覆盖层根本没打开」。 */
    let text = String(cssText || '');
    const lb = text.indexOf('{');
    if (lb >= 0) {
      const rb = text.lastIndexOf('}');
      text = text.slice(lb + 1, rb > lb ? rb : text.length);
    }
    return text
.split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf(':');
        if (i < 0) return null;
        const prop = s.slice(0, i).trim();
        let value = s.slice(i + 1).trim();
        let priority = '';
        if (/!important$/i.test(value)) {
          value = value.replace(/!important$/i, '').trim();
          priority = 'important';
        }
        return prop && value ? { prop: prop, value: value, priority: priority } : null;
      })
      .filter(Boolean);
  }

  /** 选择器去掉 :hover 与伪类，得到可以 querySelectorAll 的基础选择器。 */
  function baseSelector(selector) {
    return String(selector || '')
      .split(',')[0]
      .replace(/::?[a-z-]+(\([^)]*\))?/gi, '')
      .trim();
  }

  function applyRule(doc, rule) {
    const base = baseSelector(rule.selector);
    if (!base) return null;
    let els = [];
    try { els = Array.from(doc.querySelectorAll(base)); } catch (e) { return null; }
    if (!els.length) return null;

    const saved = els.map((el) => ({ el: el, css: el.getAttribute(STYLE_ATTR) }));
    const decls = parseDecls(rule.cssText);
    for (const el of els) {
      /* 状态稿要的是**终态**，不是过渡中间帧。
         抽屉这类覆盖层带 transition: transform .2s，改了 transform 之后要 200ms 才到位，
         而这里只 settle 几十毫秒 —— 截到的就是「还在屏幕外」的半路状态。
         所以先把过渡和动画关掉，再套状态。 */
      try { el.style.setProperty('transition', 'none', 'important'); } catch (e) { /* 忽略 */ }
      try { el.style.setProperty('animation', 'none', 'important'); } catch (e) { /* 忽略 */ }
      for (const d of decls) {
        try { el.style.setProperty(d.prop, d.value, d.priority || ''); } catch (e) { /* 单个属性失败不影响整体 */ }
      }
    }
    return { base: base, els: els, saved: saved, decls: decls };
  }

  function restoreRule(applied) {
    if (!applied) return;
    for (const s of applied.saved) {
      try {
        if (s.css == null) s.el.removeAttribute(STYLE_ATTR);
        else s.el.setAttribute(STYLE_ATTR, s.css);
      } catch (e) { /* 元素可能已被移除 */ }
    }
  }

  function settle(stage, ms) {
    const win = stage.win;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      setTimeout(finish, ms || DEFAULTS.settleMs);
      try {
        if (win && win.requestAnimationFrame) win.requestAnimationFrame(finish);
      } catch (e) { /* 退化到纯 setTimeout */ }
    });
  }

  /**
   * 产出 hover 状态稿。
   * @param stage      引擎的沙箱对象
   * @param hoverRules core/interactions.js 收集到的 :hover 规则
   * @param captureFn  引擎的 capture(stage, opts)
   */
  async function captureStates(stage, opts, hoverRules, captureFn) {
    const conf = Object.assign({}, DEFAULTS, opts || {});
    if (typeof captureFn !== 'function') return [];
    const rules = (hoverRules || []).filter((r) => r && r.selector && r.cssText).slice(0, conf.maxStates);
    const out = [];

    for (const rule of rules) {
      const applied = applyRule(stage.doc, rule);
      if (!applied || !applied.decls.length) { restoreRule(applied); continue; }
      try {
        await settle(stage, conf.settleMs);
        const payload = captureFn(stage, conf.captureOpts || {});
        if (typeof conf.afterCapture === 'function') {
          try { await conf.afterCapture(payload, stage); } catch (e) { /* 忽略 */ }
        }
        payload.hoverState = {
          version: 'h2f.hover/v1',
          selector: rule.selector,
          base: applied.base,
          cssText: rule.cssText,
          elements: applied.els.length,
        };
        out.push({
          selector: rule.selector,
          base: applied.base,
          elements: applied.els.length,
          payload: payload,
        });
      } finally {
        restoreRule(applied);
      }
    }

    /* 收尾：把页面还原到基线状态，避免影响后续步骤 */
    await settle(stage, conf.settleMs);
    return out;
  }

  /* --------------------------- 纯逻辑：差异对比 --------------------------- */

  function indexByName(rec) {
    const map = new Map();
    const walk = (n) => {
      if (!n) return;
      if (n.name) map.set(n.name, n);
      if (n.children) for (const c of n.children) walk(c);
    };
    walk(rec);
    return map;
  }

  function paintKey(paints) {
    if (!paints || !paints.length) return '';
    return paints.map((p) => {
      if (!p) return '';
      if (p.type === 'SOLID' && p.color) {
        const c = p.color;
        return 'SOLID(' + [c.r, c.g, c.b].map((v) => Math.round((v || 0) * 255)).join(',') + ',' + (p.opacity == null ? 1 : p.opacity) + ')';
      }
      return String(p.type || '') + (p.ref ? ':' + p.ref : '');
    }).join('|');
  }

  function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  /** 对比单个节点，返回发生变化的字段名（无变化返回 null）。 */
  function compareNode(a, b) {
    const changed = [];
    if (paintKey(a.fills) !== paintKey(b.fills)) changed.push('fills');
    if (paintKey(a.strokes) !== paintKey(b.strokes)) changed.push('strokes');
    if (round2(a.opacity) !== round2(b.opacity)) changed.push('opacity');
    if (round2(a.x) !== round2(b.x) || round2(a.y) !== round2(b.y)) changed.push('position');
    if (round2(a.w) !== round2(b.w) || round2(a.h) !== round2(b.h)) changed.push('size');
    if (round2(a.rotation) !== round2(b.rotation)) changed.push('rotation');
    if ((a.characters || null) !== (b.characters || null)) changed.push('characters');
    const ef = (n) => (n.effects && n.effects.length ? n.effects.length : 0);
    if (ef(a) !== ef(b)) changed.push('effects');
    return changed.length ? changed : null;
  }

  /**
   * 列出每个 hover 状态下发生变化的元素。
   * 纯逻辑，Node 里可直接单测。
   */
  function diffStates(basePayload, states) {
    const out = [];
    if (!basePayload || !basePayload.root) return out;
    const baseMap = indexByName(basePayload.root);
    for (const st of (states || [])) {
      const stMap = indexByName(st.payload && st.payload.root);
      const changed = [];
      for (const [name, node] of stMap) {
        const b = baseMap.get(name);
        if (!b) continue;
        const d = compareNode(b, node);
        if (d) changed.push({ name: name, changes: d });
      }
      out.push({
        selector: st.selector,
        base: st.base,
        elements: st.elements,
        changed: changed,
        changedCount: changed.length,
      });
    }
    return out;
  }

  global.H2FStates = {
    captureStates: captureStates,
    /* 下面几个是给 overlay-states 复用的：
       弹层要用的正是同一套「临时内联声明 → 重捕 → 还原」机制 */
    applyRule: applyRule,
    restoreRule: restoreRule,
    settle: settle,
    diffStates: diffStates,
    parseDecls: parseDecls,
    baseSelector: baseSelector,
    defaults: DEFAULTS,
    _compareNode: compareNode,
  };
})(typeof window !== 'undefined' ? window : globalThis);
