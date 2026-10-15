/* ============================================================================
 * core/viewport.js — 端型自动识别 + 经典设备预设
 *
 * 两条职责：
 *   1. 从页面本身判断它面向哪种设备（看 meta viewport 与媒体查询断点），
 *      据此给出默认视口与画板范围 —— 用户不用再手填。
 *   2. 提供按端型分组的经典尺寸预设（安卓 / iOS / 网页 / 平板）。
 *
 * 纯逻辑，可单测。
 * ========================================================================== */
(function (global) {
  'use strict';

  const VERSION = 'h2f.viewport/v1';

  /* ---------------- 经典设备预设 ----------------
     宽高都是设备逻辑像素（CSS px），也就是浏览器里 window.innerWidth/innerHeight 的量级。 */
  const PRESETS = [
    { group: '安卓设备', items: [
      { label: 'Pixel 7 / 8', w: 412, h: 915, tag: 'phone' },
      { label: 'Galaxy S 系列', w: 360, h: 780, tag: 'phone' },
      { label: '通用安卓', w: 360, h: 800, tag: 'phone' },
      { label: '大屏安卓', w: 414, h: 896, tag: 'phone' },
    ] },
    { group: 'iOS（参考）', items: [
      { label: 'iPhone 15 / 14', w: 393, h: 852, tag: 'phone' },
      { label: 'iPhone SE', w: 375, h: 667, tag: 'phone' },
    ] },
    { group: '网页', items: [
      { label: '笔记本 1366', w: 1366, h: 768, tag: 'desktop' },
      { label: '桌面 1440', w: 1440, h: 900, tag: 'desktop' },
      { label: 'MacBook 14', w: 1512, h: 982, tag: 'desktop' },
      { label: '全高清 1920', w: 1920, h: 1080, tag: 'desktop' },
    ] },
    { group: '平板', items: [
      { label: 'iPad mini', w: 744, h: 1133, tag: 'tablet' },
      { label: 'iPad Pro 11', w: 834, h: 1194, tag: 'tablet' },
    ] },
  ];

  /* 端型 → 默认视口 / 画板范围 */
  const FORM_DEFAULTS = {
    mobile: { w: 412, h: 915, crop: 'viewport', why: 'meta viewport 声明了 width=device-width' },
    tablet: { w: 834, h: 1194, crop: 'viewport', why: '移动优先但断点偏大' },
    desktop: { w: 1440, h: 900, crop: 'content', why: '没有移动端 viewport 声明' },
  };

  /**
   * 从页面源码判断端型。
   * 判据按可靠性排序：
   *   1. `<meta name="viewport" content="width=device-width">` —— 移动端几乎必备；
   *   2. 媒体查询断点：`max-width` 多 → 移动优先；`min-width` 多 → 桌面优先；
   *   3. 都拿不准时按桌面处理（网页仍是多数）。
   */
  function detectFormFactor(html) {
    const src = String(html || '');
    const metaViewport = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i.exec(src);
    const hasDeviceWidth = !!(metaViewport && /width\s*=\s*device-width/i.test(metaViewport[0]));
    const maxBp = (src.match(/max-width\s*:\s*\d{3,4}px/gi) || []).length;
    const minBp = (src.match(/min-width\s*:\s*\d{3,4}px/gi) || []).length;

    /* 触碰类媒体查询也是移动端的强信号 */
    const hasTouch = /(hover\s*:\s*none|pointer\s*:\s*coarse|orientation\s*:)/i.test(src);

    if (hasDeviceWidth) {
      /* 移动优先：max-width 断点多，或者压根没用断点 */
      if (maxBp >= minBp || hasTouch) return { form: 'mobile', why: 'meta viewport 声明了 width=device-width' };
      return { form: 'tablet', why: '有 viewport 声明，但以 min-width 断点为主' };
    }
    if (hasTouch && maxBp > 0) return { form: 'mobile', why: '触碰类媒体查询 + max-width 断点' };
    /* 只凭 max-width 断点**不能**判定移动端：桌面响应式页面同样大量使用它。
       没有 viewport 声明、也没有触碰查询时，按桌面处理（网页仍是多数）。 */
    const why = minBp > 0 ? '以 min-width 断点为主'
      : (maxBp > 0 ? '只有响应式断点，没有移动端 viewport 声明' : '没有移动端 viewport 声明');
    return { form: 'desktop', why: why };
  }

  /** 端型 → 建议的视口与裁剪 */
  function suggest(detected) {
    const d = FORM_DEFAULTS[detected && detected.form] || FORM_DEFAULTS.desktop;
    return { w: d.w, h: d.h, crop: d.crop, form: (detected && detected.form) || 'desktop',
      why: (detected && detected.why) || d.why };
  }

  /** 一次到位：从 HTML 得到建议 */
  function suggestForHtml(html) {
    return suggest(detectFormFactor(html));
  }

  /** 扁平化的预设列表，便于 UI 遍历 */
  function flatPresets() {
    const out = [];
    for (const g of PRESETS) {
      for (const it of g.items) out.push({ group: g.group, label: it.label, w: it.w, h: it.h, tag: it.tag });
    }
    return out;
  }

  global.H2FViewport = {
    PRESETS: PRESETS,
    FORM_DEFAULTS: FORM_DEFAULTS,
    detectFormFactor: detectFormFactor,
    suggest: suggest,
    suggestForHtml: suggestForHtml,
    flatPresets: flatPresets,
    version: VERSION,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
