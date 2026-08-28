// ==UserScript==
// @name         LinuxDo 主题过滤器
// @namespace    https://linux.do/
// @version      0.1.0
// @description  按 类别/标签/标题正则 过滤 linux.do 全局流主题帖，被过滤帖收入「已过滤」标签页。支持 AND/OR/NOT 组合 DSL。
// @author       you
// @match        https://linux.do/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  // ───────────────────────── 常量 ─────────────────────────
  // 过滤路由：latest / new / unseen / hot / top / read
  // 不拦：/c /tag /u /search /t /posted /bookmarks 及 ?category= 缩范围
  var BUCKET_MAX = 1000;
  var RULES_KEY = 'ldf_rules_v1';        // [{name, enabled, expr}]
  var CAT_TTL_KEY = 'ldf_catmap_ts';     // 兜底 fetch 缓存时间戳（会话内不主动用，留作扩展）

  // ───────────────────────── 状态 ─────────────────────────
  var state = {
    catMap: null,          // { id2:Map, byName:Map } 类别映射
    catMapPromise: null,   // 兜底 fetch 进行中 promise
    buckets: {},           // route -> { map:Map(id->topic), order:[id] } 按路由分段
    predicates: [],        // 已编译且启用的规则谓词 [{name, fn}]
    rulesMeta: [],         // 全部规则元信息（含错误）供编辑器展示 [{name,enabled,expr,error}]
    currentRoute: null,    // 当前所在全局路由名（latest/new/unseen/hot/top/read）；非过滤路由为 null
  };

  // ───────────────────────── 小工具 ─────────────────────────
  function log() { try { console.log.apply(console, ['%c[LDF]', 'color:#3aa'].concat([].slice.call(arguments))); } catch (e) {} }
  function err() { try { console.error.apply(console, ['%c[LDF]', 'color:#e55'].concat([].slice.call(arguments))); } catch (e) {} }

  function gmGet(key, def) {
    try { var v = GM_getValue(key, def); return (v === undefined || v === null) ? def : v; } catch (e) { return def; }
  }
  function gmSet(key, val) { try { GM_setValue(key, val); } catch (e) {} }

  // ───────────────────────── 类别映射 ─────────────────────────
  // 从预载块的 site 字段（已 parse 的对象）构建；缺则回退 fetch('/site.json')
  function buildCatMap(categories) {
    var id2 = new Map();
    var byName = new Map();
    (categories || []).forEach(function (c) {
      var rec = { id: c.id, name: c.name, slug: c.slug, parentId: c.parent_category_id || null };
      id2.set(c.id, rec);
      if (!byName.has(c.name)) byName.set(c.name, []);
      byName.get(c.name).push(rec);
    });
    state.catMap = { id2: id2, byName: byName };
    log('类别映射就绪：', id2.size, '个类别');
  }

  function ensureCatMapFromSite(siteObj) {
    if (state.catMap) return;
    if (siteObj && siteObj.categories) { buildCatMap(siteObj.categories); return; }
  }

  function ensureCatMapFallback() {
    if (state.catMap) return Promise.resolve(state.catMap);
    if (state.catMapPromise) return state.catMapPromise;
    state.catMapPromise = new Promise(function (resolve) {
      fetch('/site.json', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (s) { buildCatMap(s.categories); resolve(state.catMap); })
        .catch(function (e) { err('回退 /site.json 失败', e); resolve(null); });
    });
    return state.catMapPromise;
  }

  // 解析 category 原子 → 返回匹配的 id 集合；失败抛 Error
  function resolveCategoryIds(name, levels) {
    var map = state.catMap;
    if (!map) throw new Error('类别映射未就绪');
    var cands = map.byName.get(name);
    if (!cands || !cands.length) throw new Error('类别名未找到：' + name);
    // 优先选无父的（即父类别本身）
    var parent = cands.filter(function (c) { return c.parentId === null; })[0] || cands[0];
    var ids = new Set();

    if (!levels || !levels.length) {
      // 省略级：父 + 全部子孙（递归）
      collectDescendants(parent.id, ids);
    } else {
      levels.forEach(function (lv) {
        if (lv === 0) { ids.add(parent.id); return; }
        var child = findChildByLv(parent.id, lv);
        if (child == null) throw new Error('类别「' + name + '」不存在 Lv' + lv);
        ids.add(child);
      });
    }
    return ids;
  }

  function collectDescendants(pid, ids) {
    ids.add(pid);
    var map = state.catMap;
    map.id2.forEach(function (c) {
      if (c.parentId === pid) collectDescendants(c.id, ids);
    });
  }

  function findChildByLv(pid, lv) {
    var map = state.catMap;
    var suf = ', Lv' + lv;
    var hit = null;
    map.id2.forEach(function (c) {
      if (c.parentId === pid && (c.name || '').endsWith(suf)) hit = c.id;
    });
    return hit;
  }

  // ───────────────────────── DSL：词法 ─────────────────────────
  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;
    function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'; }
    while (i < n) {
      var c = src[i];
      if (isWs(c)) { i++; continue; }
      if (c === '(' || c === ')' || c === ',') { tokens.push({ t: c }); i++; continue; }
      if (c === '"') { // 引号字符串
        var j = i + 1, buf = '';
        while (j < n && src[j] !== '"') { if (src[j] === '\\' && j + 1 < n) { buf += src[j + 1]; j += 2; } else { buf += src[j]; j++; } }
        if (j >= n) throw new Error('字符串未闭合');
        tokens.push({ t: 'str', v: buf }); i = j + 1; continue;
      }
      if (c === '/') { // 可能是正则字面量 /.../flags
        var k = i + 1, re = '', ok = false;
        while (k < n) {
          if (src[k] === '\\' && k + 1 < n) { re += src[k] + src[k + 1]; k += 2; continue; }
          if (src[k] === '/') { ok = true; break; }
          re += src[k]; k++;
        }
        if (ok) {
          var flags = '';
          k++;
          while (k < n && /[gimsuy]/.test(src[k])) { flags += src[k]; k++; }
          tokens.push({ t: 'regex', v: re, flags: flags }); i = k; continue;
        }
        // 否则当普通字符（落到 ident）
      }
      // 裸词：读直到遇到 ( ) , 空白 / 或 "
      var w = '';
      while (i < n && !isWs(src[i]) && src[i] !== '(' && src[i] !== ')' && src[i] !== ',' && src[i] !== '"' && src[i] !== '/') { w += src[i]; i++; }
      if (w.length) {
        var up = w.toUpperCase();
        if (up === 'AND' || up === 'OR' || up === 'NOT') tokens.push({ t: up });
        else if (w.toLowerCase() === 'category' || w.toLowerCase() === 'tag' || w.toLowerCase() === 'title') tokens.push({ t: 'atom', v: w.toLowerCase() });
        else tokens.push({ t: 'word', v: w });
        continue;
      }
      // 未识别（如单独的 /），跳过避免死循环
      i++;
    }
    return tokens;
  }

  // ───────────────────────── DSL：语法（递归下降） ─────────────────────────
  function Parser(tokens) {
    this.toks = tokens; this.i = 0;
  }
  Parser.prototype.peek = function () { return this.toks[this.i]; };
  Parser.prototype.next = function () { return this.toks[this.i++]; };
  Parser.prototype.expect = function (t) {
    var tk = this.next();
    if (!tk || tk.t !== t) throw new Error('期望 ' + t + '，实际 ' + (tk ? tk.t : 'EOF'));
    return tk;
  };

  Parser.prototype.parse = function () {
    var node = this.parseOr();
    if (this.i < this.toks.length) throw new Error('尾部多余 token：' + JSON.stringify(this.toks[this.i]));
    return node;
  };
  Parser.prototype.parseOr = function () {
    var left = this.parseAnd();
    while (this.peek() && this.peek().t === 'OR') { this.next(); var right = this.parseAnd(); left = { op: 'OR', l: left, r: right }; }
    return left;
  };
  Parser.prototype.parseAnd = function () {
    var left = this.parseNot();
    while (this.peek() && this.peek().t === 'AND') { this.next(); var right = this.parseNot(); left = { op: 'AND', l: left, r: right }; }
    return left;
  };
  Parser.prototype.parseNot = function () {
    if (this.peek() && this.peek().t === 'NOT') { this.next(); return { op: 'NOT', v: this.parseNot() }; }
    return this.parseAtom();
  };
  Parser.prototype.parseAtom = function () {
    var tk = this.peek();
    if (!tk) throw new Error('意外的输入结尾');
    if (tk.t === '(') {
      this.next();
      var inner = this.parseOr();
      this.expect(')');
      return inner;
    }
    if (tk.t === 'atom') {
      this.next();
      this.expect('(');
      if (tk.v === 'category') return this.parseCategoryArgs();
      if (tk.v === 'tag') return this.parseTagArgs();
      if (tk.v === 'title') return this.parseTitleArg();
      throw new Error('未知原子：' + tk.v);
    }
    throw new Error('意外的 token：' + tk.t);
  };
  Parser.prototype.parseNameList = function () {
    var names = [];
    if (this.peek() && this.peek().t === ')') return names; // 空参数 → 后续校验报错
    while (true) {
      var tk = this.next();
      if (!tk) throw new Error('参数中遇到 EOF');
      if (tk.t === 'str') names.push(tk.v);
      else if (tk.t === 'word') names.push(tk.v);
      else if (tk.t === 'regex') throw new Error('此处不应为正则');
      else throw new Error('参数中意外的 token：' + tk.t);
      if (this.peek() && this.peek().t === ',') { this.next(); continue; }
      break;
    }
    return names;
  };
  Parser.prototype.parseCategoryArgs = function () {
    var names = this.parseNameList();
    this.expect(')');
    if (!names.length) throw new Error('category() 缺少类别名');
    var name = names[0];
    var levels = names.slice(1).map(function (s) {
      var m = /^-?\d+$/.exec(s);
      if (!m) throw new Error('category 级别应为整数，实际：' + s);
      return parseInt(s, 10);
    });
    return { op: 'category', name: name, levels: levels };
  };
  Parser.prototype.parseTagArgs = function () {
    var names = this.parseNameList();
    this.expect(')');
    if (!names.length) throw new Error('tag() 缺少标签名');
    return { op: 'tag', names: names };
  };
  Parser.prototype.parseTitleArg = function () {
    var tk = this.next();
    if (!tk) throw new Error('title() 缺少参数');
    if (tk.t === 'regex') { this.expect(')'); return { op: 'title', regex: tk.v, flags: tk.flags }; }
    if (tk.t === 'str' || tk.t === 'word') { this.expect(')'); return { op: 'title', literal: tk.v }; }
    throw new Error('title() 参数应为正则或字符串');
  };

  function parseDSL(src) { return new Parser(tokenize(src)).parse(); }

  // ───────────────────────── DSL：编译为谓词 ─────────────────────────
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function compile(node) {
    switch (node.op) {
      case 'OR': { var l = compile(node.l), r = compile(node.r); return function (t) { return l(t) || r(t); }; }
      case 'AND': { var la = compile(node.l), ra = compile(node.r); return function (t) { return la(t) && ra(t); }; }
      case 'NOT': { var v = compile(node.v); return function (t) { return !v(t); }; }
      case 'category': {
        var ids = resolveCategoryIds(node.name, node.levels);
        return function (t) { return ids.has(t.category_id); };
      }
      case 'tag': {
        var set = new Set(node.names.map(function (s) { return (s || '').toLowerCase(); }));
        return function (t) { return !!(t.tags && t.tags.some(function (x) { return set.has((x.name || '').toLowerCase()); })); };
      }
      case 'title': {
        var re;
        if ('regex' in node) { re = new RegExp(node.regex, node.flags || ''); }
        else { re = new RegExp(escapeRe(node.literal || ''), 'i'); }
        return function (t) { return re.test(t.title || t.fancy_title || ''); };
      }
      default: throw new Error('未知节点 op：' + node.op);
    }
  }

  // ───────────────────────── 规则引擎 ─────────────────────────
  function reloadRules() {
    var raw = gmGet(RULES_KEY, []);
    if (!Array.isArray(raw)) raw = [];
    state.rulesMeta = raw.map(function (r) { return { name: r.name, enabled: !!r.enabled, expr: r.expr || '', error: null }; });
    state.predicates = [];
    raw.forEach(function (r) {
      if (!r.enabled) return;
      try {
        var ast = parseDSL(r.expr || '');
        if (!state.catMap) ensureCatMapFallback();
        var fn = compile(ast);
        state.predicates.push({ name: r.name, fn: fn });
      } catch (e) {
        var meta = state.rulesMeta.find(function (m) { return m.name === r.name; });
        if (meta) meta.error = e.message;
      }
    });
    log('规则编译完成：启用谓词', state.predicates.length, '条，规则总数', state.rulesMeta.length);
  }

  // 命中任一启用谓词 → true（OR 合并）
  function isFiltered(topic) {
    if (!state.predicates.length) return false;
    for (var i = 0; i < state.predicates.length; i++) {
      try { if (state.predicates[i].fn(topic)) return true; } catch (e) { /* 运行期忽略 */ }
    }
    return false;
  }

  // ───────────────────────── 已过滤桶（按路由分段） ─────────────────────────
  function routeBucket(route) {
    if (!state.buckets[route]) state.buckets[route] = { map: new Map(), order: [] };
    return state.buckets[route];
  }
  function bucketAdd(route, topic) {
    if (!topic || topic.id == null) return false;
    var b = routeBucket(route);
    if (b.map.has(topic.id)) return false;
    b.map.set(topic.id, topic);
    b.order.push(topic.id);
    while (b.order.length > BUCKET_MAX) {
      var old = b.order.shift();
      b.map.delete(old);
    }
    return true;
  }
  function bucketAddMany(route, topics) {
    var added = 0;
    (topics || []).forEach(function (t) { if (bucketAdd(route, t)) added++; });
    if (added && route === state.currentRoute) updateCount();
    return added;
  }
  function bucketCount() {
    var b = state.buckets[state.currentRoute];
    return b ? b.order.length : 0;
  }
  function currentBucketOrder() {
    var b = state.buckets[state.currentRoute];
    return b ? b.order : [];
  }
  function currentBucketMap() {
    var b = state.buckets[state.currentRoute];
    return b ? b.map : new Map();
  }

  // ───────────────────────── 核心：切分 kept/filtered ─────────────────────────
  function splitTopics(topics) {
    var kept = [], filtered = [];
    (topics || []).forEach(function (t) {
      if (isFiltered(t)) filtered.push(t); else kept.push(t);
    });
    return { kept: kept, filtered: filtered };
  }

  // 处理一个 topic_list 对象（首屏 preloaded 或 XHR/fetch 响应体）
  function processTopicList(route, obj) {
    if (!obj || !obj.topic_list || !Array.isArray(obj.topic_list.topics)) return null;
    var sp = splitTopics(obj.topic_list.topics);
    if (sp.filtered.length) bucketAddMany(route, sp.filtered);
    obj.topic_list.topics = sp.kept;
    return sp;
  }

  // ───────────────────────── 路由匹配 ─────────────────────────
  // 从 URL 提取全局路由名（latest/new/unseen/hot/top/read）；非过滤路由返回 null
  function routeNameFromUrl(u) {
    try {
      var url = new URL(u, location.href);
      if (/category=/i.test(url.search)) return null;
      var m = /^\/(latest|new|unseen|hot|top|read)(\.json)?(\/.*)?$/i.exec(url.pathname);
      return m ? m[1].toLowerCase() : null;
    } catch (e) { return null; }
  }
  function urlIsGlobalRoute(u) { return routeNameFromUrl(u) !== null; }

  // 同步当前路由（SPA 路由切换时由 MO 调用）；非过滤路由时置 null，计数归 0
  function syncCurrentRoute() {
    state.currentRoute = routeNameFromUrl(location.pathname);
  }

  function bodyLooksLikeTopicList(text) {
    if (!text) return false;
    return text.indexOf('"topic_list"') !== -1 && text.indexOf('"topics"') !== -1;
  }

  // ───────────────────────── fetch hook ─────────────────────────
  var _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
      var route = routeNameFromUrl(url);
      return _fetch.apply(this, arguments).then(function (resp) {
        if (!route) return resp;
        var ct = resp.headers.get('content-type') || '';
        if (ct.indexOf('json') === -1) return resp;
        return resp.clone().text().then(function (text) {
          if (!bodyLooksLikeTopicList(text)) return resp;
          try {
            var obj = JSON.parse(text);
            var sp = processTopicList(route, obj);
            if (!sp) return resp;
            var rewriter = new Response(JSON.stringify(obj), {
              status: resp.status, statusText: resp.statusText,
              headers: resp.headers
            });
            if (route === state.currentRoute) selfEmptyGuard(sp);
            return rewriter;
          } catch (e) { err('fetch 过滤失败', e); return resp; }
        });
      });
    };
  }

  // ───────────────────────── XHR hook（惰性改写 responseText/response） ─────────────────────────
  try {
    if (typeof XMLHttpRequest === 'undefined') throw new Error('环境无 XMLHttpRequest');
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    var descText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    var descResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ldf_url = url; this.__ldf_done = false;
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var route = routeNameFromUrl(xhr.__ldf_url || '');
      if (route && descText) {
        var install = function () {
          if (xhr.__ldf_done) return; xhr.__ldf_done = true;
          try {
            Object.defineProperty(xhr, 'responseText', {
              get: function () {
                var orig = descText.get.call(xhr);
                if (xhr.__ldf_cached !== undefined) return xhr.__ldf_cached;
                if (!bodyLooksLikeTopicList(orig)) { xhr.__ldf_cached = orig; return orig; }
                try {
                  var obj = JSON.parse(orig);
                  var sp = processTopicList(route, obj);
                  if (!sp) { xhr.__ldf_cached = orig; return orig; }
                  xhr.__ldf_cached = JSON.stringify(obj);
                  if (route === state.currentRoute) selfEmptyGuard(sp);
                  return xhr.__ldf_cached;
                } catch (e) { err('XHR 过滤失败', e); xhr.__ldf_cached = orig; return orig; }
              }
            });
            if (descResp) Object.defineProperty(xhr, 'response', {
              get: function () {
                if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText;
                return descResp.get.call(xhr);
              }
            });
          } catch (e) {}
        };
        xhr.addEventListener('readystatechange', function () { if (xhr.readyState === 4) install(); });
      }
      return _send.apply(this, arguments);
    };
  } catch (e) { err('XHR hook 安装失败', e); }

  // ───────────────────────── 预载块拦截（document-start → DOMContentLoaded） ─────────────────────────
  var preloadedRewritten = false;
  function rewritePreloaded(script) {
    if (!script || preloadedRewritten) return;
    var text = script.textContent;
    if (!text || text.indexOf('"topic_list"') === -1) return;
    try {
      var outer = JSON.parse(text);
      // 先建类别映射
      if (outer.site && typeof outer.site === 'string') { try { ensureCatMapFromSite(JSON.parse(outer.site)); } catch (e) {} }
      else if (outer.site && typeof outer.site === 'object') { ensureCatMapFromSite(outer.site); }
      // 编译规则（依赖类别映射）
      reloadRules();
      // 首屏路由 = 当前 location.pathname 对应的全局路由
      var firstRoute = routeNameFromUrl(location.pathname) || (outer.topic_list && outer.topic_list.filter) || 'latest';
      state.currentRoute = firstRoute;
      // 过滤首屏 topic_list
      if (outer.topic_list && typeof outer.topic_list === 'string') {
        var tl = JSON.parse(outer.topic_list);
        var sp = processTopicList(firstRoute, tl);
        if (sp) { outer.topic_list = JSON.stringify(tl); selfEmptyGuard(sp); }
      }
      script.textContent = JSON.stringify(outer);
      preloadedRewritten = true;
      log('预载块已改写');
    } catch (e) { err('预载块改写失败', e); }
  }

  // document-start 时 DOM 尚未解析，用 MO 捕获 <script id=data-preloaded> 出现
  var preObs = null;
  try {
    preObs = new MutationObserver(function (mutations) {
      if (preloadedRewritten) { if (preObs) preObs.disconnect(); return; }
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.id === 'data-preloaded' && node.tagName === 'SCRIPT') { rewritePreloaded(node); }
          else if (node.querySelectorAll) {
            var s = node.querySelector('script#data-preloaded');
            if (s) rewritePreloaded(s);
          }
        }
      }
      if (preloadedRewritten && preObs) preObs.disconnect();
    });
    preObs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { err('预载 MO 安装失败', e); }

  // DOMContentLoaded 兜底（MO 万一没拦到）
  document.addEventListener('DOMContentLoaded', function () {
    if (!preloadedRewritten) {
      var s = document.querySelector('script#data-preloaded');
      if (s) rewritePreloaded(s);
    }
    if (!state.catMap) ensureCatMapFallback().then(reloadRules);
    bootUI();
  });

  // ───────────────────────── 自空护栏 ─────────────────────────
  var pendingSelfEmpty = 0;
  function selfEmptyGuard(sp) {
    if (sp.kept.length === 0 && sp.filtered.length > 0) {
      pendingSelfEmpty = sp.filtered.length;
    }
  }
  function tryRenderSelfEmpty() {
    if (!pendingSelfEmpty) return;
    var body = document.querySelector('.topic-list-body');
    if (body && body.children.length === 0) {
      var tr = document.createElement('tr');
      tr.className = 'ldf-selfempty';
      tr.innerHTML = '<td colspan="5" style="padding:24px;text-align:center;color:var(--primary-medium,#888)">本页 ' + pendingSelfEmpty + ' 条主题全部被过滤。<a href="#" class="ldf-open-filtered" style="margin-left:8px">查看已过滤</a></td>';
      body.appendChild(tr);
      var a = tr.querySelector('.ldf-open-filtered');
      if (a) a.addEventListener('click', function (e) { e.preventDefault(); openDrawer(); });
      pendingSelfEmpty = 0;
    }
  }

  // ───────────────────────── UI：顶栏「已过滤」按钮 + 右侧抽屉 ─────────────────────────
  var ui = { topBtn: null, drawer: null };

  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function escAttr(s) { return escHtml(s); }

  // 顶栏按钮（MO 自愈）
  function ensureTopBtn() {
    var cont = document.querySelector('.header-buttons, .d-header .icons, ul.d-header-icons');
    if (!cont) return;
    if (ui.topBtn && ui.topBtn.parentNode === cont) { updateCount(); return; }
    if (document.querySelector('#ldf-topbtn')) { ui.topBtn = document.querySelector('#ldf-topbtn'); updateCount(); return; }
    var btn = document.createElement('button');
    btn.id = 'ldf-topbtn';
    btn.className = 'btn btn-default';
    btn.style.cssText = 'margin-left:6px;cursor:pointer;font-size:13px;white-space:nowrap';
    btn.innerHTML = '<span class="ldf-count">已过滤 (0)</span>';
    btn.addEventListener('click', function () { toggleDrawer(); });
    cont.appendChild(btn);
    ui.topBtn = btn;
    updateCount();
  }

  // 抽屉
  function buildDrawer() {
    if (ui.drawer) return ui.drawer;
    var el = document.createElement('div');
    el.id = 'ldf-drawer';
    el.style.display = 'none';
    el.innerHTML =
      '<div class="ldf-drawer-overlay"></div>'
      + '<div class="ldf-drawer-panel">'
      + '<div class="ldf-drawer-header">'
      + '<span class="ldf-drawer-title">已过滤 <b class="ldf-drawer-count">0</b></span>'
      + '<button class="ldf-drawer-close">×</button>'
      + '</div>'
      + '<div class="ldf-drawer-body"></div>'
      + '</div>';
    document.body.appendChild(el);
    ui.drawer = el;
    el.querySelector('.ldf-drawer-overlay').addEventListener('click', closeDrawer);
    el.querySelector('.ldf-drawer-close').addEventListener('click', closeDrawer);
    return el;
  }

  var savedBodyOverflow = null;
  function openDrawer() {
    buildDrawer();
    renderDrawer();
    ui.drawer.style.display = 'block';
    if (savedBodyOverflow === null) savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { ui.drawer.classList.add('ldf-drawer-open'); });
  }
  function closeDrawer() {
    if (!ui.drawer) return;
    ui.drawer.classList.remove('ldf-drawer-open');
    if (savedBodyOverflow !== null) { document.body.style.overflow = savedBodyOverflow; savedBodyOverflow = null; }
    setTimeout(function () { if (ui.drawer && !ui.drawer.classList.contains('ldf-drawer-open')) ui.drawer.style.display = 'none'; }, 220);
  }
  function toggleDrawer() {
    buildDrawer();
    if (ui.drawer.classList.contains('ldf-drawer-open')) closeDrawer();
    else openDrawer();
  }

  function renderDrawer() {
    if (!ui.drawer) return;
    var body = ui.drawer.querySelector('.ldf-drawer-body');
    var countEl = ui.drawer.querySelector('.ldf-drawer-count');
    var order = currentBucketOrder();
    var map = currentBucketMap();
    countEl.textContent = order.length;
    if (!order.length) {
      body.innerHTML = '<div class="ldf-drawer-empty">当前页面暂无被过滤的主题。</div>';
      return;
    }
    var html = '';
    order.forEach(function (id) {
      var t = map.get(id);
      if (t) html += renderDrawerItem(t);
    });
    body.innerHTML = html;
  }

  function renderDrawerItem(t) {
    var cat = state.catMap && state.catMap.id2.get(t.category_id);
    var catName = cat ? cat.name : ('#' + t.category_id);
    var catHref = cat ? ('/c/' + (cat.slug || ('category/' + t.category_id)) + '/' + t.category_id) : '#';
    var tags = (t.tags || []).map(function (x) {
      return '<a class="discourse-tag ldf-tag" href="/tag/' + encodeURIComponent(x.slug || x.name) + '">' + escHtml(x.name) + '</a>';
    }).join(' ');
    var replies = (t.posts_count ? t.posts_count - 1 : 0);
    if (replies < 0) replies = 0;
    var views = t.views || 0;
    return '<div class="ldf-item">'
      + '<a class="ldf-item-title" href="/t/topic/' + t.id + '/1">' + escHtml(t.title) + '</a>'
      + '<div class="ldf-item-meta">'
      + '<a class="ldf-item-cat" href="' + catHref + '">' + escHtml(catName) + '</a>'
      + (tags ? ' · <span class="ldf-item-tags">' + tags + '</span>' : '')
      + '</div>'
      + '<div class="ldf-item-stats">回复 ' + replies + ' · 浏览 ' + views + '</div>'
      + '</div>';
  }

  function updateCount() {
    var n = bucketCount();
    if (ui.topBtn) {
      var span = ui.topBtn.querySelector('.ldf-count');
      if (span) span.textContent = '已过滤 (' + n + ')';
    }
    if (ui.drawer) {
      var c = ui.drawer.querySelector('.ldf-drawer-count');
      if (c) c.textContent = n;
    }
  }

  // ───────────────────────── UI：编辑 modal + 顶栏齿轮 + GM 菜单 ─────────────────────────
  var modal = null;

  function escDsl(s) { return escHtml(s); }

  function buildModal() {
    if (modal) return modal;
    var el = document.createElement('div');
    el.id = 'ldf-modal';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:none;align-items:flex-start;justify-content:center;padding:60px 16px 16px';
    el.innerHTML =
      '<div style="background:var(--secondary,#fff);color:var(--primary,#222);width:760px;max-width:100%;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden;font-family:inherit">'
      + '<div style="padding:14px 18px;border-bottom:1px solid var(--primary-low,#ddd);display:flex;align-items:center;justify-content:space-between">'
      + '<b>LinuxDo 主题过滤器</b>'
      + '</div>'
      + '<div id="ldf-rules" style="padding:14px 18px;max-height:60vh;overflow:auto"></div>'
      + '<div style="padding:12px 18px;border-top:1px solid var(--primary-low,#ddd);display:flex;justify-content:space-between">'
      + '<button id="ldf-add" class="btn btn-default">+ 新建规则</button>'
      + '<div><button id="ldf-cancel" class="btn btn-default">取消</button> &nbsp; <button id="ldf-save" class="btn btn-primary">保存</button></div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(el);
    modal = el;
    el.querySelector('#ldf-cancel').addEventListener('click', function () { modal.style.display = 'none'; });
    el.querySelector('#ldf-save').addEventListener('click', saveFromModal);
    el.querySelector('#ldf-add').addEventListener('click', function () { addRuleRow({ name: '', enabled: true, expr: '', error: null }); });
    return modal;
  }

  function addRuleRow(r) {
    var box = modal.querySelector('#ldf-rules');
    var row = document.createElement('div');
    row.className = 'ldf-rule-row';
    row.style.cssText = 'padding:10px 0;border-bottom:1px dashed var(--primary-low,#eee)';
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
      + '<input type="checkbox" class="ldf-en"' + (r.enabled ? ' checked' : '') + '>'
      + '<input type="text" class="ldf-name" placeholder="规则名" value="' + escAttr(r.name || '') + '" style="flex:0 0 160px">'
      + '<span class="ldf-status" style="font-size:12px;color:var(--primary-medium,#888)"></span>'
      + '<button class="ldf-del btn btn-danger-text" style="margin-left:auto">删</button>'
      + '</div>'
      + '<textarea class="ldf-expr" placeholder="例如：category(搞七捻三,0,1,2,3) AND (tag(纯水) OR tag(病友))" '
      + 'style="width:100%;min-height:54px;font-family:monospace;font-size:13px;box-sizing:border-box">' + escDsl(r.expr || '') + '</textarea>';
    var status = row.querySelector('.ldf-status');
    var ta = row.querySelector('.ldf-expr');
    var timer = null;
    function validate() {
      var v = ta.value.trim();
      if (!v) { status.textContent = '空'; status.style.color = 'var(--primary-medium,#888)'; return; }
      try { parseDSL(v); status.textContent = '✓ 语法正确'; status.style.color = '#2a9d4a'; }
      catch (e) { status.textContent = '✗ ' + e.message; status.style.color = '#d12c25'; }
    }
    ta.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(validate, 300); });
    row.querySelector('.ldf-del').addEventListener('click', function () { row.remove(); });
    box.appendChild(row);
    validate();
  }

  function openModal() {
    buildModal();
    var box = modal.querySelector('#ldf-rules'); box.innerHTML = '';
    state.rulesMeta.slice().forEach(addRuleRow);
    if (!state.rulesMeta.length) addRuleRow({ name: '', enabled: true, expr: '', error: null });
    modal.style.display = 'flex';
  }

  function saveFromModal() {
    var rows = modal.querySelectorAll('.ldf-rule-row');
    var next = [];
    rows.forEach(function (row) {
      var name = (row.querySelector('.ldf-name').value || '').trim();
      var expr = (row.querySelector('.ldf-expr').value || '').trim();
      var enabled = row.querySelector('.ldf-en').checked;
      if (!name && !expr) return;
      if (!name) name = '规则' + (next.length + 1);
      next.push({ name: name, enabled: enabled, expr: expr });
    });
    gmSet(RULES_KEY, next);
    modal.style.display = 'none';
    location.reload();
  }

  // 设置入口仅保留 GM 菜单

  // ───────────────────────── UI 启动 + 统一 MO 自愈 ─────────────────────────
  function bootUI() {
    var css = document.createElement('style');
    css.textContent = [
      '.ldf-selfempty a{cursor:pointer}',
      '#ldf-topbtn .ldf-count{font-weight:600}',
      '#ldf-drawer{position:fixed;inset:0;z-index:100001;pointer-events:none;contain:layout style}',
      '#ldf-drawer .ldf-drawer-overlay{position:absolute;inset:0;background:rgba(0,0,0,0);transition:background .2s;pointer-events:auto}',
      '#ldf-drawer .ldf-drawer-panel{position:absolute;top:0;right:0;height:100vh;width:440px;max-width:90vw;background:var(--secondary,#fff);color:var(--primary,#222);box-shadow:-4px 0 24px rgba(0,0,0,.2);transform:translateX(100%);transition:transform .2s;display:flex;flex-direction:column;overflow:hidden}',
      '#ldf-drawer.ldf-drawer-open{pointer-events:auto}',
      '#ldf-drawer.ldf-drawer-open .ldf-drawer-overlay{background:rgba(0,0,0,.35)}',
      '#ldf-drawer.ldf-drawer-open .ldf-drawer-panel{transform:translateX(0)}',
      '.ldf-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--primary-low,#ddd);flex-shrink:0}',
      '.ldf-drawer-title{font-size:15px}.ldf-drawer-count{color:var(--primary-medium,#888)}',
      '.ldf-drawer-close{background:none;border:none;font-size:22px;cursor:pointer;color:var(--primary-medium,#888);padding:0 4px;line-height:1}',
      '.ldf-drawer-body{flex:1;overflow-y:auto;padding:8px 0}',
      '.ldf-drawer-empty{padding:40px 18px;text-align:center;color:var(--primary-medium,#888)}',
      '.ldf-item{padding:12px 18px;border-bottom:1px solid var(--primary-low,#eee)}',
      '.ldf-item-title{display:block;font-size:14px;color:var(--primary,#222);text-decoration:none;margin-bottom:4px}',
      '.ldf-item-title:hover{text-decoration:underline}',
      '.ldf-item-meta{font-size:12px;color:var(--primary-medium,#888);margin-bottom:2px}',
      '.ldf-item-cat{color:var(--tertiary,#08c);text-decoration:none}',
      '.ldf-tag{margin-right:4px}',
      '.ldf-item-stats{font-size:11px;color:var(--primary-low-mid,#aaa)}'
    ].join('\n');
    document.head.appendChild(css);

    syncCurrentRoute();
    ensureTopBtn();

    // MO 防递归：DOM 写入会触发 MO，MO 又写入 → 死循环。
    // 用 rAF 防抖 + 忽略 ldf-* 节点的变更。
    var mo = null;
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        if (!mo) return;
        var prev = state.currentRoute;
        syncCurrentRoute();
        ensureTopBtn();
        tryRenderSelfEmpty();
        if (state.currentRoute !== prev) {
          updateCount();
          if (ui.drawer && ui.drawer.classList.contains('ldf-drawer-open')) renderDrawer();
        }
      });
    }
    try {
      mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.id && String(n.id).indexOf('ldf-') === 0) continue;
            if (n.classList && (n.classList.contains('ldf-selfempty') || n.classList.contains('ldf-item'))) continue;
            schedule();
            return;
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { err('UI MO 安装失败', e); }

    try {
      GM_registerMenuCommand('LinuxDo 过滤器 · 设置', openModal);
    } catch (e) {}
  }

  // 暴露调试入口
  try { window.__LDF = { state: state, parseDSL: parseDSL, reloadRules: reloadRules }; } catch (e) {}

})();
