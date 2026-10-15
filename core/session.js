/* ============================================================================
 * core/session.js — 一次复刻会话：输入、选项、进度、日志与流程
 *
 * 从「粘贴 HTML / 网页地址 / 本地文件 / 整包」取到 HTML，读选项、创建沙箱、
 * 调用 core/engine.js 捕获，并把进度、日志、结果报告渲染到界面上。
 * 插件（plugin/ui.html）与网页版（web/index.html）共用这一份流程代码；
 * 网页版另外劫持 postMessage，把 render 快照转成 SVG。
 *
 * 依赖：core/engine.js 必须先加载（提供 state / buildDocument / loadStage /
 * settleStage / capture / $）。
 * ========================================================================== */
/* ============================== 输入与流程 =============================== */

const PROXIES = {
  allorigins: 'https://api.allorigins.win/raw?url={url}',
  codetabs: 'https://api.codetabs.com/v1/proxy/?quest={url}',
  corsproxy: 'https://corsproxy.io/?url={url}',
};

function log(msg, cls) {
  const box = $('log');
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setProgress(phase, done, total) {
  const bar = $('bar-fill');
  const label = $('progress-label');
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  if (bar) bar.style.width = clamp(pct, 0, 100) + '%';
  if (label) label.textContent = phase + ' ' + done + '/' + total;
}

function readOptions() {
  /* 页签合并之后，插件端可能没有独立的 #url / #proxy —— 全部按「存在才读」处理 */
  const proxyEl = $('proxy');
  const proxyKey = proxyEl ? proxyEl.value : 'allorigins';
  const proxyTpl = PROXIES[proxyKey] || PROXIES.allorigins;
  const urlEl = $('url');
  const url = urlEl ? urlEl.value.trim() : '';
  return {
    source: state.tab,
    html: $('html').value,
    url: url,
    sourceUrl: url,
    baseHref: url,
    proxy: proxyTpl,
    viewportWidth: clamp(parseInt($('vw').value, 10) || 1440, 240, 4096),
    viewportHeight: clamp(parseInt($('vh').value, 10) || 900, 240, 4096),
    cropMode: $('crop').value,
    allowScripts: $('allowScripts').checked,
    disableAnimation: $('disableAnimation').checked,
    capturePseudo: $('capturePseudo').checked,
    textMode: $('textMode').value,
    zIndexSort: $('zIndexSort').checked,
    shadowScale: clamp(parseFloat($('shadowScale').value) || 1, 0.1, 4),
    maxNodes: clamp(parseInt($('maxNodes').value, 10) || 20000, 100, 200000),
    lowfi: !!($('lowfiMode') && $('lowfiMode').checked),
    backdrop: !!($('backdrop') && $('backdrop').checked),
    overlayStates: !($('overlayStates') && !$('overlayStates').checked),
    overlayStates: !($('overlayStates') && !$('overlayStates').checked),
    probeRoutes: !!($('probeRoutes') && $('probeRoutes').checked),
    hoverStates: !!($('hoverStates') && $('hoverStates').checked),
    /* 默认不跳过 srcdoc：srcdoc 能跑脚本、能做 hash 路由，而探针是「先记录目标再调用原 API」，
       所以即使 pushState 被浏览器拒绝、URL 没变，目标照样能拿到。
       preferBlobUrl 留给确实需要真改 URL 的场景手动打开。 */
    preferBlobUrl: false,
    assetTimeout: 12000,
  };
}

async function getHtml(opts) {
  if (opts.source === 'url') {
    if (!opts.url) throw new Error('请填写网页地址');
    const target = opts.proxy.replace('{url}', encodeURIComponent(opts.url));
    log('通过 CORS 代理抓取页面…');
    const res = await fetch(target, { credentials: 'omit' });
    if (!res.ok) throw new Error('抓取失败 HTTP ' + res.status);
    const text = await res.text();
    if (!text || text.length < 30) throw new Error('抓取到的内容为空');
    return { html: text, baseHref: opts.url };
  }
  let html = opts.html;
  if (!html.trim()) throw new Error('请先粘贴 HTML 代码');
  /* 只粘了一个网址的情况，自动当 URL 模式处理 */
  if (/^\s*https?:\/\/\S+\s*$/.test(html) && html.indexOf('<') < 0) {
    const target = opts.proxy.replace('{url}', encodeURIComponent(html.trim()));
    const res = await fetch(target, { credentials: 'omit' });
    if (!res.ok) throw new Error('抓取失败 HTTP ' + res.status);
    return { html: await res.text(), baseHref: html.trim() };
  }
  return { html: html, baseHref: opts.baseHref };
}

function report(data) {
  const box = $('report');
  if (!box) return;
  box.innerHTML = '';
  const stats = data.stats || {};
  const items = [
    ['图层总数', stats.nodes],
    ['文本图层', stats.texts],
    ['图片资源', stats.images],
    ['字体数', stats.fonts],
    ['捕获元素', data.captureStats ? data.captureStats.elements : '-'],
    ['捕获文本', data.captureStats ? data.captureStats.texts : '-'],
  ];
  const wrap = document.createElement('div');
  wrap.className = 'stats';
  for (const it of items) {
    if (it[1] == null) continue;
    const cell = document.createElement('div');
    cell.className = 'stat';
    cell.innerHTML = '<b>' + it[1] + '</b><span>' + it[0] + '</span>';
    wrap.appendChild(cell);
  }
  box.appendChild(wrap);

  const warns = data.warnings || [];
  if (warns.length) {
    const h = document.createElement('div');
    h.className = 'sect-title';
    h.textContent = '提示与限制（' + warns.length + '）';
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'warn-list';
    const shown = warns.slice(0, 40);
    for (const w of shown) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    }
    if (warns.length > shown.length) {
      const li = document.createElement('li');
      li.textContent = '…… 还有 ' + (warns.length - shown.length) + ' 条';
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

/* ========================= 数字输入的加减按钮 =========================== */
/* 原生 spinner 在深色主题下又小又割裂，几乎没法改样式，所以藏掉它、自绘一对按钮。
   只在插件壳（body.h2f-plugin）里启用，网页版保持原生外观。 */
function enhanceNumberInputs() {
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (!body || !body.classList || !body.classList.contains('h2f-plugin')) return;

  const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="number"]'));
  for (const input of inputs) {
    if (input.parentElement && input.parentElement.classList.contains('num-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'num-wrap';
    if (input.parentNode) input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const box = document.createElement('div');
    box.className = 'num-btns';
    const mk = (sign, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'num-btn';
      btn.textContent = label;
      btn.tabIndex = -1;
      btn.setAttribute('aria-hidden', 'true');
      btn.onclick = () => {
        const step = parseFloat(input.step) || 1;
        const min = input.min === '' ? -Infinity : parseFloat(input.min);
        const max = input.max === '' ? Infinity : parseFloat(input.max);
        let v = parseFloat(input.value);
        if (!isFinite(v)) v = (min === -Infinity ? 0 : min);
        v = Math.min(max, Math.max(min, v + sign * step));
        input.value = String(Math.round(v * 1000) / 1000);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      return btn;
    };
    box.appendChild(mk(1, '+'));
    box.appendChild(mk(-1, '−'));
    wrap.appendChild(box);
  }
}

/* ============================ 文件队列 ================================= */
/* 单页 .html 会累积成一个队列，可以逐个复刻；整包 .zip 仍然是一次性解析
   （包内页面由 VFS 负责并排与连线，不走这个队列）。 */

const pkQueue = { items: [], seq: 0, running: false };

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function queueAdd(files) {
  const added = [];
  const skipped = [];
  for (const f of Array.from(files || [])) {
    /* 同名即视为已存在：队列里出现两个同名项只会让人分不清该做哪一个 */
    const dup = pkQueue.items.some((it) => it.name === f.name);
    if (dup) { skipped.push(f.name); continue; }
    const item = {
      id: ++pkQueue.seq,
      name: f.name,
      size: f.size || 0,
      file: f,
      status: 'pending',
      error: '',
    };
    pkQueue.items.push(item);
    added.push(item);
  }
  renderQueue();
  return { added: added, skipped: skipped };
}

/* 队列第 1 项的内容同步进输入框；队列空了就把输入框也清掉 */
async function syncLoadedFile() {
  const ta = $('html');
  const first = pkQueue.items[0];
  if (!first || first.type === 'package') {
    if (ta && (!first)) ta.value = '';
    return;
  }
  const text = await readTextFile(first.file);
  if (ta) ta.value = text == null ? '' : text;
}

async function queueRemove(id) {
  const i = pkQueue.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  const removed = pkQueue.items.splice(i, 1)[0];

  /* 不只是删列表项：把这个文件在插件里的痕迹一起清掉 */
  if (removed.type === 'package') {
    state.pkg = null;
  } else if (removed.file) {
    removed.file = null;
  }
  await syncLoadedFile();
  renderQueue();
  log('已从队列移除：' + removed.name + '（队列剩 ' + pkQueue.items.length + ' 个）');
  fileNote(pkQueue.items.length
    ? '<b>已移除：</b>' + escapeHtml(removed.name) + '　已切换到：' + escapeHtml(pkQueue.items[0].name)
    : '<b>已移除：</b>' + escapeHtml(removed.name) + '　队列已空，输入框已清空');
}

async function queueClear() {
  const n = pkQueue.items.length;
  const hadPackage = !!state.pkg;
  for (const it of pkQueue.items) {
    if (it.file) it.file = null;      // 丢掉 File 引用
    it.status = 'pending';
    it.error = '';
  }
  pkQueue.items = [];
  pkQueue.running = false;
  state.pkg = null;                    // 整包状态也一起清掉
  const ta = $('html');
  if (ta) ta.value = '';               // 输入框里的内容也清掉
  renderQueue();
  log('已清空文件队列：移除 ' + n + ' 项' + (hadPackage ? '（含整包）' : ''));
  fileNote(n ? '<b>已清空：</b>移除 ' + n + ' 个已导入文件，输入框已清空' : '');
}

function renderQueue() {
  const wrap = $('file-queue');
  const list = $('queue-list');
  const count = $('queue-count');
  if (!wrap || !list) return;
  wrap.style.display = pkQueue.items.length ? '' : 'none';
  if (count) count.textContent = String(pkQueue.items.length);
  list.innerHTML = pkQueue.items.map((it) => {
    const isPkg = it.type === 'package';
    const meta = it.error
      ? escapeHtml(it.error)
      : (isPkg ? it.pages + ' 个页面' : bytesText2(it.size));
    return '<li class="queue-item" data-id="' + it.id + '">'
      + '<span class="qi-state qi-' + it.status + '"></span>'
      + '<span class="qi-name" title="' + escapeHtml(it.name) + '">'
      + (isPkg ? '📦 ' : '') + escapeHtml(it.name) + '</span>'
      + '<span class="qi-meta">' + meta + '</span>'
      + '<button type="button" class="qi-x" data-act="remove" title="从队列移除（同时清掉已导入的内容）">×</button>'
      + '</li>';
  }).join('');
}

/* run() 成功后会等主线程回 done 才复位 state.running，所以这里轮询它 */
function waitIdle(timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const step = () => {
      if (!state.running || Date.now() - t0 > (timeoutMs || 180000)) resolve();
      else setTimeout(step, 120);
    };
    step();
  });
}

async function queueRunAll() {
  if (pkQueue.running || !pkQueue.items.length) return;
  if (state.running) { log('正在复刻中，请稍候', 'warn'); return; }
  pkQueue.running = true;
  state.cancelled = false;
  log('队列开始：共 ' + pkQueue.items.length + ' 个文件', 'ok');

  let ok = 0;
  let fail = 0;
  for (const it of pkQueue.items.slice()) {
    if (state.cancelled) { log('已取消，剩余文件未处理', 'warn'); break; }
    if (it.status === 'done') continue;
    it.status = 'running';
    it.error = '';
    renderQueue();
    try {
      setMode(it.type === 'package' ? 'file' : 'input');
      log('[' + (pkQueue.items.indexOf(it) + 1) + '/' + pkQueue.items.length + '] ' + it.name);
      if (it.type === 'package') {
        if (!state.pkg || !state.pkg.pages.length) throw new Error('整包已失效，请重新导入');
      } else {
        const text = await readTextFile(it.file);
        if (text == null) throw new Error('读取失败');
        const ta = $('html');
        if (ta) ta.value = text;
      }
      run();
      await waitIdle();
      it.status = 'done';
      ok++;
    } catch (e) {
      it.status = 'error';
      it.error = (e && e.message) ? e.message : String(e);
      fail++;
      log('  ✗ ' + it.name + '：' + it.error, 'error');
    }
    renderQueue();
    await (typeof delay === 'function' ? delay(120) : new Promise((r) => setTimeout(r, 120)));
  }

  pkQueue.running = false;
  renderQueue();
  setMode('file');
  log('队列结束：成功 ' + ok + '，失败 ' + fail, fail ? 'warn' : 'ok');
  fileNote(fail
    ? '<b>队列结束：</b>成功 ' + ok + '，失败 ' + fail
    : '<b>队列结束：</b>成功 ' + ok + ' 个文件');
}

function wireFileQueue() {
  const runBtn = $('queue-run');
  if (runBtn) runBtn.onclick = () => queueRunAll();
  const clearBtn = $('queue-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (pkQueue.running) { log('队列运行中，先取消再清空', 'warn'); return; }
    await queueClear();
  };
  const list = $('queue-list');
  if (list) {
    list.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-act') : null;
      if (btn !== 'remove') return;
      const li = ev.target.closest ? ev.target.closest('.queue-item') : null;
      if (li) queueRemove(Number(li.getAttribute('data-id')));   /* 异步清理，无需等待 */
    });
  }
  renderQueue();
}

/* ========================= 输入 / 文件 两种模式 ========================= */

function setMode(name) {
  state.inputMode = name;
  const pairsList = [['mode-input', 'input'], ['mode-file', 'file']];
  for (const pair of pairsList) {
    const btn = $(pair[0]);
    if (btn) btn.classList.toggle('active', pair[1] === name);
  }
  const inputBody = $('mode-input-body');
  if (inputBody) inputBody.style.display = name === 'input' ? '' : 'none';
  const fileBody = $('mode-file-body');
  if (fileBody) fileBody.style.display = name === 'file' ? '' : 'none';
}

function fileNote(html, isWarn) {
  const note = $('file-note');
  if (!note) return;
  if (!html) {
    note.style.display = 'none';
    note.innerHTML = '';
    return;
  }
  note.style.display = '';
  note.innerHTML = html;
  note.style.color = isWarn ? 'var(--warn, #d97706)' : '';
  const plain = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain) log(plain, isWarn ? 'warn' : undefined);
}

