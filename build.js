/* ============================================================================
 * build-plugin.js — 生成 Figma 插件用的自包含 UI
 *
 * 为什么需要构建：插件 UI 是 `figma.showUI(__html__)` 渲染的一坨 HTML 文本，
 * 页面的 document URL 不是文件路径，所以 `<script src="../core/engine.js">`
 * 这类相对路径外部脚本**加载不到** —— 表现就是界面能画出来、点哪儿都没反应。
 * 必须把脚本内联进同一个 HTML。
 *
 *   源码：plugin/ui.src.html   外部引用（供 test/build-harness.js 与日常维护）
 *   产物：plugin/ui.html       全部脚本内联；manifest.json 指向它
 *
 *   node build-plugin.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'plugin', 'ui.src.html');
const OUT = path.join(ROOT, 'plugin', 'ui.html');
const BANNER = '<!-- 本文件由 build-plugin.js 生成；请改 plugin/ui.src.html 后重新构建 -->';

function build() {
  const html = fs.readFileSync(SRC, 'utf8');
  const inlined = [];
  const missing = [];
  const re = /<script\s+src="([^"]+)"\s*>\s*<\/script>/gi;

  let out = html.replace(re, (match, src) => {
    const file = path.resolve(path.dirname(SRC), src);
    if (!fs.existsSync(file)) { missing.push(src); return match; }
    const code = fs.readFileSync(file, 'utf8');
    if (/<\/script/i.test(code)) {
      throw new Error(src + ' 里含有未转义的 </script 字面量，请写成 <\\/script>');
    }
    inlined.push(path.relative(ROOT, file).split(path.sep).join('/'));
    return '<script>\n/* ==== 内联：' + src + ' ==== */\n' + code + '\n<' + '/script>';
  });

  if (missing.length) throw new Error('找不到脚本：' + missing.join(', '));
  if (!inlined.length) throw new Error('ui.src.html 里没有可内联的 <script src>');

  /* 注释不能跑到 <!doctype> 前面，否则会掉进怪异模式 */
  if (/^<!doctype[^>]*>/i.test(out)) out = out.replace(/^(<!doctype[^>]*>)/i, '$1\n' + BANNER);
  else out = BANNER + '\n' + out;

  fs.writeFileSync(OUT, out, 'utf8');
  return { outPath: OUT, inlined: inlined, bytes: Buffer.byteLength(out) };
}

if (require.main === module) {
  try {
    const r = build();
    console.log('plugin/ui.html 已生成（自包含，' + (r.bytes / 1024).toFixed(1) + ' KB）');
    r.inlined.forEach((f) => console.log('  · ' + f));
  } catch (e) {
    console.error('构建失败：' + (e && e.message || e));
    process.exit(1);
  }
}

module.exports = { build: build };
