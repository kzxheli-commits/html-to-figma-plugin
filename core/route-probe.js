/* ============================================================================
 * core/route-probe.js — 运行时路由捕获（SPA）
 *
 * core/interactions.js 是静态分析：读 a[href]、onclick、data-* 这些**写在标签上**的
 * 跳转。而单页应用把跳转写在事件监听里（history.pushState / hash / router.push），
 * 标签上什么都没有，静态分析必然抓不到。
 *
 * 这里用两步补上：
 *   1. injectHook(html) —— 在页面脚本之前插入探针：包住 pushState / replaceState、
 *      监听 hashchange / popstate、window.open，并在捕获阶段记下「最后一次点击的元素」；
 *   2. probe(stage) —— 在**快照已经拍完之后**，逐个点击候选元素并观察 URL/路由是否变化，
 *      记录「点这个元素 → 走到哪个路由」，随后把 URL 还原。
 *
 * 顺序很关键：探测会真的改动页面状态，所以永远放在 capture 与静态提取之后。
 * ========================================================================== */
(function (global) {
  'use strict';

  const HOOK_SRC = [
    '(function(){',
    'if(window.__h2fRouteHook)return;',
    'var H={events:[],lastClick:null,origin:location.href};',
    'window.__h2fRouteHook=H;',
    'function describe(el){',
    '  if(!el||el.nodeType!==1)return null;',
    '  var name=el.tagName.toLowerCase();',
    '  var id=el.id?"#"+el.id:"";',
    '  var cls="";',
    '  try{var c=el.getAttribute("class");if(c)cls="."+String(c).trim().split(/\\s+/)[0];}catch(e){}',
    '  var t=((el.innerText||el.textContent||"").replace(/\\s+/g," ").trim()).slice(0,24);',
    '  var href=null;try{href=el.getAttribute("href");}catch(e){}',
    '  return {selector:name+id+cls,text:t,href:href};',
    '}',
    'window.__h2fDescribe=describe;',
    'function push(kind,target){H.events.push({kind:kind,url:location.href,target:target||null,via:H.lastClick});}',
    'var ps=history.pushState;',
    /* 先记录目标再调用原函数：在 blob: / about:srcdoc 文档里浏览器会拒绝 pushState，
       但「点了它想跳到哪」这个信息此时已经拿到了 —— 探测照样成立 */
    'history.pushState=function(s,t,u){push("pushState",u);try{return ps.apply(this,arguments);}catch(e){H.blocked=(H.blocked||0)+1;return undefined;}};',
    'var rs=history.replaceState;',
    /* replaceState 常被用于初始化，不算跳转，所以只吞异常不记录 */
    'history.replaceState=function(s,t,u){try{return rs.apply(this,arguments);}catch(e){H.blocked=(H.blocked||0)+1;return undefined;}};',
    'window.addEventListener("hashchange",function(){push("hashchange",location.hash);},true);',
    'window.addEventListener("popstate",function(){push("popstate",location.href);},true);',
    'var wo=window.open;',
    'window.open=function(u){push("open",u);return wo.apply(this,arguments);};',
    /* back / forward / go 只记录、不真的执行：
       试点击时如果让它们跑起来，页面可能被导航到父文档的历史条目，
       整轮探测就废了；而且「返回」本来也不是我们要建立的原型跳转 */
    /* assign / replace 可以被覆盖（location.href 不行，那是不可覆盖的），
       覆盖后就能记录目标，而不会让 iframe 真的跳走 */
    'try{location.assign=function(u){push("assign",u);};}catch(e){}',
    'try{location.replace=function(u){push("replace",u);};}catch(e){}',
    'history.back=function(){push("historyBack",null);};',
    'history.forward=function(){push("historyForward",null);};',
    'history.go=function(n){push("historyGo",n);};',
    'document.addEventListener("click",function(ev){',
    '  var el=ev.target;',
    '  var a=null;',
    '  try{if(el&&el.closest)a=el.closest("a[href]");}catch(e){}',
    /* 探测期间拦住 <a> 的默认导航：不然 iframe 会真的跳走（跳到父文档或目标页），
       后面所有候选元素就都点在人家的页面上，整轮探测作废 */
    '  if(a&&H.blockNav){ev.preventDefault();}',
    '  try{if(el&&el.closest)el=el.closest("a,button,[role=button],[data-href],[data-target],[data-link],[data-to],[onclick]")||ev.target;}catch(e){}',
    '  H.lastClick=describe(el);',
    '},true);',
    '})();',
  ].join('\n');

  /** 把探针插到页面最前面（页面自己的脚本之前）。 */
  function injectHook(html) {
    const tag = '<script data-h2f-route-probe="1">' + HOOK_SRC + '<' + '/script>';
    const src = String(html == null ? '' : html);
    if (/<head[^>]*>/i.test(src)) return src.replace(/<head([^>]*)>/i, '<head$1>' + tag);
    if (/<html[^>]*>/i.test(src)) return src.replace(/<html([^>]*)>/i, '<html$1><head>' + tag + '</head>');
    return tag + src;
  }

  const CLICKABLE_SEL = [
    'a[href]', 'button', '[role="button"]', '[data-href]', '[data-target]', '[data-link]', '[data-to]',
    '[onclick]', 'input[type="button"]', 'input[type="submit"]',
  ].join(',');

  function visible(el, win) {
    let st;
    try { st = win.getComputedStyle(el); } catch (e) { return false; }
    if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function pickCandidates(root, win, limit) {
    const seen = new Set();
    const out = [];
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (!visible(el, win)) return;
      out.push(el);
    };
    /* 优先「看起来会跳转」的：带 href / data-* / onclick 的排前面 */
    const strong = root.querySelectorAll
      ? root.querySelectorAll('a[href],[data-href],[data-target],[data-link],[data-to],[onclick]')
      : [];
    for (const el of strong) {
      if (out.length >= limit) break;
      push(el);
    }
    const weak = root.querySelectorAll ? root.querySelectorAll(CLICKABLE_SEL) : [];
    for (const el of weak) {
      if (out.length >= limit) break;
      push(el);
    }
    return out.slice(0, limit);
  }

  function waitFrames(win, n) {
    return new Promise((resolve) => {
      let left = Math.max(1, n | 0);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const step = () => { left--; if (left <= 0) finish(); else raf(step); };
      const raf = (fn) => {
        try { if (win.requestAnimationFrame) { win.requestAnimationFrame(fn); return; } } catch (e) { /* 退化 */ }
        setTimeout(fn, 16);
      };
      setTimeout(finish, 160);   // 兜底：页面没有 rAF 或卡住时也能继续
      raf(step);
    });
  }

  /* about:srcdoc# 这类「末尾空 hash」不算 URL 变化 */
  function normUrl(u) {
    return String(u == null ? '' : u).replace(/#$/, '');
  }

  /** 把 pushState 的参数 / 事件里的 URL 归一成「路由目标」。 */
  function routeTarget(raw, originHref) {
    const s = String(raw == null ? '' : raw);
    if (!s) return '';
    if (s.charAt(0) === '#') return s;
    try {
      const base = new URL(originHref);
      const u = new URL(s, originHref);
      if (u.origin !== base.origin) return u.href;
      if (u.hash && u.pathname === base.pathname && u.search === base.search) return u.hash;
      return u.pathname + u.search + (u.hash || '');
    } catch (e) {
      /* blob: / about:srcdoc 文档下解析不了相对 URL，原样返回 —— 但要去掉 query 与 hash：
         连线连的是「哪一页」，query/hash 只是页内状态。
         不然 'detail.html?from=js' 会和画板的 key 'detail.html' 对不上，白丢一条连线。 */
      return s.split('#')[0].split('?')[0];
    }
  }

  function splitUrl(href) {
    try {
      const u = new URL(String(href));
      return { path: u.pathname, hash: u.hash, search: u.search };
    } catch (e) {
      return { path: String(href || ''), hash: '', search: '' };
    }
  }

  /**
   * 主动点击候选元素，找出「JS 绑定」的跳转。
   * 必须在 capture 之后调用（会真实改动页面状态）。
   */
  async function probe(stage, opts) {
    const conf = opts || {};
    const win = stage.win;
    const doc = stage.doc;
    const root = stage.contentRoot || doc.body;
    const hook = win.__h2fRouteHook;
    const scrollX = stage.scrollX || 0;
    const scrollY = stage.scrollY || 0;
    const pagePath = conf.pagePath || '';
    const maxClicks = conf.maxClicks || 24;

    if (!hook) {
      const kind = stage.kind || 'iframe';
      let why;
      if (kind === 'shadow') {
        /* Figma 插件的 UI 是 opaque origin，内层 iframe 的文档读不到，只能走 Shadow DOM 兜底；
           这条路径不执行页面脚本（也不该执行：脚本会污染插件界面本身），所以路由探测在这类环境里用不了 */
        why = '当前渲染沙箱降级为 Shadow DOM，页面脚本没有执行，路由探测用不了'
          + '（网页版、或沙箱能正常拿到文档的环境才有效）';
      } else {
        why = '页面没有注入路由探针：可能没勾选「运行时路由探测」';
      }
      return { interactions: [], note: why, clicked: 0, restored: false, sandbox: kind };
    }

    hook.blockNav = true;   /* 探测期间禁止 <a> 真的导航 */
    const origin = hook.origin || win.location.href;
    const originParts = splitUrl(origin);
    const describe = win.__h2fDescribe || (() => ({ selector: '', text: '', href: null }));
    const candidates = pickCandidates(root, win, maxClicks);
    const out = [];
    const seenKey = new Set();
    let clicked = 0;
    let skippedHistory = 0;
    let navigated = false;

    for (const el of candidates) {
      const info = describe(el);
      const beforeUrl = win.location.href;
      const beforeEvents = hook.events.length;
      let rect = null;
      try {
        const r = el.getBoundingClientRect();
        rect = {
          x: Math.round(r.left + scrollX),
          y: Math.round(r.top + scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      } catch (e) { rect = { x: 0, y: 0, w: 0, h: 0 }; }

      const docBefore = win.document;
      try { el.click(); } catch (e) { /* 元素可能已经不可点 */ }
      clicked++;
      await waitFrames(win, 2);

      /* 万一还是被导航走了（例如 onclick 里直接 location.href = ...），立刻收手：
         此时 document 已经被换掉，再点下去就是在别人的页面上乱点了 */
      if (win.document !== docBefore) { navigated = true; break; }

      const afterUrl = win.location.href;
      const fresh = hook.events.slice(beforeEvents);
      let changed = afterUrl !== beforeUrl || fresh.length > 0;
      if (!changed) continue;

      const ev = fresh.length ? fresh[fresh.length - 1] : { kind: 'url', target: null };
      /* 返回 / 前进这类历史操作没有「目标页」，不算一条路由 */
      if (ev && ev.kind && ev.kind.indexOf('history') === 0) {
        skippedHistory++;
        try {
          if (normUrl(win.location.href) !== normUrl(origin)) {
            win.history.replaceState(null, '', originParts.path + originParts.search + originParts.hash);
          }
        } catch (e) { /* 忽略 */ }
        continue;
      }
      const to = afterUrl;
      /* 优先用事件里的目标（pushState 的参数），URL 没变也说明白要跳到哪 */
      const target = routeTarget((ev && ev.target) || (afterUrl !== beforeUrl ? afterUrl : ''), origin);

      const key = (info && info.selector ? info.selector : '') + '>' + target;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        out.push({
          page: pagePath,
          selector: (info && info.selector) || '',
          text: (info && info.text) || '',
          href: (info && info.href) || null,
          from: beforeUrl,
          to: to,
          target: target,
          event: ev.kind || 'url',
          rect: rect,
        });
      }

      /* 还原 URL：探测只是「试一下」，不能让页面停在跳转后的状态 */
      try {
        if (win.location.href !== origin) {
          win.history.replaceState(null, '', originParts.path + originParts.search + originParts.hash);
        }
      } catch (e) { /* 跨源或权限受限就放弃还原 */ }
      await waitFrames(win, 1);
    }

    hook.blockNav = false;

    /* 收尾还原一次：路由探测只是「试一下」，不能把页面留在跳转后的状态 */
    let restored = true;
    try {
      if (normUrl(win.location.href) !== normUrl(origin)) {
        try {
          win.history.replaceState(null, '', originParts.path + originParts.search + originParts.hash);
        } catch (e) {
          /* blob: / about: 文档下 replaceState 可能不被允许，退化成直接改 hash */
        }
        const home = splitUrl(origin);
        if ((win.location.hash || '') !== (home.hash || '')) win.location.hash = home.hash || '';
      }
      restored = normUrl(win.location.href) === normUrl(origin);
    } catch (e) {
      restored = false;
    }

    return {
      interactions: out,
      clicked: clicked,
      candidates: candidates.length,
      restored: restored,
      blocked: hook.blocked || 0,
      skippedHistory: skippedHistory,
      navigated: navigated,
      origin: origin,
    };
  }

  global.H2FRouteProbe = {
    injectHook: injectHook,
    probe: probe,
    hookSource: HOOK_SRC,
  };
})(typeof window !== 'undefined' ? window : globalThis);