function readTextFile(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => resolve(null);
    fr.readAsText(file, 'utf-8');
  });
}

function bytesText2(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  return (v / 1024).toFixed(1) + ' KB';
}

/* 文件模式：点击虚线框 → 系统文件选择器；也支持拖入。
   导入后把「导入了哪个文件」显示在框下面，并把内容装进输入框（可直接复刻）。 */
async function importLocalFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;

  /* 整包（.zip）：交给 VFS 解析，包内每个页面都会进队列 */
  const zips = list.filter((f) => /\.zip$/i.test(f.name));
  if (zips.length) {
    fileNote('<b>正在解析整包：</b>' + zips.map((f) => f.name).join('、') + '　请稍候…');
    await loadPackage(zips, zips.length === 1 ? zips[0].name : zips.length + ' 个整包');
    return;
  }

  state.tab = 'paste';
  setTab('paste');
  showLoadedFile(list[0].name);

  /* 网页版有自己的批量队列，插件端用文件模式里的这个队列 */
  if (typeof window !== 'undefined' && window.__h2f && typeof window.__h2f.batchAddFiles === 'function') {
    window.__h2f.batchAddFiles(list);
    fileNote('<b>已导入：</b>' + list.map((f) => f.name).join('、')
      + '　共 ' + list.length + ' 个文件已加入批量队列');
    return;
  }

  const res = queueAdd(list);
  const first = res.added[0] || pkQueue.items[0];
  if (first) {
    const text = await readTextFile(first.file);
    if (text != null) {
      const el = $('html');
      if (el) el.value = text;
      first.status = 'pending';
    } else {
      first.status = 'error';
      first.error = '读取失败';
      renderQueue();
    }
  }
  const parts = [];
  if (res.added.length) parts.push('已加入队列 <b>' + res.added.length + '</b> 个');
  if (res.skipped.length) parts.push('已在队列里：' + escapeHtml(res.skipped.join('、')));
  fileNote('<b>已导入：</b>' + escapeHtml(list.map((f) => f.name).join('、'))
    + '　' + bytesText2(list[0].size) + '　' + parts.join('　')
    + '　点队列里的「全部复刻」按顺序做完，或直接点「开始复刻」做当前这个');
  log('已加入文件队列：' + list.map((f) => f.name).join('、')
    + '（队列共 ' + pkQueue.items.length + ' 个）');
}

