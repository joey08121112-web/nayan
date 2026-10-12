/* 纳言 · R7「说一句计划，排成清单」——不靠 AI 的计划解析（主窗口「记一条」用；node 里可 require 做测试）。
   parsePlan(text)：认出时间点（9 点 / 9点半 / 10:30 / 10：30 / 下午 3 点 / 三点一刻 / 中午 / 晚上 …），
   按时间点和 ，,；;。、换行 拆成步骤，返回 [{time:'09:00'|'晚上'|'', text}]；时间点少于 2 个返回 null（不出「排成清单」）。
   splitStepTime(content)：步骤文字开头的「HH:MM 」或「上午 / 中午 / 下午 / 晚上 …」拆成时间列（存法：时间写在步骤开头，不改库）。
   lateMinutes(time, now)：今天的 HH:MM 已过去多少分钟（没过、或不是钟点返回 0）。 */
(function (root) {
  var PERIOD = '凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|夜里';
  // 英文混写：morning / noon / afternoon / evening / tonight 记成对应的中文时段；9am、6pm、6:30pm 认成钟点
  var EN_PERIOD = { morning: '上午', noon: '中午', afternoon: '下午', evening: '晚上', tonight: '晚上' };
  var EN_CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
  var EN_BARE = /\b(morning|noon|afternoon|evening|tonight)\b/i;
  var CN = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  function cnNum(s) {
    if (/^\d+$/.test(s)) return Number(s);
    if (s === '十') return 10;
    if (s.length === 2 && s[0] === '十') return 10 + CN[s[1]];
    if (s.length === 2 && s[1] === '十') return CN[s[0]] * 10;
    if (s.length === 3 && s[1] === '十') return CN[s[0]] * 10 + CN[s[2]];
    return CN[s] != null ? CN[s] : NaN;
  }
  var NUM = '\\d{1,2}|[一二两三四五六七八九十]{1,3}';
  // 时间点：可选时段 + 钟点（:mm / 点或时 + [半|一刻|三刻|mm分]），或者单独的时段词
  var CLOCK = new RegExp('(' + PERIOD + ')?\\s*(' + NUM + ')\\s*(?:[:：]\\s*(\\d{2})|[点时]\\s*(半|一刻|三刻|(?:' + NUM + ')\\s*分?)?)');
  var BARE = new RegExp('(' + PERIOD + ')');
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function to24(period, h, prevH, ctx) {
    if (period === '下午' || period === '傍晚' || period === '晚上' || period === '今晚' || period === '夜里') {
      if (h === 12) return period === '下午' ? 12 : 0;
      return h < 12 ? h + 12 : h;
    }
    if (period === '中午') return (h >= 1 && h <= 3) ? h + 12 : h;
    if (period) return h === 12 && period === '凌晨' ? 0 : h;
    // 没写时段：沿用前面说过的下午 / 晚上（「下午看文章，四点接孩子」）
    if ((ctx === '下午' || ctx === '傍晚' || ctx === '晚上' || ctx === '今晚' || ctx === '夜里') && h < 12) return h + 12;
    // 比上一个时间点早、加 12 小时又不早于它，多半是下午（「10:30 改稿，2 点开会」）
    if (prevH != null && h < prevH && h < 12 && h + 12 >= prevH) return h + 12;
    // 一天的计划里单说 1～5 点，几乎都是下午（要说凌晨会写「凌晨」）
    if (prevH == null && h >= 1 && h <= 5) return h + 12;
    return h;
  }
  function minutesOf(m3, m4) {
    if (m3) return Number(m3);
    if (!m4) return 0;
    if (m4 === '半') return 30;
    if (m4 === '一刻') return 15;
    if (m4 === '三刻') return 45;
    var n = cnNum(m4.replace(/\s*分$/, '').trim());
    return isNaN(n) ? 0 : n;
  }
  function cleanText(s) {
    return s.replace(/^[\s:：,，、;；。.\-—~～]+/, '')
      .replace(/^(?:然后|之后|接着|再|就|要|得|先)\s*/, '')
      .replace(/^[\s:：,，]+/, '')
      .replace(/[\s,，、;；。.]+$/, '')
      .trim();
  }
  function stripLead(s) {
    return s.replace(/^\s*(?:今天|今日)?\s*(?:的)?\s*(?:计划|安排|日程|待办|要做的事)?\s*[:：]\s*/, '')
      .replace(/^\s*(?:今天|今日)\s*/, '');
  }
  function parsePlan(text) {
    var src = String(text == null ? '' : text).trim();
    if (!src) return null;
    var clauses = stripLead(src).split(/[，,；;。\n、]+/);
    var steps = [], points = 0, prevH = null, ctx = '';
    clauses.forEach(function (raw) {
      var c = stripLead(raw).trim();
      if (!c) return;
      var e = c.match(EN_CLOCK), m = e ? null : c.match(CLOCK), time = '', rest = c, before = false;
      // 时间后面紧跟「前 / 之前 / 以前」：截止时间（「十点前把周报发给老板」）
      function cutAt(idx, len) {
        var after = c.slice(idx + len).replace(/^\s*(?:之前|以前|前)/, function () { before = true; return ''; });
        return c.slice(0, idx) + ' ' + after;
      }
      if (m) {
        var h = cnNum(m[2]);
        if (!isNaN(h) && h >= 0 && h <= 24) {
          var mi = minutesOf(m[3], m[4]);
          if (mi >= 0 && mi < 60) {
            var H = to24(m[1] || '', h === 24 ? 0 : h, prevH, ctx);
            time = pad2(H) + ':' + pad2(mi); prevH = H; points++;
            if (m[1]) ctx = m[1];
            rest = cutAt(m.index, m[0].length);
          }
        }
      } else if (e) {
        var eh = Number(e[1]), em = e[2] ? Number(e[2]) : 0, pm = /pm/i.test(e[3]);
        if (eh >= 1 && eh <= 12 && em < 60) {
          var EH = pm ? (eh === 12 ? 12 : eh + 12) : (eh === 12 ? 0 : eh);
          time = pad2(EH) + ':' + pad2(em); prevH = EH; points++;
          rest = cutAt(e.index, e[0].length);
        }
      }
      if (!time) {
        var b = c.match(BARE), eb = c.match(EN_BARE);
        // 单独的时段词只在句首附近才算时间点（「晚上整理周报」算，「看了一篇讲晚上睡眠的文章」不算）
        if (b && b.index <= 2) { time = b[1] === '今晚' ? '晚上' : (b[1] === '早晨' ? '早上' : b[1]); ctx = b[1]; points++; rest = c.slice(0, b.index) + c.slice(b.index + b[0].length); }
        else if (eb && eb.index <= 2) { time = EN_PERIOD[eb[1].toLowerCase()]; ctx = time; points++; rest = c.slice(0, eb.index) + c.slice(eb.index + eb[0].length); }
      }
      // 截止时间写进文字：「把周报发给老板（10:00 前）」
      var t = cleanText(rest.replace(/\s{2,}/g, ' '));
      if (!t) return;
      if (before && time) t += '（' + time + ' 前）';
      steps.push({ time: time, text: t });
    });
    return points >= 2 && steps.length >= 2 ? steps : null;
  }
  function planTitle(now) {
    now = now || new Date();
    return '今天的计划 · ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日';
  }
  function stepContent(s) { return (s.time ? s.time + ' ' : '') + String(s.text || '').trim(); }
  var STEP_TIME = new RegExp('^(\\d{2}:\\d{2}|' + PERIOD + ')\\s+(\\S[\\s\\S]*)$');
  function splitStepTime(content) {
    var m = String(content || '').match(STEP_TIME);
    return m ? { time: m[1], text: m[2] } : { time: '', text: String(content || '') };
  }
  function lateMinutes(time, now) {
    var m = /^(\d{2}):(\d{2})$/.exec(time || ''); if (!m) return 0;
    now = now || new Date();
    var diff = now.getHours() * 60 + now.getMinutes() - (Number(m[1]) * 60 + Number(m[2]));
    return diff > 0 ? diff : 0;
  }
  function lateLabel(min) {
    if (min <= 0) return '';
    if (min < 60) return '过了 ' + min + ' 分钟';
    return '过了 ' + Math.floor(min / 60) + ' 小时';
  }
  var api = { parsePlan: parsePlan, planTitle: planTitle, stepContent: stepContent, splitStepTime: splitStepTime, lateMinutes: lateMinutes, lateLabel: lateLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NayanPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);
