/* ============================================================================
 * core/code-interactions.js — 从页面自己的代码里读出交互
 *
 * 和「运行时试点击」的思路不同：这里不猜，而是**读代码的语义**。
 * 页面写了「按钮 A 按下 → 界面 B」，复刻出来就是「A 按下 → B」。
 *
 * 能读懂的写法（覆盖手写 App 的绝大多数情况）：
 *
 *   1) 属性驱动 + 本地函数
 *        all('[data-view]').forEach((el) => {
 *          el.addEventListener('click', () => {
 *            const name = el.getAttribute('data-view');
 *            show(name, true);
 *          });
 *        });
 *        function show(name, push) { ... history.pushState({}, '', '#/' + name); }
 *      → { selector: '[data-view]', attr: 'data-view', kind: 'route', target: '#/{data-view}' }
 *
 *   2) 直接改地址
 *        btn.addEventListener('click', () => { location.hash = '#sheet-add'; });
 *      → { selector: '#btn-add', kind: 'overlay', target: '#sheet-add' }
 *
 *   3) 藏在 setTimeout / 回调里的
 *        item.addEventListener('pointerdown', () => {
 *          setTimeout(() => { location.hash = '#dialog-delete'; }, 550);
 *        });
 *      → { selector: '[data-long]', trigger: 'pointerdown', kind: 'overlay', target: '#dialog-delete' }
 *
 *   4) 视图切换（改 class 而不是改地址）
 *        views.forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
 *      → { selector: '[data-…]', kind: 'view', target: 'view-{…}' }
 *
 * 纯逻辑，不依赖 DOM，可单独测试。
 * ========================================================================== */