function wireFileMode() {
  const box = $('file-dropbox');
  const pick = $('file-pick');
  if (!box || !pick) return;

  const openPicker = () => { pick.value = ''; pick.click(); };
  box.onclick = openPicker;
  box.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPicker(); }
  };

  pick.onchange = async (ev) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (files.length) await importLocalFiles(files);
  };

  ['dragenter', 'dragover'].forEach((t) => box.addEventListener(t, (ev) => {
    ev.preventDefault();
    box.classList.add('dragging');
  }));
  ['dragleave', 'dragend'].forEach((t) => box.addEventListener(t, (ev) => {
    ev.preventDefault();
    box.classList.remove('dragging');
  }));
  box.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    box.classList.remove('dragging');
    const dt = ev.dataTransfer;
    const entry = (dt && dt.items && dt.items[0] && dt.items[0].webkitGetAsEntry)
      ? dt.items[0].webkitGetAsEntry() : null;

    /* 整个文件夹拖进来 = 整包导入（递归读取后自动内联相对资源） */
    if (entry && entry.isDirectory) {
      fileNote('<b>正在读取文件夹…</b>');
      await loadPackage(dt, '拖入的文件夹');
      return;
    }

    const all = Array.from((dt && dt.files) || []);
    const keep = all.filter((f) => /\.html?$/i.test(f.name) || /\.zip$/i.test(f.name));
    if (!keep.length) { fileNote('拖进来的文件里没有 .html / .htm / .zip', true); return; }
    await importLocalFiles(keep);
  });
}

/* 交互提取的薄封装：模块缺失时返回空表，绝不阻断主流程 */
function extractInteractions(stage, pageName) {
  const empty = { interactions: [], hoverRules: [] };
  if (typeof H2FInteract === 'undefined') return empty;
  try {
    const ix = H2FInteract.extract(stage, { pagePath: pageName });
    if (ix.interactions.length) {
      log('识别到 ' + ix.interactions.length + ' 条交互、' + ix.hoverRules.length + ' 条 :hover 规则');
    }
    return ix;
  } catch (e) {
    log('交互提取失败：' + (e && e.message ? e.message : e), 'warn');
    return empty;
  }
}

