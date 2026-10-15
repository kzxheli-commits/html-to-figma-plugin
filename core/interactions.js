/* ============================================================================
 * core/interactions.js — 交互与 :hover 状态提取
 *
 * 引擎只能复刻「静止的一帧」，而真实项目里真正定义结构的是跳转关系：
 * 哪个按钮通向哪一页、哪个链接弹弹窗、哪个表单提交到哪里。
 *
 * 这里不改捕获引擎，只在**同一份已排版的沙箱**上再走一遍 DOM，把
 *   a[href] / [data-href|data-target|data-link|data-to] / [onclick] /
 *   form[action] / [popovertarget] / [aria-controls]
 * 翻译成结构化交互表；顺带把样式表里的 :hover 规则单独收集出来
 * （Figma 里可以据此建 Variant，SVG 路线会写进提示）。
 *
 * 输入是 core/engine.js 的 stage 对象（{win, doc, contentRoot, scrollX, scrollY}），
 * 因此 rect 与快照里的图层坐标完全同源，连线可以直接叠在画板上。
 * ========================================================================== */
(function (global) {
  'use strict';

  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, HEAD: 1, NOSCRIPT: 1, TITLE: 1, BASE: 1 };

  const EXTERNAL_RE = /^(?:https?:)?\/\//i;

  /** 生成一条尽量短、又能定位到元素的选择器（id > class > nth-of-type 链）。 */
  function cssPath(el, maxDepth) {
    const limit = maxDepth || 5;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < limit) {
      if (node.id) {
        parts.unshift('#' + node.id);
        break;
      }
      let sel = node.tagName.toLowerCase();
      const cls = String(node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(' > ');
  }

  function textOf(el) {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 24);
  }

  function isVisible(el, win) {
    let style;
    try { style = win.getComputedStyle(el); } catch (e) { return false; }
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  }

  /** 从 onclick 字符串里认出手写跳转（老项目里非常常见）。 */
  function parseOnclick(code) {
    if (!code) return null;
    const nav = /(?:location\.href|location\.replace|location\.assign|window\.location)\s*(?:=|\()\s*['"]([^'"]+)['"]/i.exec(code);
    if (nav) return { action: EXTERNAL_RE.test(nav[1]) ? 'EXTERNAL' : 'NAVIGATE', target: nav[1] };
    const open = /window\.open\s*\(\s*['"]([^'"]+)['"]/i.exec(code);
    if (open) return { action: 'EXTERNAL', target: open[1] };
    if (/history\.(?:back|go\s*\(\s*-1)/i.test(code)) return { action: 'BACK', target: '' };
    return { action: 'SCRIPT', target: '' };
  }

  function classifyHref(href) {
    if (!href) return null;
    const h = href.trim();
    if (!h) return null;
    if (h === '#' || h.toLowerCase().startsWith('javascript:')) return null;
    if (h.startsWith('#')) {
      /* #/path 与 #!/path 是前端路由（换视图），不是弹层；
         #id 才按「弹层 / 页内锚点」处理（到底哪种，由 overlay-states 按可见性再判一次） */
      const raw = h.slice(1);
      /* `#/path` 与 `#!/path` 是前端路由；单独的 `#!`（清空 hash 关闭弹层的惯用法）不是 */
      if (raw.length > 1 && (raw.charAt(0) === '/' || raw.charAt(0) === '!')) {
        return { action: 'ROUTE', target: h };
      }
      return { action: 'OPEN_OVERLAY', target: h };
    }
    if (/^mailto:|^tel:/i.test(h)) return { action: 'EXTERNAL', target: h };
    if (EXTERNAL_RE.test(h)) return { action: 'EXTERNAL', target: h };
    return { action: 'NAVIGATE', target: h };
  }

  /**
   * 在已排版的沙箱上提取交互。
   * pagePath：该页在包内的路径（用于把 href 解析成"通向哪一页"）。
   */
  function extract(stage, opts) {
    const conf = opts || {};
    const win = stage.win;
    const doc = stage.doc;
    const root = stage.contentRoot || doc.body;
    const scrollX = stage.scrollX || 0;
    const scrollY = stage.scrollY || 0;
    const pagePath = conf.pagePath || '';

    /* 未打开的覆盖层（抽屉、底部弹层）此刻在**视口外**：
       它们的交互由弹层稿负责。留在主稿里只会出乱子 ——
       主线程拿这个坐标去画板里找不到元素，回退时就会把反应写到重叠的别的元素上
       （点左上角的菜单却跳到任务页，就是这么来的）。 */
    const viewportW = (doc && doc.defaultView && doc.defaultView.innerWidth) || 0;
    const viewportH = (doc && doc.defaultView && doc.defaultView.innerHeight) || 0;
    const resolve = (global.H2FVfs && global.H2FVfs.resolve) ? global.H2FVfs.resolve : null;

    const interactions = [];
    const seen = new Set();
    const stats = { scanned: 0, clickable: 0, hidden: 0, hoverRules: 0, forms: 0, scripts: 0 };
    const warnings = [];

    function push(el, action, target, extra) {
      const kind = action.action || action;
      const dest = extra && extra.raw != null ? extra.raw : target;
      let resolved = dest;
      if (resolve && (kind === 'NAVIGATE' || kind === 'SUBMIT')) {
        const r = resolve(pagePath, dest);
        // 解析不出（外链/锚点）时保留原值，方便人工看
        resolved = r == null ? dest : r;
      }
      const key = kind + '|' + resolved + '|' + Math.round(el.getBoundingClientRect().left) + ',' + Math.round(el.getBoundingClientRect().top);
      if (seen.has(key)) return;
      seen.add(key);

      const r = el.getBoundingClientRect();
      interactions.push({
        page: pagePath,
        layer: cssPath(el),
        text: textOf(el),
        tag: el.tagName.toLowerCase(),
        action: kind,
        target: resolved,
        raw: dest,
        inPage: kind === 'OPEN_OVERLAY' || (resolved || '') === pagePath,
        rect: {
          x: Math.round(r.left + scrollX),
          y: Math.round(r.top + scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
      });
      stats.clickable++;
    }

    /* --------------------------- 1. 表单 action --------------------------- */
    const formAction = new Map();
    const forms = root.querySelectorAll ? root.querySelectorAll('form') : [];
    for (const form of forms) {
      stats.forms++;
      const action = form.getAttribute('action') || '';
      if (action) formAction.set(form, action);
    }

    /* --------------------------- 2. 遍历元素 ------------------------------ */
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (SKIP_TAGS[el.tagName]) continue;
      stats.scanned++;
      if (!isVisible(el, win)) { stats.hidden++; continue; }

      const tag = el.tagName.toLowerCase();
      let hit = null;

      // a[href]
      if (tag === 'a') {
        const c = classifyHref(el.getAttribute('href'));
        if (c) hit = c;
      }

      // data-* 约定的跳转（组件库常用）
      if (!hit) {
        const dataTarget = el.getAttribute('data-href') || el.getAttribute('data-target')
          || el.getAttribute('data-link') || el.getAttribute('data-to');
        if (dataTarget) {
          const c = classifyHref(dataTarget);
          if (c) hit = c;
        }
      }

      // popover / aria-controls：页内弹层
      if (!hit) {
        const pop = el.getAttribute('popovertarget') || (el.hasAttribute('aria-controls') && el.getAttribute('aria-controls') && (el.getAttribute('aria-expanded') != null || el.getAttribute('role') === 'button') ? el.getAttribute('aria-controls') : null);
        if (pop) hit = { action: 'OPEN_OVERLAY', target: '#' + String(pop).replace(/^#/, '') };
      }

      // onclick 手写跳转
      if (!hit) {
        const oc = el.getAttribute('onclick');
        if (oc) {
          const c = parseOnclick(oc);
          if (c) { hit = c; if (c.action === 'SCRIPT') stats.scripts++; }
        }
      }

      // 表单提交按钮
      if (!hit && (tag === 'button' || tag === 'input')) {
        const type = (el.getAttribute('type') || (tag === 'button' ? 'submit' : 'text')).toLowerCase();
        const form = el.form || el.closest('form');
        if (form) {
          if (type === 'submit' || type === 'button') {
            hit = { action: 'SUBMIT', target: formAction.get(form) || '' };
          }
        } else if (el.getAttribute('type') === 'submit') {
          /* 显式写了 type=submit 却没有 form：只记动作，不臆造目标。
             裸 <button>（无 type、无 form）不算提交 —— 它若真会跳转，
             由运行时路由探测（core/route-probe.js）补上 */
          hit = { action: 'SUBMIT', target: '' };
        }
      }

      if (hit) push(el, hit.action, hit.target, { raw: hit.raw != null ? hit.raw : hit.target });
    }

    /* --------------------------- 3. :hover 规则 --------------------------- */
    /* 两条通道：
       ① CSSOM —— 能拿到媒体查询里的嵌套规则，但个别降级路径下 styleSheets 读不到；
       ② <style> 文本扫描 —— 兜底，纯正则，不依赖 CSSOM 可读性。
       去重后合并，报告各自命中数，方便定位「为什么没抓到 hover」。 */
    const hoverRules = [];
    const hoverSeen = new Set();
    const addHover = (selector, cssText) => {
      const sel = String(selector || '').replace(/\s+/g, ' ').trim();
      if (!sel || sel.indexOf(':hover') < 0) return;
      const key = sel + '{' + cssText + '}';
      if (hoverSeen.has(key)) return;
      hoverSeen.add(key);
      hoverRules.push({ selector: sel, cssText: String(cssText || '').replace(/\s+/g, ' ').trim() });
    };

    let cssomHits = 0;
    try {
      for (const sheet of Array.from(doc.styleSheets || [])) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) {
          warnings.push('样式表无法读取（跨域）：' + (sheet.href || ''));
          continue;
        }
        if (!rules) continue;
        const walkRules = (list) => {
          for (const rule of Array.from(list)) {
            if (rule.cssRules) walkRules(rule.cssRules);
            else if (rule.selectorText && rule.selectorText.indexOf(':hover') >= 0) {
              const before = hoverRules.length;
              addHover(rule.selectorText, rule.style && rule.style.cssText ? rule.style.cssText : '');
              if (hoverRules.length > before) cssomHits++;
            }
          }
        };
        walkRules(rules);
      }
    } catch (e) {
      warnings.push('读取 :hover 规则失败：' + (e && e.message ? e.message : e));
    }

    let textHits = 0;
    try {
      /* Shadow DOM 兜底路径下样式表在 shadowRoot 里、宿主 document 上读不到，
         所以两个作用域都扫一遍（srcdoc 路径下二者重叠，用 Set 去重） */
      const scopes = [];
      if (root && root.querySelectorAll) scopes.push(root);
      if (doc && doc.querySelectorAll && doc !== root) scopes.push(doc);
      const seenStyle = new Set();
      for (const scope of scopes) {
        for (const st of Array.from(scope.querySelectorAll('style'))) {
          if (seenStyle.has(st)) continue;
          seenStyle.add(st);
          const text = st.textContent || '';
          const re = /([^{}]+)\{([^{}]*)\}/g;
          let mm;
          while ((mm = re.exec(text))) {
            const before = hoverRules.length;
            addHover(mm[1], mm[2]);
            if (hoverRules.length > before) textHits++;
          }
        }
      }
    } catch (e) { /* 兜底通道失败不影响主流程 */ }

    stats.hoverRules = hoverRules.length;
    stats.hoverSource = { cssom: cssomHits, text: textHits };
    if (!hoverRules.length) stats.hoverSamples = Array.from(doc.querySelectorAll('style')).length;

    /* 页面自己的 JS 里写的「控件 -> 目标」。
       和标签上的 href 一样是代码，只是写在脚本里 —— 所以按代码读，不靠试点击猜。
       典型：底部导航 el.addEventListener('click', () => show(el.getAttribute('data-view')))
       读出来就是「[data-view] 点击 -> #/{data-view}」。 */
    if (typeof H2FCodeIx !== 'undefined' && typeof H2FCodeIx.analyze === 'function') {
      try {
        const scripts = doc.querySelectorAll('script:not([src])');
        const srcAll = Array.prototype.map.call(scripts, (s) => s.textContent || '').join('\n');
        const rules = H2FCodeIx.analyze(srcAll);
        const sx = (doc.defaultView && doc.defaultView.scrollX) || 0;
        const sy = (doc.defaultView && doc.defaultView.scrollY) || 0;
        for (const rule of rules) {
          let els = [];
          try { els = doc.querySelectorAll(rule.selector); } catch (e) { els = []; }
          for (const el of els) {
            let target = rule.target || '';
            if (rule.attr) {
              const v = el.getAttribute(rule.attr) || '';
              if (!v) continue;
              target = target.split('{' + rule.attr + '}').join(v);
            }
            if (!target || target.indexOf('{') >= 0 || target.indexOf('}') >= 0) continue;
            const rr = el.getBoundingClientRect();
            const action = rule.kind === 'route' ? 'ROUTE'
              : rule.kind === 'overlay' ? 'OPEN_OVERLAY'
                : rule.kind === 'external' ? 'EXTERNAL' : 'NAVIGATE';
            /* 必须走同一个 seen：同一个元素常常既是 <a href>（静态抓到）又被
               addEventListener 绑定（代码读到），不去重就会产出两条一模一样的交互，
               在 Figma 里同一个节点写两条反应 —— 点一下连跳多次。 */
            const ckey = action + '|' + target + '|' + Math.round(rr.left) + ',' + Math.round(rr.top);
            if (seen.has(ckey)) continue;
            seen.add(ckey);
            interactions.push({
              action: action, target: target,
              rect: { x: rr.left + sx, y: rr.top + sy, w: rr.width, h: rr.height },
              event: rule.trigger, source: 'code',
            });
          }
        }
        stats.codeRules = rules.length;
      } catch (e) { /* 分析失败不影响其它来源 */ }
    }

    /* 未打开的覆盖层（抽屉、底部弹层）此刻在**视口外**，它们的交互由状态稿负责。
       留在主稿里会出乱子：主线程拿这个坐标去画板里找不到元素，
       回退时就会把反应写到重叠的别的元素上 —— 点左上角菜单却跳到任务页就是这么来的。 */
    const visible = [];
    let offscreen = 0;
    for (const ix of interactions) {
      const rr = ix && ix.rect;
      /* 注意：rect 的字段是 x/y/w/h —— 没有 right/bottom。
         之前写成 rr.right 导致条件永远为假，一条都没滤掉，
         于是 x=-279 的抽屉链接留在主稿里，坐标在画板外，
         主线程回退时就把它连到了重叠的左上角菜单按钮上。 */
      if (rr && ((rr.x + (rr.w || 0)) <= 0 || (rr.y + (rr.h || 0)) <= 0)) {
        offscreen++;
        continue;
      }
      visible.push(ix);
    }
    if (offscreen) stats.offscreen = offscreen;

    return { interactions: visible, hoverRules: hoverRules, stats: stats, warnings: warnings };
  }

  /**
   * 把运行时探测到的路由跳转并入静态交互表（见 core/route-probe.js）。
   * 静态已经抓到同一目标的就不重复；补进来的标记 action:'ROUTE'、source:'runtime'。
   */
  function merge(staticList, runtimeList) {
    const out = (staticList || []).slice();
    const targets = new Set(out.map((x) => String(x.target || '')));
    const sels = new Set(out.map((x) => String(x.layer || '')));
    for (const r of (runtimeList || [])) {
      const target = String(r.target || r.to || '');
      const sel = String(r.selector || '');
      if (target && targets.has(target)) continue;
      if (sel && sels.has(sel) && !target) continue;
      targets.add(target);
      sels.add(sel);
      out.push({
        page: r.page || '',
        layer: sel,
        text: r.text || '',
        tag: (sel.match(/^[a-z0-9-]+/) || [''])[0],
        action: 'ROUTE',
        target: target,
        raw: r.href || target,
        source: 'runtime',
        event: r.event || 'url',
        inPage: target.charAt(0) === '#',
        rect: r.rect || { x: 0, y: 0, w: 0, h: 0 },
      });
    }
    return out;
  }

  global.H2FInteract = {
    extract: extract,
    merge: merge,
    cssPath: cssPath,
    parseOnclick: parseOnclick,
    classifyHref: classifyHref,
  };
})(typeof window !== 'undefined' ? window : globalThis);