(function (global) {
  'use strict';

  const VERSION = 'h2f.codeix/v1';

  /** 去注释（保留字符串内容：路由、#id 都在字符串里） */
  function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let quote = null;
    while (i < n) {
      const c = src[i];
      const c2 = src[i + 1];
      if (quote) {
        out += c;
        if (c === '\\') { out += (c2 || ''); i += 2; continue; }
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
      if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      out += c;
      i++;
    }
    return out;
  }

  /** 从 openIdx 处的括号开始，返回配对括号的索引 */
  function balanced(src, openIdx, open, close) {
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  /** 函数名 → 函数体 */
  function collectFunctions(src) {
    const out = {};
    let m;
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
    while ((m = re.exec(src))) {
      const end = balanced(src, m.index + m[0].length - 1, '{', '}');
      if (end < 0) continue;
      out[m[1]] = { params: String(m[2] || '').split(',').map((s) => s.trim()).filter(Boolean),
        body: src.slice(m.index + m[0].length, end) };
    }
    const re2 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\(([^)]*)\)\s*\{/g;
    while ((m = re2.exec(src))) {
      const end = balanced(src, m.index + m[0].length - 1, '{', '}');
      if (end < 0) continue;
      out[m[1]] = { params: String(m[2] || '').split(',').map((s) => s.trim()).filter(Boolean),
        body: src.slice(m.index + m[0].length, end) };
    }
    return out;
  }

  /** 变量 → 选择器：const add = document.getElementById('btn-add') */
  /**
   * 从 pos 往前做括号配对，找出**包住这一行的那条 forEach**。
   * 归属判定必须这么做：同一段代码里常出现同名局部变量，靠距离猜会错。
   */
  function enclosingForEach(code, pos) {
    const stack = [];
    let quote = null;
    for (let i = 0; i < pos; i++) {
      const ch = code[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '{' || ch === '[') stack.push({ ch: ch, at: i });
      else if (ch === ')' || ch === '}' || ch === ']') stack.pop();
    }
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].ch !== '(') continue;
      const open = stack[k].at;
      const head = code.slice(Math.max(0, open - 220), open);
      const mm = /([A-Za-z_$][\w$.]*)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*forEach\s*$/.exec(head);
      if (!mm) continue;
      const after = code.slice(open, open + 160);
      const pm = /^\(\s*(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(after);
      if (pm) return { selector: mm[2], param: pm[1] };
    }
    return null;
  }

  function collectVarSelectors(src) {
    const out = {};
    let m;
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.(getElementById|querySelector)\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = re.exec(src))) {
      out[m[1]] = (m[2] === 'getElementById') ? ('#' + m[3]) : m[3];
    }
    return out;
  }

  /** 从一段代码里找「目标」：返回 { kind, target } 或 null */
  function findTarget(body, fns, depth) {
    /* 直接改地址 */
    let m = /location\.hash\s*=\s*(['"])([^'"]+)\1/.exec(body);
    if (m) return { kind: m[2].charAt(1) === '/' ? 'route' : 'overlay', target: m[2], source: 'location.hash' };

    m = /location\.(?:href|assign|replace)\s*(?:=|\()\s*(['"])([^'"]+)\1/.exec(body);
    if (m) return { kind: /^https?:|^\/\//.test(m[2]) ? 'external' : 'navigate', target: m[2], source: 'location.href' };

    /* history.pushState/replaceState 的第三个参数 */
    m = /history\.(?:pushState|replaceState)\s*\(([^)]*)\)/.exec(body);
    if (m) {
      const args = m[1];
      const lit = /(['"])([^'"]*)\1/.exec(args.split(',').slice(2).join(',') || args);
      if (lit) {
        const tail = body.slice(m.index + m[0].length, m.index + m[0].length + 40);
        if (lit[2] && /['"]\s*\+/.test(args.slice(args.indexOf(lit[2]) + lit[2].length)) || /\+\s*\w/.test(tail)) {
          return { kind: 'route', prefix: lit[2], varFrom: 'tail', source: 'pushState' };
        }
        return { kind: lit[2].charAt(1) === '/' ? 'route' : 'navigate', target: lit[2], source: 'pushState' };
      }
    }

    /* 视图切换：改 id 前缀 + classList */
    m = /\.id\s*===\s*(['"])([^'"]*)\1\s*\+\s*([A-Za-z_$][\w$]*)/.exec(body);
    if (m && /classList\.(add|remove|toggle)/.test(body)) {
      return { kind: 'view', prefix: m[2], varName: m[3], source: 'classList+id' };
    }

    /* 展开一层函数调用 */
    if (depth < 3) {
      const re = /([A-Za-z_$][\w$]*)\s*\(([^;]*)\)/g;
      let c;
      while ((c = re.exec(body))) {
        const name = c[1];
        if (!fns[name]) continue;
        if (['if', 'for', 'while', 'switch', 'return', 'catch', 'function', 'forEach',
          'setTimeout', 'addEventListener', 'map', 'filter', 'push', 'call', 'apply'].indexOf(name) >= 0) continue;
        const inner = findTarget(fns[name].body, fns, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  }

  /** 在这段代码里找「控件属性 → 变量」的取值：const name = el.getAttribute('data-view') */
  function findAttrVar(body) {
    let m = /([A-Za-z_$][\w$]*)\s*=\s*[\w$.\[\]]*getAttribute\(\s*['"]([^'"]+)['"]\s*\)/.exec(body);
    if (m) return { varName: m[1], attr: m[2] };
    m = /([A-Za-z_$][\w$]*)\s*=\s*[\w$.\[\]]*\.dataset\.([A-Za-z_$][\w$]*)/.exec(body);
    if (m) return { varName: m[1], attr: 'data-' + m[2].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) };
    return null;
  }

  /** 选择器：把 all('[data-view]') / document.querySelectorAll('.chip') 归一 */
  function normalizeSelector(sel) {
    return String(sel || '').trim();
  }

  /**
   * 主入口。
   * @param {string} src  页面所有脚本拼起来的源码
   * @returns [{ selector, trigger, attr, kind, target, source }]
   */
  function analyze(src) {
    const code = stripComments(String(src || ''));
    const fns = collectFunctions(code);
    const varSel = collectVarSelectors(code);
    const out = [];
    let m;

    /* X.addEventListener('click', FN) —— X 可能是容器变量名，也可能是选择器字符串 */
    const re = /([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*\.\s*addEventListener\s*\(\s*(['"])([A-Za-z]+)\2\s*,\s*/g;
    while ((m = re.exec(code))) {
      const owner = m[1];
      const trigger = m[3];
      const fnStart = m.index + m[0].length;
      let body = '';
      if (code.charAt(fnStart) === 'f' && code.slice(fnStart, fnStart + 8) === 'function') {
        const open = code.indexOf('{', fnStart);
        const end = balanced(code, open, '{', '}');
        if (end > 0) body = code.slice(open + 1, end);
      } else if (code.charAt(fnStart) === '(' ) {
        const close = balanced(code, fnStart, '(', ')');
        const arrow = code.indexOf('=>', close);
        if (arrow > 0) {
          const open = code.indexOf('{', arrow);
          if (open > 0) {
            const end = balanced(code, open, '{', '}');
            if (end > 0) body = code.slice(open + 1, end);
          }
        }
      }
      if (!body) continue;

      /* 这个监听器挂在哪些控件上 */
      let selector = '';
      if (owner.charAt(0) === '"' || owner.charAt(0) === "'") {
        selector = normalizeSelector(owner.slice(1, -1));
      } else {
        /* 顺序不能反：先做词法归属（这条监听器被哪条 forEach 包着，参数名要对得上），
           再退回全局变量表。同名局部变量会骗过变量表 ——
           forEach 的 el 和 var el = getElementById('toast') 完全是两回事。 */
        const fe = enclosingForEach(code, m.index);
        if (fe && fe.param === owner) selector = normalizeSelector(fe.selector);
        else if (varSel[owner]) selector = normalizeSelector(varSel[owner]);
      }
      if (!selector) continue;

      const target = findTarget(body, fns, 0);
      if (!target) continue;
      const av = findAttrVar(body);

      const rule = { selector: selector, trigger: trigger, source: target.source, kind: target.kind };
      if (av && av.attr && (target.kind === 'route' || target.kind === 'view')) {
        rule.attr = av.attr;
        rule.target = target.prefix ? (target.prefix + '{' + av.attr + '}') : ('#/' + '{' + av.attr + '}');
      } else if (target.kind === 'view' && target.prefix) {
        rule.target = target.prefix + '{view}';
      } else {
        rule.target = target.target || '';
      }
      if (!rule.target) continue;

      /* 同一个选择器 + 同一个目标只留一条 */
      const key = rule.selector + '|' + rule.trigger + '|' + rule.target;
      if (!out.some((r) => (r.selector + '|' + r.trigger + '|' + r.target) === key)) out.push(rule);
    }

    /* X.onclick = FN */
    const re2 = /([A-Za-z_$][\w$]*)\s*\.\s*onclick\s*=\s*(?:function\s*\([^)]*\)\s*\{|\([^)]*\)\s*=>\s*\{)/g;
    while ((m = re2.exec(code))) {
      const open = code.indexOf('{', m.index + m[0].length - 1);
      const end = balanced(code, open, '{', '}');
      if (end < 0) continue;
      const body = code.slice(open + 1, end);
      const selector = varSel[m[1]];
      if (!selector) continue;
      const target = findTarget(body, fns, 0);
      if (!target) continue;
      const av = findAttrVar(body);
      const rule = { selector: selector, trigger: 'click', source: target.source, kind: target.kind,
        target: target.target || (av ? '#/' + '{' + av.attr + '}' : '') };
      if (av && av.attr) rule.attr = av.attr;
      if (rule.target) out.push(rule);
    }

    return out;
  }

  global.H2FCodeIx = { analyze: analyze, version: VERSION, stripComments: stripComments };
})(typeof globalThis !== 'undefined' ? globalThis : this);