/* 整包输入接线：.zip 或整个文件夹 */
function wirePackageInput() {
  const bind = (btnId, inputId, label) => {
    const btn = $(btnId);
    const input = $(inputId);
    if (!btn || !input) return;
    btn.onclick = () => { input.value = ''; input.click(); };
    input.onchange = async (ev) => {
      const files = Array.from(ev.target.files || []);
      if (files.length) await loadPackage(files, label(files));
      ev.target.value = '';
    };
  };
  bind('pkg-zip-btn', 'pkg-zip', (f) => f[0].name);
  bind('pkg-folder-btn', 'pkg-folder', (f) => '文件夹（' + f.length + ' 个文件）');
}

async function loadPackage(files, label) {
  if (typeof H2FVfs === 'undefined') { log('整包模块未加载（core/vfs.js 缺失）', 'error'); return; }
  const box = $('pkg-summary');
  try {
    const vfs = H2FVfs.create();
    const stats = await vfs.ingest(files, (m) => log('  ' + m));
    if (!stats.html) { log('这个包里没有找到 HTML 页面', 'warn'); return; }
    state.pkg = { vfs: vfs, pages: vfs.pages() };
    /* 整包也是「已导入的东西」，放进队列里才移除得掉；队列里同时只留一个 */
    const pkgIdx = pkQueue.items.findIndex((x) => x.type === 'package');
    if (pkgIdx >= 0) pkQueue.items.splice(pkgIdx, 1);
    pkQueue.items.push({
      id: ++pkQueue.seq,
      type: 'package',
      name: label,
      size: stats.bytes || 0,
      pages: state.pkg.pages.length,
      status: 'pending',
      error: '',
    });
    renderQueue();
    const text = '已导入 ' + label + '：' + stats.html + ' 个页面 · ' + stats.css + ' 个样式表 · ' + stats.assets + ' 个资源'
      + (stats.skipped.length ? ' · 跳过 ' + stats.skipped.length + ' 项' : '');
    log(text, 'ok');
    if (box) box.textContent = text + '　点「开始复刻」逐页生成，页面会自动并排并建立原型连线。';
    if (typeof fileNote === 'function') {
      fileNote('<b>整包已就绪：</b>' + label + '　' + stats.html + ' 个页面 · '
        + stats.css + ' 个样式表 · ' + stats.assets + ' 个资源'
        + (stats.skipped.length ? ' · 跳过 ' + stats.skipped.length + ' 项' : '')
        + '　点「开始复刻」逐页生成，页面会自动并排并建立原型连线');
    }
    stats.skipped.slice(0, 8).forEach((x) => log('  ⚠ ' + x, 'warn'));
  } catch (e) {
    const msg = '整包解析失败：' + (e && e.message ? e.message : e);
    log(msg, 'error');
    if (typeof fileNote === 'function') fileNote('<b>' + msg + '</b>', true);
  }
}

/* :hover 状态稿：把 hover 声明临时内联后重捕整页，并按需套用低保真变换。
   返回 [{selector, base, elements, changedCount, payload}] */
/**
 * 给状态稿（hover / 弹层 / 视图）补上它自己的交互。
 *
 * 少了这一步，那些画板里的按钮全是死的 —— 「完整 App 的交互逻辑」就断在这里：
 * 主稿的底部导航能跳到任务视图，但任务视图里的导航再也跳不出去。
 * 必须在状态**还生效时**调用（弹层开着 / 页面停在那个路由上）。
 */
