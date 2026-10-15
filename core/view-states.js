/* ============================================================================
 * core/view-states.js — 前端路由的每个「视图」单独成稿
 *
 * App / SPA 的页面切换几乎都写在 JS 里（pushState 或 hash 路由），
 * 一次加载只能看到其中一个视图 —— 所以复刻一个完整 App，光有一张画板是不够的。
 *
 * 做法：把路由目标**注入页面**（在 <head> 之后插一段脚本，让页面自己的脚本
 * 跑起来之前就已经处在目标路由上），重新加载并捕获一次。
 * 于是每个视图都是一张独立画板，触发它的按钮就能连成 NAVIGATE ——
 * 演示时点底部导航真的会换页。
 *
 * 为什么不用「点击后回滚」：单页应用的内部状态很难可靠回滚，
 * 重新加载 + 注入初始路由是唯一稳的做法。
 * 纯逻辑，不需要 Figma API。
 * ========================================================================== */
(function (global) {
  'use strict';

  const VERSION = 'h2f.view/v1';

  /** 这个目标算不算「换视图」：`#/xxx`、`#!/xxx`，或已被标成 ROUTE */
  function isRouteTarget(action, target) {
    const t = String(target == null ? '' : target);
    if (!t) return false;
    if (String(action || '') === 'ROUTE') {
      /* 上游就算标成 ROUTE，单独的 `#!` 也不算换视图 */
      return !(t.length <= 2 && t.charAt(1) === '!');
    }
    /* `#/path` 与 `#!/path` 是路由；单独的 `#!`（常用来「清空 hash 关掉弹层」）不是 */
    if (t.charAt(0) !== '#') return false;
    if (t.charAt(1) === '/') return true;
    return t.length > 2 && t.charAt(1) === '!';
  }

  /** 从交互表里挑出需要单独成稿的路由（去重、保持出现顺序） */
  function collectRoutes(interactions, opts) {
    const conf = opts || {};
    const max = conf.maxRoutes == null ? 8 : conf.maxRoutes;
    const out = [];
    for (const ix of interactions || []) {
      if (!ix) continue;
      const t = String(ix.target == null ? '' : ix.target);
      if (!isRouteTarget(ix.action, t)) continue;
      if (out.indexOf(t) >= 0) continue;
      out.push(t);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 把路由目标注入 HTML。
   * 插在 <head> 之后 —— 页面自己的脚本（通常在 </body> 前）读到的就已经是目标路由。
   */
  function injectRoute(html, route) {
    const r = String(route == null ? '' : route);
    if (!r || typeof html !== 'string') return html;

    /* 目标以 # 开头 → 设置 hash；否则用 replaceState 换路径 */
    const isHash = r.charAt(0) === '#';
    const lit = JSON.stringify(r);
    const setter = isHash
      ? 'location.hash=' + lit + ';'
      : 'history.replaceState(null,"",' + lit + ');';

    const snippet = '<script>/* h2f:view-state */!function(){try{' + setter
      + '}catch(e){try{location.hash=' + lit + ';}catch(e2){}}}();<' + '/script>';

    const m = /<head([^>]*)>/i.exec(html);
    if (m) return html.replace(m[0], m[0] + snippet);
    return snippet + html;
  }

  /** 视图画板的命名：`#/tasks` → `视图 #/tasks` */
  function viewName(route) {
    return '视图 ' + String(route == null ? '' : route);
  }

  global.H2FViewStates = {
    collectRoutes: collectRoutes,
    isRouteTarget: isRouteTarget,
    injectRoute: injectRoute,
    viewName: viewName,
    version: VERSION,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
