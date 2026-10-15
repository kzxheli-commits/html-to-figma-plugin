/* ============================================================================
 * core/flow.js — 多页全景交互画布 + 整包交互树（JSON）
 *
 * 把 core/interactions.js 抽出来的跳转关系，画成一张 Figma 里可以直接看的
 * 「原型全景图」：所有页面并排成画板，页面之间的跳转用贝塞尔连线连起来，
 * 触发按钮上叠一个蓝色热区框，连线中点挂一枚「点击 → 目标页」标签。
 *
 * 产出两件事：
 *   build()  → 一张完整 SVG（拖进 Figma 就是可编辑矢量图层，含连线）
 *   toJson() → 整包结构树（页面 / 尺寸 / 图层树 / 交互 / hover 规则）
 *
 * 纯字符串处理，不碰 DOM，Node 里可直接单测。
 * ========================================================================== */
(function (global) {
  'use strict';

  const BLUE = '#2563EB';
  const AMBER = '#D97706';
  const VIOLET = '#7C3AED';
  const SLATE = '#64748B';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function num(n, d) {
    const v = Number(n);
    return isFinite(v) ? v : (d || 0);
  }

  /**
   * 给一份 SVG 里的所有 id 加前缀 —— 多页拼一张画布时，各页 defs 的
   * gradient / filter id 极容易重名，重名就是渲染错乱。
   */
  function prefixIds(svg, prefix) {
    const src = String(svg || '');
    const ids = [];
    const re = /\sid="([^"]+)"/g;
    let m;
    while ((m = re.exec(src))) ids.push(m[1]);
    if (!ids.length) return src;

    let out = src;
    for (const id of ids) {
      const q = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\sid="' + q + '"', 'g'), ' id="' + prefix + id + '"');
      out = out.replace(new RegExp('url\\(#' + q + '\\)', 'g'), 'url(#' + prefix + id + ')');
      out = out.replace(new RegExp('href="#' + q + '"', 'g'), 'href="#' + prefix + id + '"');
      out = out.replace(new RegExp("xlink:href=\"#" + q + '"', 'g'), 'xlink:href="#' + prefix + id + '"');
      out = out.replace(new RegExp("begin=\"#" + q + '"', 'g'), 'begin="#' + prefix + id + '"');
      out = out.replace(new RegExp("clip-path=\"url\\(#" + q + "\\)\"", 'g'), 'clip-path="url(#' + prefix + id + ')"');
    }
    return out;
  }

  /** 把整份单页 SVG 变成嵌在外层画布里的嵌套 <svg>（保留 viewBox 以便缩放）。 */
  function nest(svg, x, y, w, h, prefix) {
    const withIds = prefix ? prefixIds(svg, prefix) : String(svg || '');
    const at = withIds.indexOf('<svg');
    if (at < 0) return '';
    const head = withIds.slice(0, at);
    const rest = withIds.slice(at);
    const cleaned = rest.replace(/^<svg\b[^>]*/, (tag) => tag
      .replace(/\s(?:width|height|x|y)\s*=\s*"[^"]*"/gi, ''));
    return head + cleaned.replace(/^<svg\b/, '<svg x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"');
  }

  const ACTION_STYLE = {
    NAVIGATE: { color: BLUE, label: '点击', dash: '' },
    ROUTE: { color: '#0EA5E9', label: '路由', dash: '4 2' },
    OPEN_OVERLAY: { color: AMBER, label: '弹层', dash: '4 2' },
    SUBMIT: { color: VIOLET, label: '提交', dash: '5 3' },
    EXTERNAL: { color: SLATE, label: '外链', dash: '2 3' },
    BACK: { color: SLATE, label: '返回', dash: '2 3' },
    SCRIPT: { color: VIOLET, label: '脚本', dash: '1 3' },
  };

  const DEFAULT_OPTS = {
    pad: 72,
    gapX: 200,
    gapY: 96,
    titleH: 46,
    bg: '#F8FAFC',
    pageBg: '#FFFFFF',
    pageBorder: '#E2E8F0',
  };

  /**
   * pages: [{ name, w, h, svg, interactions: [{action,target,rect,layer,text}] }]
   * 返回 { svg, w, h, wires, pages: [{name,x,y,w,h}] }
   */
  function build(pages, options) {
    const opts = Object.assign({}, DEFAULT_OPTS, options || {});
    const list = (pages || []).filter((p) => p && p.svg && num(p.w) > 0 && num(p.h) > 0);
    if (!list.length) return { svg: '', w: 0, h: 0, wires: [], pages: [] };

    const placed = [];
    let cursorX = opts.pad;
    let maxH = 0;

    list.forEach((p, i) => {
      const w = Math.round(num(p.w));
      const h = Math.round(num(p.h));
      placed.push({ page: p, index: i, x: cursorX, y: opts.pad + opts.titleH, w: w, h: h });
      cursorX += w + opts.gapX;
      if (h > maxH) maxH = h;
    });

    const canvasW = cursorX - opts.gapX + opts.pad;
    const canvasH = opts.pad + opts.titleH + maxH + opts.pad;

    const body = [];
    const wires = [];

    for (const pl of placed) {
      const p = pl.page;
      const idTag = esc(p.name || ('page-' + (pl.index + 1)));
      body.push(
        '<g id="Artboard_' + idTag + '" transform="translate(' + pl.x + ', ' + pl.y + ')">'
        + '<text x="0" y="-18" font-family="sans-serif" font-size="13" font-weight="700" fill="#0F172A">'
        + (pl.index + 1) + '. ' + idTag + '</text>'
        + '<text x="0" y="-5" font-family="sans-serif" font-size="11" fill="#64748B">'
        + pl.w + ' × ' + pl.h + '</text>'
        + '<rect x="0" y="0" width="' + pl.w + '" height="' + pl.h + '" fill="' + opts.pageBg + '" stroke="' + opts.pageBorder + '" stroke-width="1"/>'
        + nest(p.svg, 0, 0, pl.w, pl.h, 'p' + (pl.index + 1) + '_')
        + '</g>'
      );
    }

    // 目标页 → 位置索引
    const byName = new Map();
    for (const pl of placed) byName.set(String(pl.page.name || ''), pl);

    for (const pl of placed) {
      const p = pl.page;
      const links = p.interactions || [];
      links.forEach((link, li) => {
        const style = ACTION_STYLE[link.action] || ACTION_STYLE.SCRIPT;
        const r = link.rect || { x: 0, y: 0, w: 0, h: 0 };
        const hotX = pl.x + num(r.x);
        const hotY = pl.y + num(r.y);
        const hotW = num(r.w);
        const hotH = num(r.h);
        if (hotW <= 0 || hotH <= 0) return;

        const dst = byName.get(String(link.target || ''));
        const wireId = 'Wire_' + esc(p.name) + '_' + li;

        // 触发元素热区
        wires.push(
          '<g id="' + wireId + '">'
          + '<rect x="' + hotX + '" y="' + hotY + '" width="' + hotW + '" height="' + hotH + '" rx="6" fill="' + style.color
          + '" fill-opacity="0.08" stroke="' + style.color + '" stroke-width="1.5"'
          + (style.dash ? ' stroke-dasharray="' + style.dash + '"' : '') + '/>'
        );

        if (dst) {
          const goingRight = dst.x >= pl.x;
          const startX = goingRight ? hotX + hotW : hotX;
          const startY = hotY + hotH / 2;
          const endX = goingRight ? dst.x : dst.x + dst.w;
          const endY = dst.y + Math.min(120 + li * 34, Math.max(40, dst.h * 0.5));
          const ctrl = Math.max(70, Math.abs(endX - startX) * 0.42);
          const c1x = goingRight ? startX + ctrl : startX - ctrl;
          const c2x = goingRight ? endX - ctrl : endX + ctrl;
          const midX = (startX + endX) / 2;
          const midY = (startY + endY) / 2 - 12;
          const label = style.label + ' → ' + String(link.target || '');

          wires.push(
            '<circle cx="' + startX + '" cy="' + startY + '" r="4.5" fill="' + style.color + '" stroke="#FFFFFF" stroke-width="1.5"/>'
            + '<path d="M ' + startX + ' ' + startY + ' C ' + c1x + ' ' + startY + ', ' + c2x + ' ' + endY + ', ' + endX + ' ' + endY
            + '" fill="none" stroke="' + style.color + '" stroke-width="2" marker-end="url(#h2f_arrow)"/>'
            + '<rect x="' + (midX - 58) + '" y="' + (midY - 11) + '" width="116" height="22" rx="11" fill="' + style.color + '"/>'
            + '<text x="' + midX + '" y="' + (midY + 4) + '" text-anchor="middle" fill="#FFFFFF" font-family="sans-serif" font-size="10.5" font-weight="600">'
            + esc(label.length > 18 ? label.slice(0, 17) + '…' : label) + '</text>'
          );
        } else {
          const tag = link.action === 'OPEN_OVERLAY'
            ? '弹层 ' + esc(link.target || '')
            : (style.label + (link.target ? ' ' + esc(String(link.target).slice(0, 20)) : ''));
          wires.push(
            '<text x="' + hotX + '" y="' + (hotY - 6) + '" font-family="sans-serif" font-size="10" font-weight="700" fill="' + style.color + '">'
            + tag + '</text>'
          );
        }

        wires.push('</g>');
        wires.push('<title>' + esc((link.layer || '') + ' · ' + (link.action || '')) + '</title>');
      });
    }

    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + canvasW + '" height="' + canvasH + '" viewBox="0 0 ' + canvasW + ' ' + canvasH + '" fill="none">',
      '<defs><marker id="h2f_arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 8 5 L 0 9 z" fill="' + BLUE + '"/></marker></defs>',
      '<rect id="Flow_Bg" x="0" y="0" width="' + canvasW + '" height="' + canvasH + '" fill="' + opts.bg + '"/>',
      '<g id="All_Pages">' + body.join('\n') + '</g>',
      '<g id="Prototype_Links">' + wires.join('\n') + '</g>',
      '</svg>',
    ].join('\n');

    return {
      svg: svg,
      w: canvasW,
      h: canvasH,
      pages: placed.map((pl) => ({ name: pl.page.name, x: pl.x, y: pl.y, w: pl.w, h: pl.h })),
      wires: placed.reduce((n, pl) => n + ((pl.page.interactions || []).length), 0),
    };
  }

  /** 把引擎的图层快照压成可读 JSON 树（只留对复刻有意义、体积可控的字段）。 */
  function mapNode(rec, depth) {
    if (!rec || depth > 60) return null;
    const out = {
      name: rec.name || '',
      type: rec.type || '',
      x: rec.x, y: rec.y, w: rec.w, h: rec.h,
    };
    if (rec.rotation) out.rotation = rec.rotation;
    if (rec.opacity != null && rec.opacity !== 1) out.opacity = rec.opacity;
    if (rec.fills && rec.fills.length) out.fills = rec.fills;
    if (rec.strokes && rec.strokes.length) out.strokes = rec.strokes;
    if (rec.effects && rec.effects.length) out.effects = rec.effects;
    if (rec.characters != null) out.characters = rec.characters;
    if (rec.fontSize) out.fontSize = rec.fontSize;
    if (rec.fontName) out.fontName = rec.fontName;
    if (rec.svg) out.svg = rec.svg.slice(0, 20000);
    if (rec.children && rec.children.length) {
      out.children = rec.children.map((c) => mapNode(c, depth + 1)).filter(Boolean);
    }
    return out;
  }

  /**
   * 整包交互树。
   * pages: [{ name, w, h, payload, interactions, hoverRules, warnings, svgBytes }]
   */
  function toJson(pages, options) {
    const opts = options || {};
    const list = pages || [];
    const interactions = [];
    for (const p of list) {
      for (const it of (p.interactions || [])) interactions.push(it);
    }
    return {
      tool: 'html-to-figma',
      format: 'h2f.package/v1',
      generatedAt: opts.generatedAt || new Date().toISOString(),
      canvas: opts.canvas || null,
      summary: {
        pages: list.length,
        interactions: interactions.length,
        hoverStates: list.reduce((n, p) => n + ((p.hoverRules || []).length), 0),
      },
      interactions: interactions,
      pages: list.map((p) => ({
        name: p.name,
        width: p.w,
        height: p.h,
        svgBytes: p.svgBytes || (p.svg ? p.svg.length : 0),
        hoverStates: p.hoverRules || [],
        hoverStateDiffs: p.states || [],
        warnings: p.warnings || [],
        interactions: p.interactions || [],
        root: p.tree || (p.payload && p.payload.root ? mapNode(p.payload.root, 0) : null),
      })),
    };
  }

  global.H2FFlow = {
    build: build,
    toJson: toJson,
    mapNode: mapNode,
    prefixIds: prefixIds,
    nest: nest,
  };
})(typeof window !== 'undefined' ? window : globalThis);