async function attachInteractions(payload, stage, opts, pagePath) {
  let list = payload.interactions || [];
  try {
    if (typeof H2FInteract !== 'undefined') {
      const ix2 = H2FInteract.extract(stage, { pagePath: pagePath });
      list = (ix2.interactions || []).slice();
      payload.hoverRules = ix2.hoverRules || [];
    }
  } catch (e) { /* 提取失败就用已有的 */ }

  if (opts && opts.probeRoutes && typeof H2FRouteProbe !== 'undefined') {
    try {
      const pr = await H2FRouteProbe.probe(stage, { pagePath: pagePath });
      list = list.concat(pr.interactions || []);
    } catch (e) { /* 探测失败不影响 */ }
  }

  const seen = {};
  payload.interactions = list.filter((x) => {
    const k = String((x && x.action) || '') + '|' + String((x && x.target) || '');
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
  return payload.interactions.length;
}

async function buildHoverStates(stage, opts, hoverRules, basePayload, afterCapture) {
  if (!opts.hoverStates || typeof H2FStates === 'undefined') return [];
  if (!hoverRules || !hoverRules.length) return [];
  try {
    const captured = await H2FStates.captureStates(stage, { captureOpts: opts, afterCapture: afterCapture }, hoverRules, capture);
    if (!captured.length) return [];
    const diffs = H2FStates.diffStates(basePayload, captured);
    const out = captured.map((s) => {
      let sp = (opts.lowfi && typeof H2FLowfi !== 'undefined') ? H2FLowfi.transform(s.payload, {}) : s.payload;
      if (opts.backdrop && typeof H2FBackdrop !== 'undefined') sp = H2FBackdrop.apply(sp, {});
      const d = diffs.filter((x) => x.selector === s.selector)[0] || { changedCount: 0 };
      return { selector: s.selector, base: s.base, elements: s.elements, changedCount: d.changedCount, payload: sp };
    });
    log('识别到 ' + out.length + ' 个 :hover 状态（'
      + out.map((h) => h.base + '：' + h.changedCount + ' 个元素变化').join('、') + '）');
    return out;
  } catch (e) {
    log('状态稿生成失败：' + (e && e.message ? e.message : e), 'warn');
    return [];
  }
}

/* 静态交互表 + 运行时路由探测（SPA）。
   探测会真的点页面、改动 URL，所以只在 capture 与静态提取之后调用。 */
async function mergeRuntimeRoutes(stage, staticList, opts, pagePath) {
  if (!opts.probeRoutes || typeof H2FRouteProbe === 'undefined' || typeof H2FInteract === 'undefined') {
    return staticList;
  }
  try {
    const probe = await H2FRouteProbe.probe(stage, { pagePath: pagePath, maxClicks: 24 });
    if (probe.interactions.length) {
      log('运行时路由探测：试点击 ' + probe.clicked + ' 个元素，识别出 ' + probe.interactions.length + ' 条 JS 绑定跳转'
        + (probe.restored ? '' : '（URL 未能完全还原）'));
      return H2FInteract.merge(staticList, probe.interactions);
    }
    if (probe.note) log('运行时路由探测：' + probe.note, 'warn');
    return staticList;
  } catch (e) {
    log('运行时路由探测失败：' + (e && e.message ? e.message : e), 'warn');
    return staticList;
  }
}

/* 整包：逐页捕获，每页作为独立快照交给主线程（主线程负责并排与原型连线） */
async function runPackage(opts) {
  const pages = state.pkg.pages;
  const total = pages.length;
  const pkgId = 'pkg_' + Date.now();
  let pkgIndex = 0;
  state.pageName = '';
  log('整包模式：' + total + ' 个页面，逐页捕获…');
  for (let i = 0; i < total; i++) {
    if (state.cancelled) { log('已取消，剩余 ' + (total - i) + ' 页未处理', 'warn'); break; }
    const page = pages[i];
    setProgress('整包 ' + (i + 1) + '/' + total, i + 1, total);
    log('[' + (i + 1) + '/' + total + '] ' + page.path);
    let stage = null;
    try {
      const bundled = await state.pkg.vfs.bundle(page.path);
      if (bundled.missing.length) log('  ⚠ ' + bundled.missing.length + ' 个相对资源没找到', 'warn');
      let doc = buildDocument(bundled.html, opts);
      if (opts.probeRoutes && typeof H2FRouteProbe !== 'undefined') doc = H2FRouteProbe.injectHook(doc);
      stage = await loadStage(doc, opts);
      await settleStage(stage, opts);
      const payload = capture(stage, opts);
      payload.captureStats = payload.stats;
      payload.package = { id: pkgId, index: pkgIndex++, name: page.path, gap: 160 };
      const ix = extractInteractions(stage, page.path);
      payload.hoverRules = ix.hoverRules;
      payload.interactions = await mergeRuntimeRoutes(stage, ix.interactions, opts, page.path);
      let finalPayload = (opts.lowfi && typeof H2FLowfi !== 'undefined')
        ? H2FLowfi.transform(payload, {})
        : payload;
      if (opts.backdrop && typeof H2FBackdrop !== 'undefined') finalPayload = H2FBackdrop.apply(finalPayload, {});
      parent.postMessage({ pluginMessage: { type: 'render', payload: finalPayload } }, '*');

      /* 本页的 :hover 状态稿：紧随其后，作为同一 package 的后续画板 */
      const hovers = await buildHoverStates(stage, opts, ix.hoverRules, payload, async (hp, hStage) => {
        await attachInteractions(hp, hStage, opts, page.path);
      });
      for (const h of hovers) {
        h.payload.package = {
          id: pkgId, index: pkgIndex++, gap: 160,
          name: page.path + ' ▸ :hover ' + h.base,
        };
        parent.postMessage({ pluginMessage: { type: 'render', payload: h.payload } }, '*');
        log('  ＋ :hover ' + h.base + '（' + h.changedCount + ' 个元素变化）');
      }

      /* 页内弹层：单独成稿，主线程会用 OVERLAY 连过去 */
      if (opts.overlayStates && typeof H2FOverlay !== 'undefined') {
        const overlays = await H2FOverlay.captureOverlays(stage, opts, ix.interactions, capture,
          async (op, oStage) => { await attachInteractions(op, oStage, opts, page.path); });
        for (const ov of overlays) {
          ov.payload.package = { id: pkgId, index: pkgIndex++, gap: 160, name: ov.name };
          parent.postMessage({ pluginMessage: { type: 'render', payload: ov.payload } }, '*');
          log('  ＋ 弹层稿 ' + ov.name + '（' + ov.payload.overlayState.selector + '）');
        }
      }

      /* 前端路由的每个视图：重新加载 + 注入初始路由，各捕一张。
         App / SPA 的页面切换全在 JS 里，一张画板装不下 —— 这是完整复刻的关键一步。 */
      if (opts.overlayStates && typeof H2FViewStates !== 'undefined') {
        /* 路由来源直接用已经合并好的那份（提取阶段跑过探测了）。
           千万别在这里再 probe 一次：那时页面已经被第一次探测点过，
           第二次多半拿不到东西 —— 之前就是这么把视图稿全丢掉的。 */
        const routes = H2FViewStates.collectRoutes(
          (payload.interactions || []).concat(ix.interactions || [])
        );
        if (!routes.length) log('  没有发现前端路由视图（页面切换若不走 URL，就识别不到）');
        for (const r of routes) {
          try {
            const vHtml = H2FViewStates.injectRoute(bundled.html, r);
            const vStage = await loadStage(buildDocument(vHtml, opts), opts);
            try {
              await settleStage(vStage, opts);
              const vPayload = capture(vStage, opts);
              /* 视图稿也要有自己的交互 —— 否则演示时跳进来就出不去了 */
              await attachInteractions(vPayload, vStage, opts, page.path);
              vPayload.package = { id: pkgId, index: pkgIndex++, gap: 160, name: r };
              vPayload.viewState = { version: H2FViewStates.version, route: r };
              parent.postMessage({ pluginMessage: { type: 'render', payload: vPayload } }, '*');
              log('  ＋ ' + H2FViewStates.viewName(r) + '（'
                + vPayload.meta.w + ' × ' + vPayload.meta.h + '）');
            } finally {
              if (vStage.frame && vStage.frame.parentNode) vStage.frame.parentNode.removeChild(vStage.frame);
            }
          } catch (e) {
            log('  视图 ' + r + ' 捕获失败：' + (e && e.message ? e.message : e), 'warn');
          }
        }
      }
      log('  ✓ ' + payload.meta.w + ' × ' + payload.meta.h + '，元素 ' + payload.stats.elements
        + '，交互 ' + ix.interactions.length, 'ok');
    } catch (e) {
      log('  ✗ ' + page.path + '：' + (e && e.message ? e.message : e), 'error');
      parent.postMessage({ pluginMessage: { type: 'notify', message: '页面失败：' + page.path } }, '*');
    } finally {
      if (stage) {
        if (stage.blobUrl) { try { URL.revokeObjectURL(stage.blobUrl); } catch (e) { /* 忽略 */ } }
        if (stage.frame && stage.frame.parentNode) stage.frame.parentNode.removeChild(stage.frame);
        if (stage.hostWrap && stage.hostWrap.parentNode) stage.hostWrap.parentNode.removeChild(stage.hostWrap);
      }
    }
    /* 给主线程留出建图层的时间：逐页快速连发会让 Figma 沙箱排队 */
    await delay(120);
  }
  parent.postMessage({ pluginMessage: { type: 'package-end', id: pkgId } }, '*');
  log('整包处理结束', 'ok');
}

async function run() {
  if (state.running) return;
  state.running = true;
  state.cancelled = false;
  state.images = new Map();
  $('log').innerHTML = '';
  $('report').innerHTML = '';
  $('btn-run').disabled = true;
  $('btn-cancel').disabled = false;
  $('bar-fill').style.width = '0%';

  try {
    const opts = readOptions();

    /* 整包模式：逐页捕获，每页作为独立快照发给主线程 */
    if (state.pkg && state.pkg.pages.length) {
      await runPackage(opts);
      state.running = false;
      $('btn-run').disabled = false;
      $('btn-cancel').disabled = true;
      return;
    }

    log('读取输入…');
    const input = await getHtml(opts);
    opts.baseHref = input.baseHref || opts.baseHref;
    /* 端型自动识别：必须在 buildDocument 之前，视口会影响媒体查询命中 */
    applyAutoViewport(input.html, opts);
    let doc = buildDocument(input.html, opts);
    if (opts.probeRoutes && typeof H2FRouteProbe !== 'undefined') {
      doc = H2FRouteProbe.injectHook(doc);
      log('已注入路由探针：快照拍完后会试点击页面，识别写在 JS 里的跳转');
    }

    log('创建渲染沙箱（' + opts.viewportWidth + '×' + opts.viewportHeight + '）…');
    const stage = await loadStage(doc, opts);
    state.stage = stage;
    if (stage.fallbackNote) log(stage.fallbackNote, 'warn');

    log('等待字体与图片就绪…');
    await settleStage(stage, opts);

    log('测量排版…');
    const payload = capture(stage, opts);
    payload.captureStats = payload.stats;
    state.captureStats = payload.stats;
    state.pageName = input.baseHref || 'page';
    /* 注意：不要用 payload.images 覆盖 state.images —— 引擎在捕获时就按 ref 存好了
       真实条目（url 是真正的 dataURL），而 payload 里的 url 是 '(内联 dataURL)' 占位。 */

    /* 交互提取：复用同一份已排版的沙箱，坐标与图层同源 */
    const ix = extractInteractions(stage, state.pageName);
    payload.hoverRules = ix.hoverRules;
    payload.interactions = await mergeRuntimeRoutes(stage, ix.interactions, opts, state.pageName);

    /* 低保真线框稿：快照层变换一次，Figma 图层与 SVG 两条出口共用 */
    let finalPayload = payload;
    if (opts.lowfi && typeof H2FLowfi !== 'undefined') {
      finalPayload = H2FLowfi.transform(payload, {});
      log('已转换为低保真线框稿（只由灰阶色块构成：文字占位条 + 图片/图标色块，无描边）');
    }
    /* 白色衬底：垫在页面外面的一圈白边，与低保真可叠用（先低保真后衬底） */
    if (opts.backdrop && typeof H2FBackdrop !== 'undefined') {
      finalPayload = H2FBackdrop.apply(finalPayload, {});
      log('已垫上白色衬底画板（每边 ' + H2FBackdrop.PAD + 'px）');
    }

    log('捕获完成：元素 ' + payload.stats.elements + '，文本 ' + payload.stats.texts + '，图片 ' + payload.stats.images
      + (ix.interactions.length ? '，交互 ' + ix.interactions.length : ''));
    log('发送给 Figma 生成图层…');

    /* :hover 状态稿：逐条 hover 规则临时内联后重捕，得到「悬停时长什么样」 */
    const hoverStates = await buildHoverStates(stage, opts, ix.hoverRules, payload);

    /* 页内弹层：单独成稿（重捕「弹层打开」的样子） */
    let overlays = [];
    if (opts.overlayStates && typeof H2FOverlay !== 'undefined') {
      overlays = await H2FOverlay.captureOverlays(stage, opts, ix.interactions, capture);
      for (const ov of overlays) log('  ＋ 弹层稿 ' + ov.name + '（' + ov.payload.overlayState.selector + '）');
    }

    setProgress('生成图层', 0, 1);
    if (hoverStates.length || overlays.length) {
      /* 原稿与状态稿并排：同一个 package id，主线程会横向铺开 */
      const pkgId = 'pkg_' + Date.now();
      const baseName = state.pageName || 'page';
      finalPayload.package = { id: pkgId, index: 0, name: baseName, gap: 160 };
      parent.postMessage({ pluginMessage: { type: 'render', payload: finalPayload } }, '*');
      for (let i = 0; i < hoverStates.length; i++) {
        const sp = hoverStates[i].payload;
        sp.package = {
          id: pkgId, index: i + 1, gap: 160,
          name: baseName + ' ▸ :hover ' + hoverStates[i].base,
        };
        parent.postMessage({ pluginMessage: { type: 'render', payload: sp } }, '*');
      }
      for (let i = 0; i < overlays.length; i++) {
        const op = overlays[i];
        op.payload.package = { id: pkgId, index: hoverStates.length + i + 1, gap: 160, name: op.name };
        parent.postMessage({ pluginMessage: { type: 'render', payload: op.payload } }, '*');
      }
      parent.postMessage({ pluginMessage: { type: 'package-end', id: pkgId } }, '*');
    } else {
      parent.postMessage({ pluginMessage: { type: 'render', payload: finalPayload } }, '*');
    }
  } catch (e) {
    state.running = false;
    $('btn-run').disabled = false;
    $('btn-cancel').disabled = true;
    log('失败：' + (e && e.message ? e.message : e), 'error');
    parent.postMessage({ pluginMessage: { type: 'notify', message: '复刻失败：' + (e && e.message ? e.message : e) } }, '*');
  }
}

/* ============================== 与主线程通信 ============================= */

window.onmessage = async (event) => {
  const msg = event.data && event.data.pluginMessage;
  if (!msg) return;

  if (msg.type === 'progress') {
    setProgress(msg.phase || '', msg.done || 0, msg.total || 1);
    return;
  }

  if (msg.type === 'done') {
    state.running = false;
    $('btn-run').disabled = false;
    $('btn-cancel').disabled = true;
    setProgress('完成', 1, 1);
    report({
      stats: msg.stats,
      warnings: msg.warnings,
      captureStats: state.captureStats || null,
    });
    log('完成 ✅', 'ok');
    if (state.stage && state.stage.blobUrl) URL.revokeObjectURL(state.stage.blobUrl);
    return;
  }

  if (msg.type === 'error') {
    state.running = false;
    $('btn-run').disabled = false;
    $('btn-cancel').disabled = true;
    log('主线程错误：' + msg.message, 'error');
    return;
  }

  if (msg.type === 'interactions') {
    /* 原型连线结果：这是「打开演示点不动」时第一个要看的地方 */
    const bits = [];
    if (msg.bound) bits.push('已连接 ' + msg.bound + ' 条');
    if (msg.skipped) bits.push('跳过 ' + msg.skipped + ' 条');
    log('原型连线：' + (bits.join('，') || '没有可连的跳转')
      + (msg.total ? '（共 ' + msg.total + ' 条交互）' : '')
      + (msg.whyText ? '　【' + msg.whyText + '】' : ''),
      msg.bound ? 'ok' : 'warn');
    return;
  }

  if (msg.type === 'get-image') {
    const item = state.images.get(msg.ref);
    let base64 = null;
    if (item) {
      /* 引擎给的是 {ref, url, data}：url 本身可能就是 dataURL，直接切出 base64 */
      const dataUrl = item.dataUrl || (/^data:/i.test(item.url || '') ? item.url : null);
      if (dataUrl) {
        base64 = String(dataUrl).split(',')[1] || null;
      } else if (item.url) {
        try {
          const res = await fetch(item.url, { mode: 'cors', credentials: 'omit' });
          if (res.ok) {
            const blob = await res.blob();
            base64 = await blobToBase64(blob);
          }
        } catch (e) {
          base64 = null;
        }
      }
    }
    parent.postMessage({ pluginMessage: { type: 'image-bytes', ref: msg.ref, base64: base64 } }, '*');
    return;
  }
};

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      resolve(s.split(',')[1] || null);
    };
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

/* ================================ UI 绑定 =============================== */

state.tab = 'paste';

const TAB_NAMES = ['paste', 'url', 'file', 'package'];

function setTab(name) {
  state.tab = name;
  TAB_NAMES.forEach((t) => {
    const btn = $('tab-' + t);
    if (btn) {
      btn.classList.toggle('active', t === name);
      if (btn.setAttribute) btn.setAttribute('aria-selected', t === name ? 'true' : 'false');
    }
    const panel = $('panel-' + t);
    if (panel) panel.style.display = t === name ? '' : 'none';
  });
}

/* 输入方式的键盘操作：← → / Home / End 在三个标签之间移动（仅当按钮组存在时生效） */
function wireTabKeys() {
  const names = TAB_NAMES.slice();
  const ids = names.map((n) => 'tab-' + n);
  ids.forEach((id, i) => {
    const btn = $(id);
    if (!btn || !btn.addEventListener) return;
    btn.addEventListener('keydown', (ev) => {
      let next = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % ids.length;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i + ids.length - 1) % ids.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = ids.length - 1;
      if (next < 0) return;
      ev.preventDefault();
      setTab(names[next]);
      const target = $(ids[next]);
      if (target && target.focus) target.focus();
    });
  });
}

