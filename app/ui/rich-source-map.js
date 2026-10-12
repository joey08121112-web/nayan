/* 纳言 · 源区间映射（rich-source-map.js）—— P1-B06-FIVE-STEP-2026-10-01 / S04 基础
   契约见批次 SOURCE-SPAN-CONTRACT.md（UTF-16 半开区间，指向 canonical 文本）。
   依赖：全局 markdownit（vendor 锁定 15.0.2，与 markdownToHtml 完全同一套解析选项
   ——html/linkify/typographer 全关；不经第二套正则重解析 Markdown）。
   本模块只做「读」：不触碰清洗器、链接出口、plain projection、DOM 写点；
   sidecar 为冻结数据对象 + 闭包源快照，访问时逐次重校验身份与内容（防跨条目串用）。 */

(function (globalRef) {
  'use strict';

  /* One private modest-AST snapshot for reopening a long response. Strings are
     immutable; token/env objects are copied both into and out of this cache.
     No identity, sidecar, live DOM, or caller-owned AST is retained here. */
  var lastParse = null;
  var nativeParse = null, nativeRules = null;
  function initializeParseCache() {
    if (nativeRules || typeof globalRef.markdownit !== 'function') return;
    var baseline = globalRef.markdownit({ html: false, breaks: false, linkify: false, typographer: false });
    nativeParse = baseline.parse;
    nativeRules = parseSignature(baseline).rules;
  }
  try { initializeParseCache(); } catch (e) { nativeParse = null; nativeRules = null; }
  function copyParseValue(value, budget) {
    if (value === null || typeof value !== 'object') return value;
    if (++budget.count > 16384) throw new Error('parse cache object limit');
    var array = Array.isArray(value);
    /* Populate ordinary objects without a prototype, so even __proto__ is an
       own data key. Install the Token prototype once, after all data is copied. */
    var out = array ? [] : Object.create(null);
    Object.keys(value).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('parse cache requires data properties');
      var copied = copyParseValue(descriptor.value, budget);
      if (!array || (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295)) out[key] = copied;
      else Object.defineProperty(out, key, { value: copied, writable: true, configurable: true, enumerable: true });
    });
    if (!array && Object.getPrototypeOf(value) !== null) Object.setPrototypeOf(out, Object.getPrototypeOf(value));
    return out;
  }
  function parseSignature(md) {
    var rules = [];
    [md.core.ruler, md.block.ruler, md.inline.ruler, md.inline.ruler2].forEach(function (ruler) {
      rules.push.apply(rules, ruler.getRules(''));
      rules.push(null); // Preserve rule-group boundaries.
    });
    return { parser: md, parse: md.parse, options: JSON.stringify(md.options), rules: rules };
  }
  function sameParseSignature(a, b) {
    return a.parser === b.parser && a.parse === b.parse && a.options === b.options
      && a.rules.length === b.rules.length && a.rules.every(function (rule, i) { return rule === b.rules[i]; });
  }
  function parseSource(md, source) {
    var signature = null;
    try {
      initializeParseCache();
      signature = parseSignature(md);
      /* Arbitrary parse wrappers/plugin callbacks need not be deterministic.
         They always use the real uncached path, including fault injection. */
      if (signature.parse !== nativeParse || !nativeRules || !signature.rules.every(function (rule) {
        return rule === null || nativeRules.indexOf(rule) >= 0;
      })) signature = null;
    } catch (e) { lastParse = null; }
    if (!signature) lastParse = null;
    if (lastParse && signature && lastParse.source === source && sameParseSignature(lastParse.signature, signature)) {
      try { return copyParseValue(lastParse.value, { count: 0 }); }
      catch (e) { lastParse = null; } // A cache fault never replaces the actual parser.
    }
    var env = {}, tokens = md.parse(source, env);
    lastParse = null;
    if (signature && source.length <= 1024 * 1024 && tokens.length <= 8192) {
      try { lastParse = { source: source, signature: signature,
        value: copyParseValue({ tokens: tokens, env: env }, { count: 0 }) }; }
      catch (e) { lastParse = null; } // Large/unsupported trees keep the uncached path.
    }
    return { tokens: tokens, env: env };
  }

  /* ---------- 行起点表（一次构建；正确处理空源/末行无换行/连续空行） ---------- */
  function buildLineStarts(src) {
    var starts = [0];
    for (var i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
    }
    return starts; // starts[k] = 第 k 行行首的 UTF-16 偏移；starts.length = 行数
  }

  /* ---------- 格式资格（契约 §2：不猜格式） ---------- */
  function sourceMapAvailability(decision) {
    if (!decision || !decision.renderable) {
      return { available: false, reason: (decision && decision.reason) || '正文不可渲染' };
    }
    if (decision.mode !== 'markdown' || decision.format !== 'markdown' || decision.provenance !== 'declared') {
      if (decision.mode === 'html') {
        return { available: false, reason: '声明 HTML 经白名单清洗，源 offset 不可从清洗后 DOM 反推' };
      }
      return { available: false, reason: 'legacy/plain 不提供源区间（不猜 Markdown）' };
    }
    if (typeof decision.text !== 'string') return { available: false, reason: 'canonical 必须是文本' };
    if (typeof globalRef.markdownit !== 'function') {
      return { available: false, reason: 'markdown 解析器未加载，无法构建源区间' };
    }
    return { available: true };
  }

  /* ---------- 冻结工具 ---------- */
  function deepFreeze(obj) {
    Object.freeze(obj);
    return obj;
  }

  /* ---------- 契约 §3 身份匹配（三项全过才算同一内容） ---------- */
  function sameIdentity(a, b) {
    if (!validIdentity(a) || !validIdentity(b)) return false;
    return (a.itemId == null ? b.itemId == null : a.itemId === b.itemId)
      && (a.requestId == null ? b.requestId == null : a.requestId === b.requestId)
      && (a.revision == null ? b.revision == null : a.revision === b.revision);
  }

  function validIdentity(identity) {
    if (!identity || typeof identity !== 'object') return false;
    var id = identity.itemId, req = identity.requestId, rev = identity.revision;
    var item = typeof id === 'number' && Number.isSafeInteger(id) && id > 0
      || typeof id === 'string' && /^[1-9][0-9]*$/.test(id);
    if (id != null && !item) return false;
    if (req != null && (typeof req !== 'string' || req.length === 0)) return false;
    if (rev != null && typeof rev !== 'string' && !(typeof rev === 'number' && Number.isSafeInteger(rev))) return false;
    return item || typeof req === 'string' && req.length > 0;
  }

  /* ---------- sidecar 构建（纯函数；同输入逐字节确定） ----------
     返回冻结对象：
       identity() → {itemId, requestId, revision}（revision 恒如实，无则 null）
       entries()  → 冻结条目数组（section / code-block / code-payload / unsupported 标记）
       sourceLength() → 源长度（canonical，UTF-16 单元）
       check(decision, currentIdentity) → 格式/全文/当前身份全部匹配
       slice(entryId, decision, currentIdentity) → 每次访问重校验；省略身份拒绝 */
  function buildSourceSidecar(decision, identity, captureParsed) {
    var gate = sourceMapAvailability(decision);
    if (gate.available && !validIdentity(identity)) gate = { available: false, reason: '没有可信 item/request 身份' };
    if (!gate.available) {
      return deepFreeze({
        __unavailable: true, reason: gate.reason,
        identity: function () { return deepFreeze({ itemId: identity && identity.itemId != null ? identity.itemId : null, requestId: identity && identity.requestId != null ? identity.requestId : null, revision: null }); },
        entries: function () { return []; },
        check: function () { return false; },
        slice: function () { return { ok: false, reason: gate.reason }; }
      });
    }
    var source = String(decision.text); // canonical（readerBody 已做 CRLF/CR→LF）
    var starts = buildLineStarts(source);
    var lineStart = function (k) { return starts[k]; };

    // 与 markdownToHtml 完全同一实例选项（html/breaks/linkify/typographer 全关）；
    // 模块级缓存实例（选项恒定），构建只做 parse——同输入逐字节确定。
    if (!globalRef.__nayanSourceMapMD) {
      globalRef.__nayanSourceMapMD = globalRef.markdownit({ html: false, breaks: false, linkify: false, typographer: false });
    }
    var tokens, parseEnv={};
    try {
      var parsed = parseSource(globalRef.__nayanSourceMapMD, source);
      tokens = parsed.tokens; parseEnv = parsed.env;
    }
    catch (e) {
      return deepFreeze({
        __unavailable: true, reason: 'markdown 解析失败：' + (e && e.message),
        identity: function () { return null; }, entries: function () { return []; },
        check: function () { return false; }, slice: function () { return { ok: false, reason: '解析失败' }; }
      });
    }

    var entries = [];
    var nextId = 1;
    function validRange(start, end) {
      return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= source.length;
    }
    function publish(entry) {
      if (entry.available && !validRange(entry.start, entry.end)) {
        entry.available = false; entry.reason = '源区间边界不可证明';
      }
      entries.push(deepFreeze(entry));
    }
    function lineEndExcludingTerminator(lastLine) {
      // lastLine 之后还有行 → 其行首 -1 即为 lastLine 的行终止符位置（= 内容末尾）
      var next = lineStart(lastLine + 1);
      return next === undefined ? source.length : next - 1;
    }

    // ---- 1) code-block（fence 与缩进 code_block；含容器内——完整源块照常可用） ----
    var blockIds = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type !== 'fence' && t.type !== 'code_block') continue;
      if (!t.map) continue;
      var openLine = t.map[0], lastLine = t.map[1] - 1;
      var start = lineStart(openLine);
      var end = lineEndExcludingTerminator(lastLine);
      var id = nextId++;
      blockIds.push(id);
      publish({
        id: id, kind: 'code-block',
        lang: t.type === 'fence' ? String(t.info || '').trim() : '',
        fenced: t.type === 'fence',
        start: start, end: end, available: true
      });
      // ---- code-payload：唯一可用判据 = 候选连续切片与解析器内文逐字符相等（契约 §4.3） ----
      var payloadStart, payloadEnd;
      if (t.type === 'fence') {
        payloadStart = lineStart(openLine + 1);
        payloadEnd = lastLine >= openLine + 1 ? lineStart(lastLine) - 1 : payloadStart;
        // Adjacent opening/closing fence: the empty payload is at the closing line start.
        if (lastLine === openLine + 1 && t.content === '') payloadEnd = payloadStart;
      } else {
        payloadStart = lineStart(openLine);
        payloadEnd = lineEndExcludingTerminator(lastLine);
      }
      var candidate = source.slice(payloadStart, payloadEnd);
      var expected = String(t.content || '');
      if (expected.slice(-1) === '\n') expected = expected.slice(0, -1); // 去恰好一个结尾换行
      var payloadOk = validRange(payloadStart, payloadEnd) && candidate === expected;
      publish({
        id: nextId++, kind: 'code-payload', forBlock: id,
        start: payloadOk ? payloadStart : -1, end: payloadOk ? payloadEnd : -1,
        available: payloadOk,
        reason: payloadOk ? null : '行前缀使内文非连续源切片'
      });
    }

    // ---- 2) section（仅 token.level===0 的顶层标题；容器内标题显式 Unavailable） ----
    var headings = [];
    for (var j = 0; j < tokens.length; j++) {
      var h = tokens[j];
      if (h.type !== 'heading_open' || !h.map) continue;
      // 标题内联原文（heading_open 后紧跟 inline token）：供展示/检索参考，绝不用于匹配/身份
      var inlineText = '';
      if (tokens[j + 1] && tokens[j + 1].type === 'inline') inlineText = String(tokens[j + 1].content || '');
      headings.push({ line: h.map[0], level: Number(/h([1-6])/.exec(h.tag || '')[1] || 0), depth: h.level || 0, titleText: inlineText });
    }
    for (var k = 0; k < headings.length; k++) {
      var hd = headings[k];
      var sStart = lineStart(hd.line);
      var sEnd = source.length;
      if (hd.depth === 0) {
        for (var m = k + 1; m < headings.length; m++) {
          if (headings[m].depth === 0 && headings[m].level <= hd.level) { sEnd = lineStart(headings[m].line); break; }
        }
      }
      publish({
        id: nextId++, kind: 'section', level: hd.level,
        titleText: hd.titleText, start: sStart, end: sEnd,
        available: hd.depth === 0,
        reason: hd.depth === 0 ? null : '容器内标题不提供章节区间'
      });
    }

    var frozenIdentity = deepFreeze({
      itemId: identity && identity.itemId != null ? identity.itemId : null,
      requestId: identity && identity.requestId != null ? identity.requestId : null,
      revision: identity && identity.revision != null ? identity.revision : null // 无版本号时如实为 null
    });
    var frozenEntries = deepFreeze(entries.slice());
    /* Only the private prepare path receives tokens, after all source entries are sealed.
       The renderer may mutate its tokens; it cannot mutate the already-frozen sidecar. */
    if(captureParsed) captureParsed(tokens,parseEnv);

    function check(decisionNow, identityNow) {
      return sourceMapAvailability(decisionNow).available && sameIdentity(frozenIdentity, identityNow)
        && decisionNow.text === source;
    }
    return deepFreeze({
      identity: function () { return frozenIdentity; },
      entries: function () { return frozenEntries; },
      sourceLength: function () { return source.length; },
      unsupportedStructures: deepFreeze(['table', 'list', 'blockquote', 'hr', 'paragraph']), // 契约 §4.4：本批不提供区间
      check: check,
      matches: function (identityNow, sourceTextNow) {
        return sameIdentity(frozenIdentity, identityNow) && typeof sourceTextNow === 'string' && sourceTextNow === source;
      },
      slice: function (entryId, decisionNow, identityNow) {
        if (!check(decisionNow, identityNow)) {
          return { ok: false, reason: '身份不匹配：旧映射不得用于新内容' };
        }
        var ent = null;
        for (var n = 0; n < frozenEntries.length; n++) {
          if (frozenEntries[n].id === entryId) { ent = frozenEntries[n]; break; }
        }
        if (!ent) return { ok: false, reason: '条目不存在：' + String(entryId) };
        if (!ent.available) return { ok: false, reason: ent.reason || '该结构不提供源区间' };
        if (!(ent.start >= 0 && ent.end >= ent.start && ent.end <= source.length)) {
          return { ok: false, reason: '边界非法' };
        }
        // 从闭包快照切片（非调用方可变源），无 trim 无改写
        return { ok: true, text: source.slice(ent.start, ent.end) };
      }
    });
  }

  globalRef.NaYanSourceSpans = deepFreeze({
    version: 'P1-B06-FIVE-STEP-2026-10-01',
    availability: sourceMapAvailability,
    build: function(decision,identity){ return buildSourceSidecar(decision,identity); },
    prepare: function(decision,identity){
      var tokens=null,env=null;
      var sidecar=buildSourceSidecar(decision,identity,function(t,e){ tokens=t;env=e; });
      return {sidecar:sidecar,tokens:tokens,env:env};
    }
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
