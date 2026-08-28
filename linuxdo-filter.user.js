// ==UserScript==
// @name         LinuxDo 主题过滤器
// @namespace    https://linux.do/
// @version      0.2.0
// @description  按 类别/标签/标题正则 过滤 linux.do 主题帖，支持作用域(全局/首页/类别页)、草稿、匹配预览、导入导出。DSL 支持 AND/OR/NOT。
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
  var BUCKET_MAX = 1000;
  var RULES_KEY = 'ldf_rules_v2';        // [{name, status:'active'|'draft', expr, scope:{type,...}}]
  var HOME_ROUTES = ['latest', 'new', 'unseen', 'hot', 'top', 'read'];

  // ───────────────────────── 状态 ─────────────────────────
  var state = {
    catMap: null,
    catMapPromise: null,
    buckets: {},           // pageKey -> { map:Map(id->topic), order:[id] }
    rules: [],             // 全部规则原始对象（落库形态）
    predicates: [],        // [{name, fn, scope}] 已编译且 active 的谓词
    currentPage: null,     // { kind:'home'|'category'|'other', route?, categoryId?, key }
  };

  // ───────────────────────── 小工具 ─────────────────────────
  function log() { try { console.log.apply(console, ['%c[LDF]', 'color:#3aa'].concat([].slice.call(arguments))); } catch (e) {} }
  function err() { try { console.error.apply(console, ['%c[LDF]', 'color:#e55'].concat([].slice.call(arguments))); } catch (e) {} }
  function gmGet(key, def) { try { var v = GM_getValue(key, def); return (v === undefined || v === null) ? def : v; } catch (e) { return def; } }
  function gmSet(key, val) { try { GM_setValue(key, val); } catch (e) {} }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function escAttr(s) { return escHtml(s); }

  // ───────────────────────── 类别映射 ─────────────────────────
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
  function collectDescendants(pid, ids) {
    ids.add(pid);
    state.catMap.id2.forEach(function (c) { if (c.parentId === pid) collectDescendants(c.id, ids); });
  }
  function findChildByLv(pid, lv) {
    var suf = ', Lv' + lv;
    var hit = null;
    state.catMap.id2.forEach(function (c) { if (c.parentId === pid && (c.name || '').endsWith(suf)) hit = c.id; });
    return hit;
  }
  // 解析 category 原子 → 匹配的 id 集合
  function resolveCategoryIds(name, levels) {
    if (!state.catMap) throw new Error('类别映射未就绪');
    var cands = state.catMap.byName.get(name);
    if (!cands || !cands.length) throw new Error('类别名未找到：' + name);
    var parent = cands.filter(function (c) { return c.parentId === null; })[0] || cands[0];
    var ids = new Set();
    if (!levels || !levels.length) collectDescendants(parent.id, ids);
    else {
      levels.forEach(function (lv) {
        if (lv === 0) { ids.add(parent.id); return; }
        var child = findChildByLv(parent.id, lv);
        if (child == null) throw new Error('类别「' + name + '」不存在 Lv' + lv);
        ids.add(child);
      });
    }
    return ids;
  }
  // 展开一组 categoryId（含子孙）→ Set
  function expandCategoryIdsWithDescendants(categoryIds) {
    var out = new Set();
    (categoryIds || []).forEach(function (cid) { collectDescendants(cid, out); });
    return out;
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
      if (c === '"') {
        var j = i + 1, buf = '';
        while (j < n && src[j] !== '"') { if (src[j] === '\\' && j + 1 < n) { buf += src[j + 1]; j += 2; } else { buf += src[j]; j++; } }
        if (j >= n) throw new Error('字符串未闭合');
        tokens.push({ t: 'str', v: buf }); i = j + 1; continue;
      }
      if (c === '/') {
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
      }
      var w = '';
      while (i < n && !isWs(src[i]) && src[i] !== '(' && src[i] !== ')' && src[i] !== ',' && src[i] !== '"' && src[i] !== '/') { w += src[i]; i++; }
      if (w.length) {
        var up = w.toUpperCase();
        if (up === 'AND' || up === 'OR' || up === 'NOT') tokens.push({ t: up });
        else if (w.toLowerCase() === 'category' || w.toLowerCase() === 'tag' || w.toLowerCase() === 'title') tokens.push({ t: 'atom', v: w.toLowerCase() });
        else tokens.push({ t: 'word', v: w });
        continue;
      }
      i++;
    }
    return tokens;
  }

  // ───────────────────────── DSL：语法（递归下降） ─────────────────────────
  function Parser(tokens) { this.toks = tokens; this.i = 0; }
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
    if (tk.t === '(') { this.next(); var inner = this.parseOr(); this.expect(')'); return inner; }
    if (tk.t === 'atom') {
      this.next(); this.expect('(');
      if (tk.v === 'category') return this.parseCategoryArgs();
      if (tk.v === 'tag') return this.parseTagArgs();
      if (tk.v === 'title') return this.parseTitleArg();
      throw new Error('未知原子：' + tk.v);
    }
    throw new Error('意外的 token：' + tk.t);
  };
  Parser.prototype.parseNameList = function () {
    var names = [];
    if (this.peek() && this.peek().t === ')') return names;
    while (true) {
      var tk = this.next();
      if (!tk) throw new Error('参数中遇到 EOF');
      if (tk.t === 'str' || tk.t === 'word') names.push(tk.v);
      else if (tk.t === 'regex') throw new Error('此处不应为正则');
      else throw new Error('参数中意外的 token：' + tk.t);
      if (this.peek() && this.peek().t === ',') { this.next(); continue; }
      break;
    }
    return names;
  };
  Parser.prototype.parseCategoryArgs = function () {
    var names = this.parseNameList(); this.expect(')');
    if (!names.length) throw new Error('category() 缺少类别名');
    var name = names[0];
    var levels = names.slice(1).map(function (s) {
      if (!/^-?\d+$/.test(s)) throw new Error('category 级别应为整数，实际：' + s);
      return parseInt(s, 10);
    });
    return { op: 'category', name: name, levels: levels };
  };
  Parser.prototype.parseTagArgs = function () {
    var names = this.parseNameList(); this.expect(')');
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
        var re = ('regex' in node) ? new RegExp(node.regex, node.flags || '') : new RegExp(escapeRe(node.literal || ''), 'i');
        return function (t) { return re.test(t.title || t.fancy_title || ''); };
      }
      default: throw new Error('未知节点 op：' + node.op);
    }
  }

  // ───────────────────────── 页面上下文（路由判定） ─────────────────────────
  // 从 URL 提取页面上下文：home / category / other
  // key 用于桶分段，类别页 key 含 filter 以隔离不同 tab（避免切 tab 越累积越多）
  function pageContext(u) {
    try {
      var url = new URL(u, location.href);
      // ?category=ID → 类别页作用域（filter 取 ?order 或默认 latest）
      var catParam = /[?&]category=(\d+)/i.exec(url.search);
      if (catParam) {
        var cid1 = parseInt(catParam[1], 10);
        var f1 = (/[\?&]order=([a-z]+)/i.exec(url.search) || [])[1] || 'latest';
        return { kind: 'category', categoryId: cid1, filter: f1.toLowerCase(), key: 'cat:' + cid1 + ':' + f1.toLowerCase() };
      }
      var hm = new RegExp('^/(' + HOME_ROUTES.join('|') + ')(\\.json)?(/.*)?$', 'i').exec(url.pathname);
      if (hm) return { kind: 'home', route: hm[1].toLowerCase(), key: 'home:' + hm[1].toLowerCase() };
      // /c/{slug}/{id} 或 /c/{slug}/{sub}/{id}，可能有 /l/{filter}
      var cm = /^\/c\/[^/]+(?:\/[^/]+)?\/(\d+)(?:\/l\/([a-z]+))?/i.exec(url.pathname);
      if (cm) {
        var cid2 = parseInt(cm[1], 10);
        var f2 = (cm[2] || 'latest').toLowerCase();
        return { kind: 'category', categoryId: cid2, filter: f2, key: 'cat:' + cid2 + ':' + f2 };
      }
      return { kind: 'other', key: 'other' };
    } catch (e) { return { kind: 'other', key: 'other' }; }
  }
  function isFilterablePage(pg) { return pg && (pg.kind === 'home' || pg.kind === 'category'); }

  // 规则作用域是否命中页面
  function ruleAppliesToPage(rule, pg) {
    if (!rule.scope) return true; // 无 scope 视为 global（兼容）
    if (pg.kind === 'other') return false;
    if (rule.scope.type === 'global') return true;
    if (rule.scope.type === 'home') return pg.kind === 'home';
    if (rule.scope.type === 'category') {
      if (rule.scope.includeHome && pg.kind === 'home') return true;
      if (pg.kind === 'category') {
        var expanded = expandCategoryIdsWithDescendants(rule.scope.categoryIds || []);
        return expanded.has(pg.categoryId);
      }
      return false;
    }
    return false;
  }

  // 当前页是否存在任一启用规则命中 → 决定是否拦截
  function pageHasActiveRule(pg) {
    for (var i = 0; i < state.predicates.length; i++) {
      if (ruleAppliesToPage(state.predicates[i], pg)) return true;
    }
    return false;
  }

  // ───────────────────────── 规则引擎 ─────────────────────────
  function reloadRules() {
    var raw = gmGet(RULES_KEY, []);
    if (!Array.isArray(raw)) raw = [];
    state.rules = raw;
    state.predicates = [];
    raw.forEach(function (r) {
      if (r.status !== 'active') return;
      try {
        var ast = parseDSL(r.expr || '');
        if (!state.catMap) ensureCatMapFallback();
        var fn = compile(ast);
        state.predicates.push({ name: r.name, fn: fn, scope: r.scope || { type: 'global' } });
      } catch (e) { /* 编译错误静默，编辑器会显示 */ }
    });
    log('规则编译完成：active 谓词', state.predicates.length, '条，规则总数', raw.length);
  }

  function isFiltered(topic, pg) {
    if (!state.predicates.length) return false;
    for (var i = 0; i < state.predicates.length; i++) {
      if (!ruleAppliesToPage(state.predicates[i], pg)) continue;
      try { if (state.predicates[i].fn(topic)) return true; } catch (e) {}
    }
    return false;
  }

  // ───────────────────────── 已过滤桶（按 pageKey 分段） ─────────────────────────
  function pageBucket(key) {
    if (!state.buckets[key]) state.buckets[key] = { map: new Map(), order: [] };
    return state.buckets[key];
  }
  function bucketAdd(key, topic) {
    if (!topic || topic.id == null) return false;
    var b = pageBucket(key);
    if (b.map.has(topic.id)) return false;
    b.map.set(topic.id, topic);
    b.order.push(topic.id);
    while (b.order.length > BUCKET_MAX) { var old = b.order.shift(); b.map.delete(old); }
    return true;
  }
  function bucketAddMany(key, topics) {
    var added = 0;
    (topics || []).forEach(function (t) { if (bucketAdd(key, t)) added++; });
    if (added && state.currentPage && key === state.currentPage.key) updateCount();
    return added;
  }
  function bucketCount() {
    if (!state.currentPage) return 0;
    var b = state.buckets[state.currentPage.key];
    return b ? b.order.length : 0;
  }
  function currentBucketOrder() {
    if (!state.currentPage) return [];
    var b = state.buckets[state.currentPage.key];
    return b ? b.order : [];
  }
  function currentBucketMap() {
    if (!state.currentPage) return new Map();
    var b = state.buckets[state.currentPage.key];
    return b ? b.map : new Map();
  }

  // ───────────────────────── 核心：切分 kept/filtered ─────────────────────────
  function splitTopics(topics, pg) {
    var kept = [], filtered = [];
    (topics || []).forEach(function (t) { if (isFiltered(t, pg)) filtered.push(t); else kept.push(t); });
    return { kept: kept, filtered: filtered };
  }
  function processTopicList(pg, obj) {
    if (!obj || !obj.topic_list || !Array.isArray(obj.topic_list.topics)) return null;
    var sp = splitTopics(obj.topic_list.topics, pg);
    if (sp.filtered.length) bucketAddMany(pg.key, sp.filtered);
    obj.topic_list.topics = sp.kept;
    return sp;
  }

  // ───────────────────────── 拦截判定 ─────────────────────────
  function shouldIntercept(url) {
    var pg = pageContext(url);
    if (!isFilterablePage(pg)) return null;
    if (!pageHasActiveRule(pg)) return null;
    return pg;
  }
  function bodyLooksLikeTopicList(text) {
    return !!text && text.indexOf('"topic_list"') !== -1 && text.indexOf('"topics"') !== -1;
  }
  function syncCurrentPage() {
    state.currentPage = pageContext(location.href);
  }

  // ───────────────────────── fetch hook ─────────────────────────
  var _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
      var pg = shouldIntercept(url);
      if (!pg) return _fetch.apply(this, arguments);
      return _fetch.apply(this, arguments).then(function (resp) {
        var ct = resp.headers.get('content-type') || '';
        if (ct.indexOf('json') === -1) return resp;
        return resp.clone().text().then(function (text) {
          if (!bodyLooksLikeTopicList(text)) return resp;
          try {
            var obj = JSON.parse(text);
            var sp = processTopicList(pg, obj);
            if (!sp) return resp;
            var rewriter = new Response(JSON.stringify(obj), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
            if (state.currentPage && pg.key === state.currentPage.key) selfEmptyGuard(sp);
            return rewriter;
          } catch (e) { err('fetch 过滤失败', e); return resp; }
        });
      });
    };
  }

  // ───────────────────────── XHR hook ─────────────────────────
  try {
    if (typeof XMLHttpRequest === 'undefined') throw new Error('环境无 XMLHttpRequest');
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    var descText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    var descResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    XMLHttpRequest.prototype.open = function (method, url) { this.__ldf_url = url; this.__ldf_done = false; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var pg = shouldIntercept(xhr.__ldf_url || '');
      if (pg && descText) {
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
                  var sp = processTopicList(pg, obj);
                  if (!sp) { xhr.__ldf_cached = orig; return orig; }
                  xhr.__ldf_cached = JSON.stringify(obj);
                  if (state.currentPage && pg.key === state.currentPage.key) selfEmptyGuard(sp);
                  return xhr.__ldf_cached;
                } catch (e) { err('XHR 过滤失败', e); xhr.__ldf_cached = orig; return orig; }
              }
            });
            if (descResp) Object.defineProperty(xhr, 'response', {
              get: function () { if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText; return descResp.get.call(xhr); }
            });
          } catch (e) {}
        };
        xhr.addEventListener('readystatechange', function () { if (xhr.readyState === 4) install(); });
      }
      return _send.apply(this, arguments);
    };
  } catch (e) { err('XHR hook 安装失败', e); }

  // ───────────────────────── 预载块拦截 ─────────────────────────
  var preloadedRewritten = false;
  function rewritePreloaded(script) {
    if (!script || preloadedRewritten) return;
    var text = script.textContent;
    if (!text || text.indexOf('"topic_list"') === -1) return;
    try {
      var outer = JSON.parse(text);
      if (outer.site && typeof outer.site === 'string') { try { ensureCatMapFromSite(JSON.parse(outer.site)); } catch (e) {} }
      else if (outer.site && typeof outer.site === 'object') { ensureCatMapFromSite(outer.site); }
      reloadRules();
      var firstPg = pageContext(location.href);
      state.currentPage = firstPg;
      if (isFilterablePage(firstPg) && pageHasActiveRule(firstPg)) {
        if (outer.topic_list && typeof outer.topic_list === 'string') {
          var tl = JSON.parse(outer.topic_list);
          var sp = processTopicList(firstPg, tl);
          if (sp) { outer.topic_list = JSON.stringify(tl); selfEmptyGuard(sp); }
        }
      }
      script.textContent = JSON.stringify(outer);
      preloadedRewritten = true;
      log('预载块已改写，首屏页面：', firstPg.kind, firstPg.key);
    } catch (e) { err('预载块改写失败', e); }
  }

  var preObs = null;
  try {
    preObs = new MutationObserver(function (mutations) {
      if (preloadedRewritten) { if (preObs) preObs.disconnect(); return; }
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.id === 'data-preloaded' && node.tagName === 'SCRIPT') { rewritePreloaded(node); }
          else if (node.querySelectorAll) { var s = node.querySelector('script#data-preloaded'); if (s) rewritePreloaded(s); }
        }
      }
      if (preloadedRewritten && preObs) preObs.disconnect();
    });
    preObs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { err('预载 MO 安装失败', e); }

  document.addEventListener('DOMContentLoaded', function () {
    if (!preloadedRewritten) { var s = document.querySelector('script#data-preloaded'); if (s) rewritePreloaded(s); }
    if (!state.catMap) ensureCatMapFallback().then(reloadRules);
    syncCurrentPage();
    bootUI();
  });

  // ───────────────────────── 自空护栏 ─────────────────────────
  var pendingSelfEmpty = 0;
  function selfEmptyGuard(sp) {
    if (sp.kept.length === 0 && sp.filtered.length > 0) pendingSelfEmpty = sp.filtered.length;
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

  // ───────────────────────── UI：顶栏按钮 + 抽屉 ─────────────────────────
  var ui = { topBtn: null, drawer: null };

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

  function buildDrawer() {
    if (ui.drawer) return ui.drawer;
    var el = document.createElement('div');
    el.id = 'ldf-drawer';
    el.style.display = 'none';
    el.innerHTML = '<div class="ldf-drawer-overlay"></div><div class="ldf-drawer-panel"><div class="ldf-drawer-header"><span class="ldf-drawer-title">已过滤 <b class="ldf-drawer-count">0</b></span><button class="ldf-drawer-close">×</button></div><div class="ldf-drawer-body"></div></div>';
    document.body.appendChild(el);
    ui.drawer = el;
    el.querySelector('.ldf-drawer-overlay').addEventListener('click', closeDrawer);
    el.querySelector('.ldf-drawer-close').addEventListener('click', closeDrawer);
    return el;
  }
  var savedBodyOverflow = null;
  function openDrawer() {
    buildDrawer(); renderDrawer();
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
  function toggleDrawer() { buildDrawer(); if (ui.drawer.classList.contains('ldf-drawer-open')) closeDrawer(); else openDrawer(); }

  function renderDrawer() {
    if (!ui.drawer) return;
    var body = ui.drawer.querySelector('.ldf-drawer-body');
    var countEl = ui.drawer.querySelector('.ldf-drawer-count');
    var order = currentBucketOrder();
    var map = currentBucketMap();
    countEl.textContent = order.length;
    if (!order.length) { body.innerHTML = '<div class="ldf-drawer-empty">当前页面暂无被过滤的主题。</div>'; return; }
    var html = '';
    order.forEach(function (id) { var t = map.get(id); if (t) html += renderDrawerItem(t); });
    body.innerHTML = html;
  }
  function renderDrawerItem(t) {
    var cat = state.catMap && state.catMap.id2.get(t.category_id);
    var catName = cat ? cat.name : ('#' + t.category_id);
    var catHref = cat ? ('/c/' + (cat.slug || ('category/' + t.category_id)) + '/' + t.category_id) : '#';
    var tags = (t.tags || []).map(function (x) { return '<a class="discourse-tag ldf-tag" href="/tag/' + encodeURIComponent(x.slug || x.name) + '">' + escHtml(x.name) + '</a>'; }).join(' ');
    var replies = Math.max(0, (t.posts_count ? t.posts_count - 1 : 0));
    return '<div class="ldf-item"><a class="ldf-item-title" href="/t/topic/' + t.id + '/1">' + escHtml(t.title) + '</a><div class="ldf-item-meta"><a class="ldf-item-cat" href="' + catHref + '">' + escHtml(catName) + '</a>' + (tags ? ' · <span class="ldf-item-tags">' + tags + '</span>' : '') + '</div><div class="ldf-item-stats">回复 ' + replies + ' · 浏览 ' + (t.views || 0) + '</div></div>';
  }
  function updateCount() {
    var n = bucketCount();
    if (ui.topBtn) { var span = ui.topBtn.querySelector('.ldf-count'); if (span) span.textContent = '已过滤 (' + n + ')'; }
    if (ui.drawer) { var c = ui.drawer.querySelector('.ldf-drawer-count'); if (c) c.textContent = n; }
  }

  // ───────────────────────── UI：设置弹窗（列表 + 编辑两视图） ─────────────────────────
  var modal = null;
  var editView = null; // 'list' | 'edit'
  var editingRule = null; // 当前编辑的规则对象（null=新建）

  function scopeSummary(scope) {
    if (!scope || scope.type === 'global') return '全局';
    if (scope.type === 'home') return '首页流';
    if (scope.type === 'category') {
      var names = (scope.categoryIds || []).map(function (cid) {
        var c = state.catMap && state.catMap.id2.get(cid);
        return c ? c.name : '#' + cid;
      });
      var s = names.length ? names.join(', ') : '（未选）';
      if (scope.includeHome) s += ' + 首页';
      return s;
    }
    return '?';
  }

  function buildModal() {
    if (modal) return modal;
    var el = document.createElement('div');
    el.id = 'ldf-modal';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:none;align-items:flex-start;justify-content:center;padding:40px 16px 16px';
    el.innerHTML =
      '<div class="ldf-modal-box">'
      + '<div id="ldf-view-list" class="ldf-view" style="display:none"></div>'
      + '<div id="ldf-view-edit" class="ldf-view" style="display:none"></div>'
      + '</div>';
    document.body.appendChild(el);
    modal = el;
    modal.querySelector('#ldf-view-list');
    modal.querySelector('#ldf-view-edit');
    return modal;
  }

  // ── 列表视图 ──
  function renderListView() {
    editView = 'list';
    modal.querySelector('#ldf-view-list').style.display = 'flex';
    modal.querySelector('#ldf-view-edit').style.display = 'none';
    var box = modal.querySelector('#ldf-view-list');
    var rules = state.rules.slice();
    var rowsHtml = '';
    if (!rules.length) {
      rowsHtml = '<div class="ldf-empty">暂无规则，点击「新建规则」开始。</div>';
    } else {
      rules.forEach(function (r, idx) {
        var statusTag = r.status === 'draft' ? '<span class="ldf-tag-draft">草稿</span>' : '';
        var activeCls = r.status === 'active' ? 'ldf-active' : 'ldf-draft';
        rowsHtml +=
          '<div class="ldf-rule-row ' + activeCls + '" data-idx="' + idx + '">'
          + '<label class="ldf-switch"><input type="checkbox" class="ldf-toggle"' + (r.status === 'active' ? ' checked' : '') + '><span class="ldf-slider"></span></label>'
          + '<div class="ldf-rule-info">'
          + '<div class="ldf-rule-name">' + escHtml(r.name || '(未命名)') + ' ' + statusTag + '</div>'
          + '<div class="ldf-rule-meta"><span class="ldf-rule-scope">' + escHtml(scopeSummary(r.scope)) + '</span> · <code class="ldf-rule-expr">' + escHtml((r.expr || '').slice(0, 60)) + (r.expr && r.expr.length > 60 ? '…' : '') + '</code></div>'
          + '</div>'
          + '<div class="ldf-rule-actions">'
          + '<button class="ldf-btn-edit" data-idx="' + idx + '">编辑</button>'
          + '<button class="ldf-btn-del" data-idx="' + idx + '">删</button>'
          + '</div>'
          + '</div>';
      });
    }
    box.innerHTML =
      '<div class="ldf-modal-header"><b>LinuxDo 主题过滤器</b><span class="ldf-close-icon" data-act="close" title="关闭">✕</span></div>'
      + '<div class="ldf-list-toolbar">'
      + '<button id="ldf-add" class="btn btn-primary">+ 新建规则</button>'
      + '<button id="ldf-export" class="btn btn-default">导出</button>'
      + '<button id="ldf-import" class="btn btn-default">导入</button>'
      + '<input type="file" id="ldf-import-file" accept=".json,application/json" style="display:none">'
      + '</div>'
      + '<div class="ldf-list-body">' + rowsHtml + '</div>'
      + '<div class="ldf-modal-footer"><span class="ldf-footer-hint">保存后点击「应用」刷新生效</span><button id="ldf-apply" class="btn btn-primary">应用</button></div>';

    box.querySelector('.ldf-close-icon[data-act="close"]').addEventListener('click', function () { modal.style.display = 'none'; });
    box.querySelector('#ldf-add').addEventListener('click', function () { openEditView(null); });
    box.querySelector('#ldf-export').addEventListener('click', exportRules);
    box.querySelector('#ldf-import').addEventListener('click', function () { box.querySelector('#ldf-import-file').click(); });
    box.querySelector('#ldf-import-file').addEventListener('change', importRules);
    box.querySelector('#ldf-apply').addEventListener('click', function () { modal.style.display = 'none'; location.reload(); });
    box.querySelectorAll('.ldf-btn-edit').forEach(function (b) { b.addEventListener('click', function () { openEditView(parseInt(b.dataset.idx, 10)); }); });
    box.querySelectorAll('.ldf-btn-del').forEach(function (b) { b.addEventListener('click', function () { deleteRule(parseInt(b.dataset.idx, 10)); }); });
    box.querySelectorAll('.ldf-toggle').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var idx = parseInt(cb.closest('.ldf-rule-row').dataset.idx, 10);
        state.rules[idx].status = cb.checked ? 'active' : 'draft';
        persistRules();
        renderListView();
      });
    });
  }

  function deleteRule(idx) {
    if (!confirm('删除规则「' + (state.rules[idx].name || '') + '」？')) return;
    state.rules.splice(idx, 1);
    persistRules();
    renderListView();
  }

  function persistRules() {
    gmSet(RULES_KEY, state.rules);
  }

  // ── 编辑视图 ──
  function openEditView(idx) {
    editView = 'edit';
    editingRule = (idx == null) ? { name: '', status: 'active', expr: '', scope: { type: 'global' } } : JSON.parse(JSON.stringify(state.rules[idx]));
    editingRule._idx = idx;
    var box = modal.querySelector('#ldf-view-edit');
    box.innerHTML = buildEditForm(editingRule);
    bindEditForm(box);
    modal.querySelector('#ldf-view-list').style.display = 'none';
    box.style.display = 'flex';
    runPreview();
  }

  function buildEditForm(r) {
    var catTree = buildCatTreeHtml(r.scope);
    var scopeType = (r.scope && r.scope.type) || 'global';
    var includeHome = (r.scope && r.scope.includeHome) ? 'checked' : '';
    return ''
      + '<div class="ldf-modal-header"><b>' + (r._idx == null ? '新建规则' : '编辑规则') + '</b><span class="ldf-close-icon" data-act="back" title="返回列表">✕</span></div>'
      + '<div class="ldf-edit-body">'
      + '<div class="ldf-field"><label>规则名</label><input type="text" id="ldf-name" value="' + escAttr(r.name || '') + '" placeholder="给规则起个名字"></div>'
      + '<div class="ldf-field"><label>作用域</label>'
      + '<div class="ldf-scope-row"><label><input type="radio" name="ldf-scope" value="global"' + (scopeType === 'global' ? ' checked' : '') + '> 全局</label>'
      + '<label><input type="radio" name="ldf-scope" value="home"' + (scopeType === 'home' ? ' checked' : '') + '> 仅首页流</label>'
      + '<label><input type="radio" name="ldf-scope" value="category"' + (scopeType === 'category' ? ' checked' : '') + '> 类别页</label></div>'
      + '<div id="ldf-cat-tree" class="ldf-cat-tree" style="display:' + (scopeType === 'category' ? 'block' : 'none') + '">'
      + '<div class="ldf-cat-hint">勾选父类别自动含子孙（Lv1/2/3…）</div>'
      + catTree
      + '<label class="ldf-include-home"><input type="checkbox" id="ldf-include-home" ' + includeHome + '> 同时作用于首页流</label>'
      + '</div>'
      + '</div>'
      + '<div class="ldf-field"><label>过滤表达式 (DSL)</label>'
      + '<textarea id="ldf-expr" placeholder="例如：category(搞七捻三,0,1,2,3) AND (tag(纯水) OR tag(病友))">' + escHtml(r.expr || '') + '</textarea>'
      + '<span id="ldf-expr-status" class="ldf-expr-status"></span></div>'
      + '<div class="ldf-field"><label>匹配预览</label>'
      + '<div class="ldf-preview">'
      + '<input type="text" id="ldf-pv-title" placeholder="标题">'
      + '<select id="ldf-pv-cat"><option value="">选择类别</option>' + catOptionsHtml() + '</select>'
      + '<input type="text" id="ldf-pv-tags" placeholder="标签（逗号分隔多个）">'
      + '<div id="ldf-pv-result" class="ldf-pv-result"></div>'
      + '</div></div>'
      + '</div>'
      + '<div class="ldf-modal-footer">'
      + '<div></div>'
      + '<div><button id="ldf-draft" class="btn btn-default">存为草稿</button> &nbsp; <button id="ldf-save" class="btn btn-primary">保存</button></div>'
      + '</div>';
  }

  function catOptionsHtml() {
    if (!state.catMap) return '';
    var html = '';
    state.catMap.id2.forEach(function (c) {
      html += '<option value="' + c.id + '">' + escHtml(c.name) + '</option>';
    });
    return html;
  }

  function buildCatTreeHtml(scope) {
    if (!state.catMap) return '<div class="ldf-cat-hint">类别映射未就绪</div>';
    var selected = new Set(scope && scope.categoryIds || []);
    // 仅列父类别（parentId===null）；子类随父自动含
    var roots = [];
    state.catMap.id2.forEach(function (c) { if (c.parentId === null) roots.push(c); });
    roots.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    var html = '<div class="ldf-cat-list">';
    roots.forEach(function (c) {
      var chk = selected.has(c.id) ? 'checked' : '';
      html += '<label class="ldf-cat-item"><input type="checkbox" class="ldf-cat-check" data-cat-id="' + c.id + '" ' + chk + '> ' + escHtml(c.name) + '</label>';
    });
    html += '</div>';
    return html;
  }

  function bindEditForm(box) {
    box.querySelector('.ldf-close-icon[data-act="back"]').addEventListener('click', function () { renderListView(); });
    box.querySelector('#ldf-save').addEventListener('click', function () { saveEditingRule('active'); });
    box.querySelector('#ldf-draft').addEventListener('click', function () { saveEditingRule('draft'); });

    var exprTa = box.querySelector('#ldf-expr');
    var exprStatus = box.querySelector('#ldf-expr-status');
    var timer = null;
    function validateExpr() {
      var v = exprTa.value.trim();
      if (!v) { exprStatus.textContent = '空'; exprStatus.className = 'ldf-expr-status ldf-status-empty'; return; }
      try { parseDSL(v); exprStatus.textContent = '✓ 语法正确'; exprStatus.className = 'ldf-expr-status ldf-status-ok'; }
      catch (e) { exprStatus.textContent = '✗ ' + e.message; exprStatus.className = 'ldf-expr-status ldf-status-err'; }
    }
    exprTa.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { validateExpr(); runPreview(); }, 300); });

    // 作用域 radio
    box.querySelectorAll('input[name="ldf-scope"]').forEach(function (r) {
      r.addEventListener('change', function () {
        box.querySelector('#ldf-cat-tree').style.display = (r.value === 'category' && r.checked) ? 'block' : 'none';
      });
    });

    // 预览输入
    ['ldf-pv-title', 'ldf-pv-cat', 'ldf-pv-tags'].forEach(function (id) {
      var el = box.querySelector('#' + id);
      if (el) el.addEventListener('input', runPreview);
    });

    validateExpr();
  }

  function gatherEditingRule() {
    var box = modal.querySelector('#ldf-view-edit');
    var name = (box.querySelector('#ldf-name').value || '').trim();
    var expr = (box.querySelector('#ldf-expr').value || '').trim();
    var scopeType = box.querySelector('input[name="ldf-scope"]:checked').value;
    var scope;
    if (scopeType === 'global') scope = { type: 'global' };
    else if (scopeType === 'home') scope = { type: 'home' };
    else {
      var catIds = [];
      box.querySelectorAll('.ldf-cat-check:checked').forEach(function (cb) { catIds.push(parseInt(cb.dataset.catId, 10)); });
      var includeHome = box.querySelector('#ldf-include-home').checked;
      scope = { type: 'category', categoryIds: catIds, includeHome: includeHome };
    }
    return { name: name, expr: expr, scope: scope };
  }

  function saveEditingRule(status) {
    var r = gatherEditingRule();
    if (!r.name) r.name = '规则' + (state.rules.length + 1);
    r.status = status;
    if (editingRule._idx == null) state.rules.push(r);
    else state.rules[editingRule._idx] = r;
    persistRules();
    // 保存（active 或 draft）都回到列表，由列表页"应用"按钮触发刷新
    renderListView();
    modal.querySelector('#ldf-view-list').style.display = 'flex';
    modal.querySelector('#ldf-view-edit').style.display = 'none';
  }

  function runPreview() {
    var box = modal.querySelector('#ldf-view-edit');
    if (!box) return;
    var resultEl = box.querySelector('#ldf-pv-result');
    if (!resultEl) return;
    var expr = (box.querySelector('#ldf-expr').value || '').trim();
    var title = (box.querySelector('#ldf-pv-title').value || '').trim();
    var catId = box.querySelector('#ldf-pv-cat').value;
    var tagsStr = (box.querySelector('#ldf-pv-tags').value || '').trim();
    if (!expr) { resultEl.innerHTML = '<span class="ldf-pv-idle">请输入表达式</span>'; return; }
    var tags = tagsStr ? tagsStr.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (n) { return { name: n }; }) : [];
    var mockTopic = { title: title, category_id: catId ? parseInt(catId, 10) : -1, tags: tags };
    try {
      var ast = parseDSL(expr);
      if (!state.catMap) { resultEl.innerHTML = '<span class="ldf-pv-idle">类别映射加载中…</span>'; return; }
      var fn = compile(ast);
      var hit = fn(mockTopic);
      resultEl.innerHTML = hit ? '<span class="ldf-pv-hit">✓ 命中：这条帖子会被过滤</span>' : '<span class="ldf-pv-miss">✗ 未命中：这条帖子不会被过滤</span>';
    } catch (e) {
      resultEl.innerHTML = '<span class="ldf-pv-err">✗ 表达式错误：' + escHtml(e.message) + '</span>';
    }
  }

  // ── 导入/导出 ──
  function exportRules() {
    var blob = new Blob([JSON.stringify(state.rules, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'linuxdo-filter-rules.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
  function importRules(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error('文件内容不是数组');
        var existingNames = new Set(state.rules.map(function (r) { return r.name; }));
        imported.forEach(function (r) {
          var base = r.name || '导入规则';
          var name = base, n = 1;
          while (existingNames.has(name)) { name = base + '(导入' + n + ')'; n++; }
          existingNames.add(name);
          state.rules.push({
            name: name,
            status: r.status || 'draft',
            expr: r.expr || '',
            scope: r.scope || { type: 'global' }
          });
        });
        persistRules();
        renderListView();
        alert('已导入 ' + imported.length + ' 条规则（同名已追加后缀）。');
      } catch (e) { alert('导入失败：' + e.message); }
    };
    reader.readAsText(file);
    evt.target.value = '';
  }

  function openModal() {
    buildModal();
    renderListView();
    modal.style.display = 'flex';
  }

  // ───────────────────────── UI 启动 + MO 自愈 ─────────────────────────
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
      '.ldf-item-stats{font-size:11px;color:var(--primary-low-mid,#aaa)}',
      // modal
      '#ldf-modal .ldf-modal-box{background:var(--secondary,#fff);color:var(--primary,#222);width:680px;max-width:100%;max-height:90vh;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden;display:flex;flex-direction:column;font-family:inherit}',
      '#ldf-modal .ldf-view{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '#ldf-modal .ldf-modal-header{padding:14px 18px;border-bottom:1px solid var(--primary-low,#ddd);flex-shrink:0;display:flex;align-items:center;justify-content:space-between}',
      '#ldf-modal .ldf-close-icon{cursor:pointer;font-size:18px;color:var(--primary-medium,#888);line-height:1;padding:2px 4px;user-select:none}',
      '#ldf-modal .ldf-close-icon:hover{color:var(--primary,#222)}',
      '#ldf-modal .ldf-modal-footer{padding:12px 18px;border-top:1px solid var(--primary-low,#ddd);display:flex;justify-content:space-between;align-items:center;flex-shrink:0}',
      '#ldf-modal .ldf-footer-hint{font-size:11px;color:var(--primary-medium,#888)}',
      '#ldf-modal .ldf-list-toolbar{padding:10px 18px;display:flex;gap:8px;flex-shrink:0}',
      '#ldf-modal .ldf-list-body{flex:1;overflow-y:auto;padding:0 18px}',
      '#ldf-modal .ldf-empty{padding:30px;text-align:center;color:var(--primary-medium,#888)}',
      '#ldf-modal .ldf-rule-row{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--primary-low,#eee)}',
      '#ldf-modal .ldf-rule-row.ldf-draft{opacity:.6}',
      '#ldf-modal .ldf-rule-info{flex:1;min-width:0}',
      '#ldf-modal .ldf-rule-name{font-weight:600;font-size:14px;margin-bottom:2px}',
      '#ldf-modal .ldf-tag-draft{font-size:11px;background:var(--primary-low,#ddd);color:var(--primary-medium,#888);padding:1px 6px;border-radius:3px;margin-left:4px}',
      '#ldf-modal .ldf-rule-meta{font-size:12px;color:var(--primary-medium,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#ldf-modal .ldf-rule-expr{font-family:monospace}',
      '#ldf-modal .ldf-rule-actions{display:flex;gap:4px;flex-shrink:0}',
      '#ldf-modal .ldf-rule-actions button{font-size:12px;padding:3px 10px;cursor:pointer;border:1px solid var(--primary-low,#ccc);background:transparent;border-radius:3px;color:var(--primary,#222)}',
      // switch
      '#ldf-modal .ldf-switch{position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0}',
      '#ldf-modal .ldf-switch input{opacity:0;width:0;height:0}',
      '#ldf-modal .ldf-slider{position:absolute;cursor:pointer;inset:0;background:var(--primary-low,#ccc);border-radius:20px;transition:.2s}',
      '#ldf-modal .ldf-slider:before{content:"";position:absolute;height:16px;width:16px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.2s}',
      '#ldf-modal .ldf-switch input:checked + .ldf-slider{background:var(--tertiary,#08c)}',
      '#ldf-modal .ldf-switch input:checked + .ldf-slider:before{transform:translateX(16px)}',
      // edit form
      '#ldf-modal .ldf-edit-body{flex:1;overflow-y:auto;padding:14px 18px}',
      '#ldf-modal .ldf-field{margin-bottom:14px}',
      '#ldf-modal .ldf-field > label{display:block;font-weight:600;font-size:13px;margin-bottom:4px}',
      '#ldf-modal .ldf-field input[type=text],#ldf-modal .ldf-field textarea,#ldf-modal .ldf-field select{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--primary-low,#ccc);border-radius:4px;font-size:13px;background:var(--secondary,#fff);color:var(--primary,#222)}',
      '#ldf-modal .ldf-field textarea{font-family:monospace;min-height:60px;resize:vertical}',
      '#ldf-modal .ldf-expr-status{font-size:12px;display:inline-block;margin-top:4px}',
      '#ldf-modal .ldf-status-ok{color:#2a9d4a}#ldf-modal .ldf-status-err{color:#d12c25}#ldf-modal .ldf-status-empty{color:var(--primary-medium,#888)}',
      '#ldf-modal .ldf-scope-row{display:flex;gap:16px}',
      '#ldf-modal .ldf-scope-row label{font-weight:normal;font-size:13px;cursor:pointer}',
      '#ldf-modal .ldf-cat-tree{margin-top:8px;padding:10px;border:1px solid var(--primary-low,#eee);border-radius:4px;max-height:240px;overflow-y:auto}',
      '#ldf-modal .ldf-cat-hint{font-size:11px;color:var(--primary-medium,#888);margin-bottom:6px}',
      '#ldf-modal .ldf-cat-list{display:flex;flex-wrap:wrap;gap:6px 14px}',
      '#ldf-modal .ldf-cat-item{font-size:13px;cursor:pointer;white-space:nowrap}',
      '#ldf-modal .ldf-include-home{display:block;margin-top:8px;font-size:13px;cursor:pointer}',
      '#ldf-modal .ldf-preview{border:1px solid var(--primary-low,#eee);border-radius:4px;padding:10px}',
      '#ldf-modal .ldf-preview input,#ldf-modal .ldf-preview select{margin-bottom:6px}',
      '#ldf-modal .ldf-pv-result{font-size:13px;padding:6px 0}',
      '#ldf-modal .ldf-pv-hit{color:#d12c25}#ldf-modal .ldf-pv-miss{color:#2a9d4a}#ldf-modal .ldf-pv-err{color:#d12c25}#ldf-modal .ldf-pv-idle{color:var(--primary-medium,#888)}'
    ].join('\n');
    document.head.appendChild(css);

    syncCurrentPage();
    ensureTopBtn();

    var mo = null;
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        if (!mo) return;
        var prevKey = state.currentPage ? state.currentPage.key : null;
        syncCurrentPage();
        ensureTopBtn();
        tryRenderSelfEmpty();
        var curKey = state.currentPage ? state.currentPage.key : null;
        if (curKey !== prevKey) {
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

    try { GM_registerMenuCommand('LinuxDo 过滤器 · 设置', openModal); } catch (e) {}
  }

  try { window.__LDF = { state: state, parseDSL: parseDSL, reloadRules: reloadRules, pageContext: pageContext, ruleAppliesToPage: ruleAppliesToPage }; } catch (e) {}

})();