/* 左栏顶部的「已载入文件」提示（网页版有，插件 UI 没有，缺失时自动跳过） */
function showLoadedFile(name) {
  const box = $('loaded-file');
  if (!box) return;
  box.style.display = '';
  box.textContent = '已载入本地文件：' + name;
  const aside = $('input-aside');
  if (aside) aside.textContent = String(name).slice(0, 22);
}

/* ---------------- 端型自动识别 + 还原模式 ---------------- */

const FORM_LABEL = { mobile: '手机', tablet: '平板', desktop: '桌面' };

/* 还原模式：仅样式 / 样式 + 交互。
   只做视觉还原时把交互相关的全关掉，跑得更快，也不会多出弹层稿与视图稿。 */
function applyRenderMode(mode) {
  const both = mode === 'both';
  const set = (id, v) => { const el = $(id); if (el && 'checked' in el) el.checked = !!v; };
  set('allowScripts', both);
  set('overlayStates', both);
  set('hoverStates', false);   /* 悬停态稿成本高，单独在高级里开 */
  set('probeRoutes', false);   /* 路由探测是兜底：交互主要靠读代码 */
  log('还原模式：' + (both ? '样式 + 交互' : '仅样式'));
}

/* 按页面本身判断端型，自动填好视口与画板范围 —— 用户不必手填 */
function applyAutoViewport(html, opts) {
  const auto = $('autoViewport');
  if (!auto || !auto.checked) return null;
  if (typeof H2FViewport === 'undefined') return null;
  const s = H2FViewport.suggestForHtml(html || '');
  if ($('vw')) $('vw').value = s.w;
  if ($('vh')) $('vh').value = s.h;
  if ($('crop')) $('crop').value = s.crop;
  /* opts 早在读选项时就生成好了，这里必须同步 ——
     否则 buildDocument 与引擎用的还是旧视口。 */
  if (opts) {
    opts.viewportWidth = s.w;
    opts.viewportHeight = s.h;
    opts.cropMode = s.crop;
  }
  const preset = $('devicePreset');
  if (preset) {
    const key = s.w + 'x' + s.h;
    const has = Array.prototype.some.call(preset.options, (o) => o.value === key);
    preset.value = has ? key : '';
  }
  const note = $('autoNote');
  if (note) {
    note.textContent = '自动识别为' + (FORM_LABEL[s.form] || s.form) + '（' + s.why + '）：'
      + s.w + ' × ' + s.h + '，画板范围「'
      + (s.crop === 'viewport' ? '一屏' : (s.crop === 'document' ? '整个文档' : '贴合内容')) + '」';
  }
  log('端型自动识别：' + (FORM_LABEL[s.form] || s.form) + ' → ' + s.w + ' × ' + s.h);
  return s;
}

