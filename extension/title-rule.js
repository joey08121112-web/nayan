/* 纳言 · 收录取标题规则——app/ui/title-rule.js 的逐字副本（扩展不能引用 App 目录里的文件）。原注释：主窗口「记一条」、收录小窗共用；剪贴板收录在 main.rs short_title、
   浏览器扩展在 extension/background.js 各有一份同口径实现，改这里要一起改）。
   规则：取第一行有字的内容（连续空白并成一个）→ 去掉 Markdown 标题/列表/引用前缀 → 取第一句话（到 。！？；!? 、行中的 • 或英文句点+空格）
   → 超过 30 个字宽截断加「…」（汉字算 1，英文字母/数字/标点算 0.5；英文尽量断在空格处，不停在没闭合的括号里）。
   不调用 AI：没配 AI 的用户也是这个结果。 */
(function (root) {
  var LIMIT = 30;
  function cw(ch) { return ch.codePointAt(0) < 0x2e80 ? 0.5 : 1; }
  function width(s) { var w = 0; for (var ch of s) w += cw(ch); return w; }
  function firstLine(text) {
    var m = String(text == null ? '' : text).match(/[^\r\n]*\S[^\r\n]*/);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }
  function stripMd(line) {
    return line
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d{1,2}(?:[.)]\s+|、\s*))+/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
  }
  function firstSentence(line) {
    var m = line.match(/^(.+?)(?:([。；;]|\s*•\s*)|([！？!?])|\.(?=\s|$))/);
    if (!m) return line;
    var s = (m[1] + (m[3] || '')).trim();
    var byDot = m[2] === undefined && m[3] === undefined;      // 英文句点断句：太短多半是缩写（e.g.）
    return s.length >= (byDot ? 6 : 2) ? s : line;
  }
  function cut(s) {
    if (width(s) <= LIMIT) return s;
    var out = '', w = 0;
    for (var ch of s) { if (w + cw(ch) > LIMIT - 1) break; out += ch; w += cw(ch); }
    // 英文别把单词砍半：最后 8 个字符内有空格就断在空格
    var sp = out.lastIndexOf(' ');
    if (sp > 0 && out.length - sp <= 8 && /[A-Za-z0-9]$/.test(out)) out = out.slice(0, sp);
    // 别停在没闭合的括号/引号里：退到括号前（括号前至少留一半长度）
    var open = -1, pairs = { '（': '）', '(': ')', '“': '”', '「': '」', '《': '》', '【': '】' }, stack = [];
    Array.from(out).forEach(function (ch, i) {
      if (pairs[ch]) stack.push(i);
      else if (stack.length) { for (var k in pairs) if (pairs[k] === ch) { stack.pop(); break; } }
    });
    if (stack.length) open = stack[0];
    if (open > 0) { var head = Array.from(out).slice(0, open).join(''); if (width(head) >= LIMIT / 2) out = head; }
    return out.replace(/[\s,，、:：;；\-—]+$/, '') + '…';
  }
  function shortTitle(text, fallback) {
    var line = stripMd(firstLine(text));
    if (!line) return fallback || '未命名';
    return cut(firstSentence(line));
  }
  var api = { shortTitle: shortTitle, titleWidth: width, TITLE_LIMIT: LIMIT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NayanTitle = api;
})(typeof window !== 'undefined' ? window : globalThis);
