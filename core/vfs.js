/* ============================================================================
 * core/vfs.js — 整包解析：ZIP / 文件夹 / 多文件 → 虚拟文件系统（VFS）
 *
 * 解决的问题：浏览器只能拿到「一个 HTML 字符串」，本地项目里的
 *   <link rel="stylesheet" href="styles/app.css">
 *   <img src="../images/logo.png">
 * 这类相对路径在沙箱里必然取不到（原 README 的已知限制）。
 *
 * 做法：把用户拖进来的整个项目包（.zip / 文件夹 / 多选文件）在内存里解开，
 * 按扩展名分拣成 html / css / assets 三张表，再在交给渲染引擎之前把外部 CSS
 * 内联成 <style>、把图片与字体内联成 dataURL —— 于是引擎拿到的是一个
 * 「自给自足」的 HTML，相对路径问题在进入引擎之前就被消掉了。
 *
 * 本文件是纯逻辑（不碰 DOM、不碰 Figma），Node 里可直接单测：
 *   const vfs = H2FVfs.create(); await vfs.ingest([{ path, bytes }]);
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------- 路径工具 ------------------------------ */

  function normalizePath(p) {
    return String(p == null ? '' : p)
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg && seg !== '.')     // 丢掉空段与 ./
      .join('/');
  }

  function dirOf(p) {
    const s = normalizePath(p);
    const i = s.lastIndexOf('/');
    return i < 0 ? '' : s.slice(0, i);
  }

  function baseOf(p) {
    const s = normalizePath(p);
    const i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  /** 相对路径解析：./ ../ / 与 query/hash 都会被处理；外部协议一律返回 null。 */
  function resolve(baseFile, target) {
    if (target == null) return null;
    const t = String(target).trim();
    if (!t) return null;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) return null;   // http(s): data: blob: mailto: …
    if (t.startsWith('#')) return null;                          // 页内锚点
    const clean = t.split('?')[0].split('#')[0];
    if (!clean) return null;
    const stack = clean.startsWith('/') ? [] : dirOf(baseFile).split('/').filter(Boolean);
    for (const part of clean.replace(/^\/+/, '').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return stack.join('/');
  }

  /** 去掉「整个包被多套了一层文件夹」的那层前缀（拖文件夹时很常见）。 */
  function stripCommonRoot(paths) {
    const list = paths.map(normalizePath).filter(Boolean);
    if (list.length < 2) return (p) => normalizePath(p);
    const split = list.map((p) => p.split('/'));
    if (split.some((s) => s.length < 2)) return (p) => normalizePath(p);
    const tops = new Set(split.map((s) => s[0]));
    if (tops.size !== 1) return (p) => normalizePath(p);
    return (p) => normalizePath(p).split('/').slice(1).join('/');
  }

  /* ------------------------------- 类型工具 ------------------------------ */

  const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
    svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  };

  const TEXT_EXT = { html: 1, htm: 1, css: 1, js: 1, mjs: 1 };

  function extOf(p) {
    const m = /\.([a-z0-9]+)$/i.exec(baseOf(p));
    return m ? m[1].toLowerCase() : '';
  }

  function mimeOf(p) {
    return MIME[extOf(p)] || 'application/octet-stream';
  }

  /** 字节 → dataURL。浏览器走 FileReader，Node（单测）走 Buffer。 */
  function toDataUrl(bytes, mime) {
    const m = mime || 'application/octet-stream';
    if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([bytes], { type: m });
      return new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
    }
    if (typeof Buffer !== 'undefined') {
      return Promise.resolve('data:' + m + ';base64,' + Buffer.from(bytes).toString('base64'));
    }
    return Promise.resolve(null);
  }

  /** UTF-8 解码失败时退回 GBK（中文 Windows 导出的老项目很常见）。 */
  function decodeText(bytes) {
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    if (utf8.indexOf('\ufffd') < 0) return utf8;
    try {
      const gbk = new TextDecoder('gbk').decode(bytes);
      return gbk.indexOf('\ufffd') <= utf8.indexOf('\ufffd') ? gbk : utf8;
    } catch (e) {
      return utf8;
    }
  }

  /* -------------------------------- ZIP --------------------------------- */

  const EOCD_SIG = 0x06054b50;      // End of Central Directory
  const CD_SIG = 0x02014b50;        // Central Directory file header
  const EOCD64_SIG = 0x06064b50;    // ZIP64 End of Central Directory record
  const EOCD64_LOC_SIG = 0x07064b50; // ZIP64 End of Central Directory locator
  const SENTINEL32 = 0xffffffff;
  const SENTINEL16 = 0xffff;

  /** 读 64 位小端整数（ZIP64 的尺寸与偏移都是这个宽度）。 */
  function readU64(view, at) {
    if (typeof view.getBigUint64 === 'function') return Number(view.getBigUint64(at, true));
    const lo = view.getUint32(at, true);
    const hi = view.getUint32(at + 4, true);
    return hi * 4294967296 + lo;
  }

  /**
   * 手写 ZIP 解析：零第三方库，只依赖 DecompressionStream('deflate-raw')。
   * 支持 store(0) 与 deflate(8)；ZIP64 / 加密 / 其他压缩法会明确报出来。
   */
  async function unzip(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);

    let eocd = -1;
    const floor = Math.max(0, bytes.length - 66000);
    for (let i = bytes.length - 22; i >= floor; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('不是有效的 ZIP 文件（找不到中央目录结尾）');

    const count32 = view.getUint16(eocd + 10, true);
    let count = count32;
    let cd = view.getUint32(eocd + 16, true);
    let zip64 = false;

    /* ZIP64：条目数与中央目录偏移在 EOCD 里会退化成 0xffff / 0xffffffff，
       真实值在紧邻 EOCD 之前的「ZIP64 EOCD 定位器」所指的记录里。
       触发条件＝字段是哨兵值，或者定位器确实存在（有些工具即使没超限也会写 ZIP64）。 */
    const hasLocator = eocd >= 20 && view.getUint32(eocd - 20, true) === EOCD64_LOC_SIG;
    if (count32 === SENTINEL16 || cd === SENTINEL32 || hasLocator) {
      if (hasLocator) {
        const z64At = readU64(view, eocd - 20 + 8);
        if (z64At > 0 && z64At + 56 <= bytes.length && view.getUint32(z64At, true) === EOCD64_SIG) {
          count = readU64(view, z64At + 32);   // total entries
          cd = readU64(view, z64At + 48);      // central directory offset
          zip64 = true;
        }
      }
      if (!zip64) {
        throw new Error('这是 ZIP64 压缩包但结构不完整（找不到 ZIP64 中央目录记录）：请改用「拖入文件夹」导入，或重新打包');
      }
    }
    if (!(count >= 0) || !(cd >= 0) || cd + 46 > bytes.length) {
      throw new Error('zip 中央目录位置异常，文件可能已损坏');
    }

    const out = [];
    const skipped = [];
    const decoder = new TextDecoder('utf-8');
    const canDeflate = typeof DecompressionStream === 'function';

    for (let i = 0; i < count; i++) {
      if (cd + 46 > bytes.length || view.getUint32(cd, true) !== CD_SIG) break;
      const method = view.getUint16(cd + 10, true);
      let compSize = view.getUint32(cd + 20, true);
      let uncompSize = view.getUint32(cd + 24, true);
      const diskStart = view.getUint16(cd + 34, true);
      const nameLen = view.getUint16(cd + 28, true);
      const extraLen = view.getUint16(cd + 30, true);
      const commentLen = view.getUint16(cd + 32, true);
      let localOffset = view.getUint32(cd + 42, true);

      /* ZIP64 条目：被顶成哨兵值的字段按规范固定顺序出现在 0x0001 扩展块里
         （未压缩大小 → 压缩大小 → 本地头偏移 → 磁盘号，只写「被顶掉」的那些） */
      if (compSize === SENTINEL32 || uncompSize === SENTINEL32 || localOffset === SENTINEL32 || diskStart === SENTINEL16) {
        const extraAt = cd + 46 + nameLen;
        const extraEnd = extraAt + extraLen;
        let p = extraAt;
        while (p + 4 <= extraEnd) {
          const hid = view.getUint16(p, true);
          const hsz = view.getUint16(p + 2, true);
          if (hid === 0x0001) {
            let q = p + 4;
            if (uncompSize === SENTINEL32) { uncompSize = readU64(view, q); q += 8; }
            if (compSize === SENTINEL32) { compSize = readU64(view, q); q += 8; }
            if (localOffset === SENTINEL32) { localOffset = readU64(view, q); q += 8; }
            break;
          }
          p += 4 + hsz;
        }
      }

      const name = decoder.decode(bytes.subarray(cd + 46, cd + 46 + nameLen));
      cd += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue;                       // 目录项
      if (/(^|\/)__MACOSX\//.test(name)) continue;            // macOS 元数据
      if (/(^|\/)\.DS_Store$/.test(name)) continue;
      if (/(^|\/)\.[^/]*$/.test(name)) continue;              // 隐藏文件

      if (localOffset + 30 > bytes.length) { skipped.push(name + '（本地文件头越界，已跳过）'); continue; }
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const slice = bytes.subarray(dataStart, dataStart + compSize);

      if (method === 0) {
        out.push({ path: name, bytes: slice.slice() });
      } else if (method === 8) {
        if (!canDeflate) { skipped.push(name + '（本浏览器不支持 DecompressionStream）'); continue; }
        try {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(slice);
          writer.close();
          const buf = await new Response(ds.readable).arrayBuffer();
          out.push({ path: name, bytes: new Uint8Array(buf) });
        } catch (e) {
          skipped.push(name + '（解压失败：' + (e && e.message ? e.message : e) + '）');
        }
      } else {
        skipped.push(name + '（压缩方式 ' + method + ' 不支持，仅支持 store/deflate）');
      }
    }
    return { entries: out, skipped: skipped, zip64: zip64 };
  }

  /* ----------------------------- 文件收集 ------------------------------- */

  /** 拖拽进入的 DataTransfer → [{path, file}]，递归展开文件夹。 */
  async function collectFromDataTransfer(dataTransfer) {
    const items = dataTransfer && dataTransfer.items;
    const out = [];
    if (items && items.length && items[0].webkitGetAsEntry) {
      const walk = async (entry, prefix) => {
        if (!entry) return;
        if (entry.isFile) {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          out.push({ path: prefix + file.name, file: file });
          return;
        }
        if (entry.isDirectory) {
          const reader = entry.createReader();
          /* readEntries 每次只返回一批，必须读到空为止，否则大文件夹会被截断 */
          for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const child of batch) await walk(child, prefix + entry.name + '/');
          }
        }
      };
      for (let i = 0; i < items.length; i++) await walk(items[i].webkitGetAsEntry(), '');
      return out;
    }
    const files = dataTransfer && dataTransfer.files ? dataTransfer.files : [];
    return Array.from(files).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
  }

  /** <input type=file multiple> / <input webkitdirectory> → [{path, file}] */
  function collectFromFileList(fileList) {
    return Array.from(fileList || []).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
  }

  /**
   * 这是不是一个「浏览器 File / Blob 形态」的条目？
   *
   * 别用 `'bytes' in x` 来判断 —— Chromium 116+ / Node 20+ 的 File.prototype 上有
   * bytes() 方法，那样会把 File 误判成我们自己的 {path, bytes} 条目：
   * 结果就是 FileList 路径下每个条目既没有 path 也没有 file，被整批静默跳过
   * （症状是「这个包里没有找到 HTML 页面」，而拖入同一份 zip 却正常）。
   */
  function isFileLike(x) {
    return !!x && typeof x === 'object'
      && typeof x.arrayBuffer === 'function'
      && typeof x.name === 'string'
      && !(x.bytes instanceof Uint8Array);
  }

  /* -------------------------------- VFS --------------------------------- */

  function note(list, msg) {
    if (list.indexOf(msg) < 0) list.push(msg);
  }

  function create() {
    const html = new Map();        // path -> string
    const css = new Map();         // path -> string
  const scripts = new Map();     // path -> string（本地 .js：整包导入时会被内联进页面）
    const assets = new Map();      // path -> dataURL
    const lowerIndex = new Map();  // 小写路径 -> 真实路径（大小写不敏感查找）
    let lastStats = { html: 0, css: 0, assets: 0, bytes: 0, skipped: [] };

    function remember(path) {
      lowerIndex.set(path.toLowerCase(), path);
    }

    function realPathOf(path) {
      if (!path) return null;
      if (html.has(path) || css.has(path) || assets.has(path)) return path;
      return lowerIndex.get(String(path).toLowerCase()) || null;
    }

    function lookup(path) {
      const real = realPathOf(path);
      if (!real) return null;
      if (html.has(real)) return { kind: 'html', text: html.get(real), path: real };
      if (css.has(real)) return { kind: 'css', text: css.get(real), path: real };
    if (scripts.has(real)) return { kind: 'js', text: scripts.get(real), path: real };
      if (assets.has(real)) return { kind: 'asset', url: assets.get(real), path: real };
      return null;
    }

    /**
     * 载入一批文件或 ZIP。
     * items: [{path, bytes}] 或 [{path, file}]；也接受裸 FileList / DataTransfer。
     */
    async function ingest(input, onProgress) {
      let items = input;
      if (input && input.items && input.items.length && input.items[0].webkitGetAsEntry) {
        items = await collectFromDataTransfer(input);
      } else if (input && typeof input.length === 'number' && input.length && isFileLike(input[0])) {
        items = collectFromFileList(input);
      }

      const raw = [];
      const skipped = [];
      for (const it of items || []) {
        if (!it) continue;
        const path = normalizePath(it.path || (it.file && it.file.name) || it.name || '');
        if (!path) continue;

        /* it.bytes 必须是真正的字节容器：File 上也有 bytes() 方法，别把函数当数据 */
        let bytes = (it.bytes instanceof Uint8Array) ? it.bytes
          : (it.bytes instanceof ArrayBuffer) ? new Uint8Array(it.bytes)
            : null;
        if (!bytes && it.file && typeof it.file.arrayBuffer === 'function') {
          bytes = new Uint8Array(await it.file.arrayBuffer());
        }
        if (!bytes && typeof it.arrayBuffer === 'function') {
          bytes = new Uint8Array(await it.arrayBuffer());   // 直接传进来的 File / Blob
        }
        if (!bytes) continue;

        if (/\.zip$/i.test(path)) {
          if (onProgress) onProgress('解压 ' + baseOf(path));
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const res = await unzip(buf);
          Array.prototype.push.apply(raw, res.entries);
          Array.prototype.push.apply(skipped, res.skipped);
        } else {
          raw.push({ path: path, bytes: bytes });
        }
      }

      const strip = stripCommonRoot(raw.map((e) => e.path));
      const seen = new Set();
      for (const e of raw) {
        const path = strip(e.path);
        if (!path || seen.has(path)) continue;
        const ext = extOf(path);
        if (TEXT_EXT[ext]) {
          if (ext === 'css') css.set(path, decodeText(e.bytes));
          else if (ext === 'js' || ext === 'mjs') scripts.set(path, decodeText(e.bytes));
          else html.set(path, decodeText(e.bytes));
          remember(path);
          seen.add(path);
        } else if (MIME[ext]) {
          const url = await toDataUrl(e.bytes, MIME[ext]);
          if (url) { assets.set(path, url); remember(path); seen.add(path); }
        } else {
          skipped.push(path + '（未识别的类型，已忽略）');
        }
      }

      lastStats = {
        html: html.size,
        css: css.size,
        assets: assets.size,
        bytes: Array.from(html.values()).reduce((n, s) => n + s.length, 0)
             + Array.from(css.values()).reduce((n, s) => n + s.length, 0)
             + Array.from(assets.values()).reduce((n, s) => n + s.length, 0),
        skipped: skipped,
      };
      return lastStats;
    }

    function pages() {
      return Array.from(html.keys()).sort().map((path) => ({ path: path, rawHtml: html.get(path) }));
    }

    function stats() {
      return {
        html: lastStats.html,
        css: lastStats.css,
        assets: lastStats.assets,
        bytes: lastStats.bytes,
        skipped: lastStats.skipped.slice(),
      };
    }

    /* ---------------------------- 内联（bundle） -------------------------- */

    const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

    /** 去掉 CSS 注释（保留字符串内容）：注释里写 `@import` 或 `url()` 的样式表很常见，
        不先剥掉就会被当成真的导入 —— 实测踩过：注释里的 @import 把后面那条真的
        @import 一起吃掉，整个 base.css 都没被内联，页面直接变成「没有基础样式」。 */
    function stripCssComments(text) {
      let out = '';
      let i = 0;
      const n = text.length;
      let quote = null;
      while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (quote) {
          out += c;
          if (c === '\\') { out += (c2 || ''); i += 2; continue; }
          if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
        if (c === '/' && c2 === '*') { while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
        out += c;
        i++;
      }
      return out;
    }

    /** CSS 文本里的 @import / url(...) 就地替换为 VFS 内容。 */
    async function inlineCss(text, cssPath, depth, missing) {
      let out = stripCssComments(text);

      const imports = [];
      out.replace(/@import\s+(?:url\(\s*)?['"]?([^'");]+)['"]?\s*\)?\s*;?/gi, (m, href) => {
        imports.push({ m: m, href: href });
        return m;
      });
      for (const imp of imports) {
        if (depth >= 5) break;
        const target = resolve(cssPath, imp.href);
        const hit = target ? lookup(target) : null;
        if (hit && hit.kind === 'css') {
          out = out.replace(imp.m, await inlineCss(hit.text, hit.path, depth + 1, missing));
        } else if (target) {
          note(missing, target + '（@import 未找到）');
        }
      }

      const jobs = [];
      out.replace(URL_RE, (m, q, url) => { jobs.push({ m: m, url: url }); return m; });
      for (const job of jobs) {
        const target = resolve(cssPath, job.url);
        if (!target) continue;
        const hit = lookup(target);
        if (hit && hit.kind === 'asset') out = out.replace(job.m, 'url("' + hit.url + '")');
        else if (hit && hit.kind === 'css') out = out.replace(job.m, 'url("' + hit.path + '")');
        else note(missing, target + '（CSS 引用的资源未找到）');
      }
      return out;
    }

    /* 需要内联的属性：src / poster / data-src / xlink:href 一律处理；
       href 只对「标签本身就是资源」的情况处理 —— <a href> 是页面跳转，
       绝不能当资源替换成 dataURL（否则导航信息会被抹掉）。 */
    const RES_ATTR = { src: 1, poster: 1, 'data-src': 1, 'xlink:href': 1 };
    const HREF_AS_RES = { link: 1, image: 1, use: 1, feimage: 1 };

    async function inlineTagAttrs(tag, tagHtml, pagePath, missing) {
      let out = tagHtml;
      const jobs = [];
      const attrRe = /\s([a-zA-Z:-]+)\s*=\s*(["'])([^"']*)\2/g;
      let m;
      while ((m = attrRe.exec(tagHtml))) {
        const name = m[1].toLowerCase();
        if ((RES_ATTR[name] || (name === 'href' && HREF_AS_RES[tag])) && m[3]) {
          jobs.push({ full: m[0], url: m[3] });
        }
      }
      for (const job of jobs) {
        const target = resolve(pagePath, job.url);
        if (!target) continue;
        const hit = lookup(target);
        if (hit && hit.kind === 'asset') out = out.replace(job.full, job.full.replace(job.url, hit.url));
        else if (hit && hit.kind === 'css') out = out.replace(job.full, job.full.replace(job.url, hit.path));
        else note(missing, target + '（' + baseOf(target) + ' 未找到）');
      }

      // srcset：逐个候选替换
      const ssRe = /\ssrcset\s*=\s*(["'])([^"']+)\1/gi;
      const ssJobs = [];
      while ((m = ssRe.exec(out))) ssJobs.push({ full: m[0], list: m[2] });
      for (const job of ssJobs) {
        const parts = job.list.split(',').map((seg) => {
          const sp = seg.trim().split(/\s+/);
          const target = resolve(pagePath, sp[0] || '');
          const hit = target ? lookup(target) : null;
          if (hit && hit.kind === 'asset') sp[0] = hit.url;
          return sp.join(' ');
        });
        const next = ' srcset="' + parts.join(', ') + '"';
        if (next !== job.full) out = out.replace(job.full, next);
      }

      /* style="…" 里的 url()：属性值外面用双引号、里面写 url('a.png') 是最常见的写法，
         所以这里不能把单引号排除在「属性值」之外 —— 先整段取值，再交给 inlineCss 处理 */
      const stRe = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
      const stJobs = [];
      while ((m = stRe.exec(out))) {
        if (m[2].indexOf('url(') < 0) continue;
        stJobs.push({ full: m[0], cssText: m[2] });
      }
      for (const job of stJobs) {
        /* 属性值里的引号可能写成 HTML 实体（&quot; / &#39;），先解码再进 CSS 处理；
           写回时必须重新编码，否则 " 会提前结束属性值 */
        const decoded = job.cssText
          .replace(/&quot;/gi, '"')
          .replace(/&apos;/gi, "'")
          .replace(/&#39;/g, "'");
        const replaced = await inlineCss(decoded, pagePath, 0, missing);
        if (replaced !== decoded) {
          const reenc = replaced.replace(/"/g, '&quot;');
          out = out.replace(job.full, job.full.replace(job.cssText, reenc));
        }
      }
      return out;
    }

    /**
     * 把本地外链脚本内联进页面（外链 http(s) / data: / blob: 一律不动）。
     *
     * 真实站点（尤其导出的 SPA）常常把交互写在外链 JS 里，如果不内联，
     * 整包导入后脚本根本加载不到 —— 表现就是「运行时路由探测一条都抓不到」。
     */
    function inlineLocalScripts(htmlText, pagePath, missing) {
      const re = /<script\b([^>]*?)\ssrc\s*=\s*(["'])([^"']+)\2([^>]*?)>\s*<\/script\s*>/gi;
      const jobs = [];
      let m;
      while ((m = re.exec(htmlText))) jobs.push({ full: m[0], src: m[3] });
      if (!jobs.length) return htmlText;

      let out = htmlText;
      for (const job of jobs) {
        const src = String(job.src).trim();
        if (!src || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) || /^(?:data|blob):/i.test(src)) continue;
        const target = resolve(pagePath, src);
        if (!target) continue;
        const hit = lookup(target);
        if (!hit || hit.text == null) {
          note(missing, target + '（' + baseOf(target) + ' 未找到）');
          continue;
        }
        /* 脚本内容里的结束标签必须转义，否则会提前结束这个标签 */
        const safe = String(hit.text).replace(/<\/script/gi, '<\\/script');
        out = out.replace(job.full, '<script>' + safe + '<' + '/script>');
      }
      return out;
    }

    /** 逐开始标签处理：<link stylesheet> → <style>；资源属性 → dataURL。 */
    async function inlineAttr(htmlText, pagePath, missing) {
      /* 先把本地外链脚本内联进来，后面跳过 script 段时才不会把交互一起跳掉 */
      htmlText = inlineLocalScripts(htmlText, pagePath, missing);
      /* script / 注释 / CDATA 里的 "<xxx>" 不是标签，先标记出来整段跳过 */
      const skip = [];
      const skipRe = /<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/gi;
      let s;
      while ((s = skipRe.exec(htmlText))) skip.push([s.index, s.index + s[0].length]);
      const inSkip = (i) => skip.some((r) => i >= r[0] && i < r[1]);

      const tagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
      let out = '';
      let last = 0;
      let m;
      while ((m = tagRe.exec(htmlText))) {
        if (inSkip(m.index)) continue;
        const full = m[0];
        const tag = m[1].toLowerCase();
        const attrs = m[2];
        let replacement = full;

        if (tag === 'link' && /rel\s*=\s*["']?[^"'>]*stylesheet/i.test(attrs)) {
          const hrefM = /href\s*=\s*(["'])([^"']+)\1/i.exec(attrs);
          if (hrefM) {
            const target = resolve(pagePath, hrefM[2]);
            const hit = target ? lookup(target) : null;
            if (hit && hit.kind === 'css') {
              const body = await inlineCss(hit.text, hit.path, 0, missing);
              replacement = '<style data-h2f-from="' + hit.path + '">\n' + body + '\n</style>';
            } else if (target) {
              note(missing, target + '（<link> 未找到）');
            }
          }
        } else {
          replacement = await inlineTagAttrs(tag, full, pagePath, missing);
        }

        out += htmlText.slice(last, m.index) + replacement;
        last = m.index + full.length;
      }
      out += htmlText.slice(last);

      // 内联 <style> 块里的 url()
      const blocks = [];
      out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (mm, body) => { blocks.push({ full: mm, body: body }); return mm; });
      for (const blk of blocks) {
        const replaced = await inlineCss(blk.body, pagePath, 0, missing);
        if (replaced !== blk.body) out = out.replace(blk.full, blk.full.replace(blk.body, replaced));
      }
      return out;
    }

    /**
     * 把一整页打成自给自足的 HTML。
     * 返回 { html, inlined, missing }：missing 是没解析到的相对路径清单。
     */
    async function bundle(path) {
      const real = realPathOf(path) || path;
      const raw = html.get(real);
      if (raw == null) throw new Error('VFS 里没有这个页面：' + path);
      const missing = [];
      const body = await inlineAttr(raw, real, missing);
      return {
        html: body,
        inlined: { page: real, css: css.size, assets: assets.size, missing: missing.length },
        missing: missing,
      };
    }

    function clear() {
      html.clear(); css.clear(); assets.clear(); lowerIndex.clear();
      lastStats = { html: 0, css: 0, assets: 0, bytes: 0, skipped: [] };
    }

    return {
      ingest: ingest,
      bundle: bundle,
      pages: pages,
      stats: stats,
      lookup: lookup,
      resolve: resolve,
      clear: clear,
      keys: function () {
        return { html: Array.from(html.keys()), css: Array.from(css.keys()), assets: Array.from(assets.keys()) };
      },
    };
  }

  global.H2FVfs = {
    create: create,
    unzip: unzip,
    normalizePath: normalizePath,
    resolve: resolve,
    stripCommonRoot: stripCommonRoot,
    toDataUrl: toDataUrl,
    mimeOf: mimeOf,
    collectFromDataTransfer: collectFromDataTransfer,
    collectFromFileList: collectFromFileList,
    isFileLike: isFileLike,
  };
})(typeof window !== 'undefined' ? window : globalThis);