/* 常用视口快选 + 「默认 / 看结构 / 看交互」三个预设 */
const PRESETS = {
  'default': { disableAnimation: 1, capturePseudo: 1, zIndexSort: 1, allowScripts: 0,
    probeRoutes: 0, hoverStates: 0, overlayStates: 1, lowfiMode: 0, backdrop: 0 },
  structure: { disableAnimation: 1, capturePseudo: 1, zIndexSort: 1, allowScripts: 0,
    probeRoutes: 0, hoverStates: 0, overlayStates: 1, lowfiMode: 1, backdrop: 1 },
  interaction: { disableAnimation: 1, capturePseudo: 1, zIndexSort: 1, allowScripts: 1,
    probeRoutes: 0, hoverStates: 1, overlayStates: 1, lowfiMode: 0, backdrop: 0 },
};

const PRESET_LABEL = { 'default': '默认', structure: '看结构', interaction: '看交互' };

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  for (const k in p) {
    const el = $(k);
    if (el && 'checked' in el) el.checked = !!p[k];
  }
  log('已套用预设「' + (PRESET_LABEL[name] || name) + '」');
}

function wireOptionHelpers() {
  const vpButtons = document.querySelectorAll ? document.querySelectorAll('[data-vp]') : [];
  Array.prototype.forEach.call(vpButtons, (btn) => {
    btn.onclick = () => {
      const m = /^(\d+)x(\d+)$/.exec(btn.getAttribute('data-vp') || '');
      if (!m) return;
      const w = $('vw');
      const h = $('vh');
      if (w) w.value = m[1];
      if (h) h.value = m[2];
      /* 手机 / 平板尺寸自动切「一屏」：App 类页面一屏一稿，
         底栏才会正好落在画板底部（贴合内容会把画板撑高，底栏就停在视口位置了） */
      const crop = $('crop');
      const nw = parseInt(m[1], 10);
      if (crop && nw <= 900 && crop.value !== 'viewport') {
        crop.value = 'viewport';
        log('视口 ' + m[1] + ' × ' + m[2] + '　画板范围自动切到「一屏」');
      } else {
        log('视口已设为 ' + m[1] + ' × ' + m[2]);
      }
    };
  });

  /* 设备预设：选了就填进去，同时关掉「自动识别」 */
  const presetSel = $('devicePreset');
  if (presetSel) {
    presetSel.onchange = () => {
      const m = /^(\d+)x(\d+)$/.exec(presetSel.value || '');
      if (!m) return;
      if ($('vw')) $('vw').value = m[1];
      if ($('vh')) $('vh').value = m[2];
      const a = $('autoViewport');
      if (a) a.checked = false;
      const cropEl = $('crop');
      if (cropEl && parseInt(m[1], 10) <= 900 && cropEl.value !== 'viewport') cropEl.value = 'viewport';
      const note = $('autoNote');
      if (note) note.textContent = '';
      log('设备预设：' + m[1] + ' × ' + m[2]);
    };
  }

  /* 手动改视口或画板范围 = 放弃自动识别 */
  ['vw', 'vh', 'crop'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const a = $('autoViewport');
      if (a) a.checked = false;
    });
  });

  /* 还原模式单选 */
  const modeInputs = document.querySelectorAll ? document.querySelectorAll('input[name="renderMode"]') : [];
  Array.prototype.forEach.call(modeInputs, (r) => {
    r.onchange = () => { if (r.checked) applyRenderMode(r.value); };
  });
  const checkedMode = Array.prototype.filter.call(modeInputs, (r) => r.checked)[0];
  if (checkedMode) applyRenderMode(checkedMode.value === 'both' ? 'both' : 'style');

  ['default', 'structure', 'interaction'].forEach((n) => {
    const b = $('preset-' + n);
    if (b) b.onclick = () => applyPreset(n);
  });
}

function bootUi() {
  /* 界面元素在两套壳里并不完全一样（插件端已经把页签并成两种模式），
     所以每个绑定都按「存在才绑」处理：少一个元素不该让整套初始化中断 */
  const bindClick = (id, fn) => {
    const el = $(id);
    if (el) el.onclick = fn;
  };
  const setText = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };

  TAB_NAMES.forEach((name) => bindClick('tab-' + name, () => setTab(name)));
  wireTabKeys();
  setTab('paste');

  /* 输入 / 文件 两种模式 */
  bindClick('mode-input', () => setMode('input'));
  bindClick('mode-file', () => setMode('file'));
  setMode('input');
  wireFileMode();
  wirePackageInput();

  const fileInput = $('file');
  if (fileInput) {
    fileInput.onchange = (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const fr = new FileReader();
      fr.onload = () => {
        const ta = $('html');
        if (ta) ta.value = String(fr.result || '');
        log('已载入本地文件：' + file.name);
        setTab('paste');
        showLoadedFile(file.name);
      };
      fr.readAsText(file, 'utf-8');
    };
  }

  bindClick('btn-run', run);
  bindClick('btn-cancel', () => {
    state.cancelled = true;
    parent.postMessage({ pluginMessage: { type: 'cancel' } }, '*');
    state.running = false;
    const runBtn = $('btn-run');
    if (runBtn) runBtn.disabled = false;
    const cancelBtn = $('btn-cancel');
    if (cancelBtn) cancelBtn.disabled = true;
    log('已请求取消', 'warn');
  });
  bindClick('btn-sample', () => {
    const ta = $('html');
    if (ta) ta.value = SAMPLE_HTML;
    setTab('paste');
    setMode('input');
    log('已填入示例 HTML，可直接点「开始复刻」');
  });
  bindClick('btn-clear', () => {
    const lo = $('log');
    if (lo) lo.innerHTML = '';
    const re = $('report');
    if (re) re.innerHTML = '';
  });

  enhanceNumberInputs();
  wireFileQueue();
  wireOptionHelpers();

  const proxySel = $('proxy');
  if (proxySel) {
    proxySel.onchange = () => {
      log('代理：' + proxySel.value);
      if (proxySel.value) {
        const hint = $('proxy-hint');
        if (hint) hint.textContent = '';
      }
    };
  }
  setText('proxy-hint', '');
}

const SAMPLE_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><style>',
  '*{box-sizing:border-box;margin:0;padding:0}',
  'body{font-family:Inter,"Noto Sans SC",sans-serif;background:#f6f7fb;padding:40px;display:flex;gap:24px}',
  '.card{width:320px;background:#fff;border-radius:16px;padding:24px;box-shadow:0 8px 24px rgba(16,24,40,.08);border:1px solid #eaecf0}',
  '.card h2{font-size:20px;font-weight:600;color:#101828;margin-bottom:8px}',
  '.card p{font-size:14px;line-height:22px;color:#667085}',
  '.btn{margin-top:16px;display:inline-block;padding:10px 18px;border-radius:10px;color:#fff;font-size:14px;font-weight:600;background:linear-gradient(135deg,#5b8def,#8b5cf6)}',
  '.tag{display:inline-block;margin-top:12px;font-size:12px;padding:4px 10px;border-radius:999px;color:#175cd3;background:#eff8ff;border:1px solid #b2ddff}',
  '</style></head><body>',
  '<div class="card"><h2>像素级复刻</h2><p>浏览器真实排版 · 圆角 / 阴影 / 渐变 / 描边 / 字体 全部还原</p>',
  '<div class="btn">开始复刻</div><div class="tag">1:1 Snapshot</div></div>',
  '<div class="card"><h2>可继续编辑</h2><p>文字是文本图层，图形是矢量矩形，图片可替换填充。</p>',
  '<div class="tag">Editable</div></div>',
  '</body></html>',
].join('\n');

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUi);
else bootUi();
