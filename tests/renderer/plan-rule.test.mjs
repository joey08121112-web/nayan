// R7 计划解析（app/ui/plan-rule.js）：parsePlan / splitStepTime / lateMinutes。
// 用法：node tests/renderer/plan-rule.test.mjs   每条 PASS/FAIL 逐行打印，有 FAIL 时 exit 1。
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const P = require(path.join(REPO, 'app/ui/plan-rule.js'));
let fail = 0, n = 0;
const show = (v) => JSON.stringify(v);
function eq(name, got, want) {
  n++; const ok = show(got) === show(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  got=' + show(got) + '  want=' + show(want)));
  if (!ok) fail++;
}
const S = (time, text) => ({ time, text });

// ---- parsePlan：设计稿与常见写法 ----
eq('P01 设计稿原句', P.parsePlan('今天：9 点和设计组过稿，10:30 改收录弹窗，下午 3 点去医院复查，晚上整理周报'),
  [S('09:00', '和设计组过稿'), S('10:30', '改收录弹窗'), S('15:00', '去医院复查'), S('晚上', '整理周报')]);
eq('P02 全角冒号 10：30', P.parsePlan('9点开会；10：30 写周报'), [S('09:00', '开会'), S('10:30', '写周报')]);
eq('P03 点半 / 一刻 / 三刻', P.parsePlan('8点半起床，9点一刻出门，9点三刻到公司'), [S('08:30', '起床'), S('09:15', '出门'), S('09:45', '到公司')]);
eq('P04 中文数字', P.parsePlan('九点开会，十一点半吃饭，两点午睡'), [S('09:00', '开会'), S('11:30', '吃饭'), S('14:00', '午睡')]);
eq('P05 十二点（无时段）= 中午 12 点', P.parsePlan('11点写方案，12点吃饭'), [S('11:00', '写方案'), S('12:00', '吃饭')]);
eq('P06 晚上 12 点 = 00:00', P.parsePlan('晚上10点洗澡，晚上12点睡觉'), [S('22:00', '洗澡'), S('00:00', '睡觉')]);
eq('P07 中午 1 点 = 13:00', P.parsePlan('上午10点开会，中午1点吃饭'), [S('10:00', '开会'), S('13:00', '吃饭')]);
eq('P08 没写时段但比上一条早 → 下午', P.parsePlan('10:30 改稿，2 点开会，4点复盘'), [S('10:30', '改稿'), S('14:00', '开会'), S('16:00', '复盘')]);
eq('P09 下午之后的小钟点沿用下午', P.parsePlan('下午3点去医院，5点接孩子'), [S('15:00', '去医院'), S('17:00', '接孩子')]);
eq('P10 只有时段词也算时间点', P.parsePlan('上午写代码，下午开会，晚上健身'), [S('上午', '写代码'), S('下午', '开会'), S('晚上', '健身')]);
eq('P11 没时间的步骤保留、时间为空', P.parsePlan('9点开会，顺便买咖啡，10点写周报'), [S('09:00', '开会'), S('', '顺便买咖啡'), S('10:00', '写周报')]);
eq('P12 换行分隔', P.parsePlan('09:00 晨会\n10:00 评审\n14:00 写文档'), [S('09:00', '晨会'), S('10:00', '评审'), S('14:00', '写文档')]);
eq('P13 顿号分隔', P.parsePlan('9点开会、10点改稿、11点发版'), [S('09:00', '开会'), S('10:00', '改稿'), S('11:00', '发版')]);
eq('P14 时间写在句中间', P.parsePlan('和设计组 9 点过稿，产品评审 11 点'), [S('09:00', '和设计组 过稿'), S('11:00', '产品评审')]);
eq('P15 去掉「然后 / 再」', P.parsePlan('9点开会，然后10点写周报，再11点发邮件'), [S('09:00', '开会'), S('10:00', '写周报'), S('11:00', '发邮件')]);
eq('P16 前缀「今天的计划：」不算一步', P.parsePlan('今天的计划：8点跑步，9点早饭'), [S('08:00', '跑步'), S('09:00', '早饭')]);
eq('P17 重复标点', P.parsePlan('9点开会，，10点写周报；；'), [S('09:00', '开会'), S('10:00', '写周报')]);
eq('P18 英文混写', P.parsePlan('9:00 standup，10:30 review PR #42'), [S('09:00', 'standup'), S('10:30', 'review PR #42')]);
eq('P19 「今晚」记成「晚上」', P.parsePlan('下午写稿，今晚看电影'), [S('下午', '写稿'), S('晚上', '看电影')]);
eq('P20 3时 写法（单说 1～5 点按下午）', P.parsePlan('2时开会，3时半复盘'), [S('14:00', '开会'), S('15:30', '复盘')]);
eq('P22 凌晨要明说', P.parsePlan('凌晨5点起床，6点跑步'), [S('05:00', '起床'), S('06:00', '跑步')]);
// ---- 2026-10-11 真实 AI 实测时暴露的规则问题（与 AI 结果对照）----
eq('R01 沿用前面说过的「下午」', P.parsePlan('上午把发票整理好寄出去；下午有空的话看一下那篇关于睡眠的文章，四点接孩子，七点半家长会'),
  [S('上午', '把发票整理好寄出去'), S('下午', '有空的话看一下那篇关于睡眠的文章'), S('16:00', '接孩子'), S('19:30', '家长会')]);
eq('R02 「十点前」写成截止、去掉「先」', P.parsePlan('早上先去趟银行，然后十点前把周报发给老板，中午和小李吃饭，下午两点半开评审，评审完去健身房'),
  [S('早上', '去趟银行'), S('10:00', '把周报发给老板（10:00 前）'), S('中午', '和小李吃饭'), S('14:30', '开评审'), S('', '评审完去健身房')]);
eq('R03 英文时段与 6pm', P.parsePlan('9:30 standup，然后 review 两个 PR，12 点 lunch with Amy，afternoon 写 R7 的设计文档，6pm 前提交'),
  [S('09:30', 'standup'), S('', 'review 两个 PR'), S('12:00', 'lunch with Amy'), S('下午', '写 R7 的设计文档'), S('18:00', '提交（18:00 前）')]);
eq('R04 9am / 2:30pm', P.parsePlan('9am gym，2:30pm call with team'), [S('09:00', 'gym'), S('14:30', 'call with team')]);
eq('P21 分钟写法 9点15分', P.parsePlan('9点15分出门，10点20到'), [S('09:15', '出门'), S('10:20', '到')]);

// ---- parsePlan：不该出现「排成清单」的 ----
eq('N01 空输入', P.parsePlan(''), null);
eq('N02 只有一个时间点', P.parsePlan('明天9点开会'), null);
eq('N03 普通一句话', P.parsePlan('这篇回答讲得很清楚，先收着'), null);
eq('N04 时段词不在句首不算（只剩 1 个时间点）', P.parsePlan('看了一篇讲晚上睡眠的文章，9点再读一遍'), null);
eq('N05 「2-4 周」「3 小时」不是时间点', P.parsePlan('继续自用 2-4 周，每天 3 小时'), null);
eq('N06 只有时间没有事情', P.parsePlan('9点，10点'), null);

// ---- splitStepTime / stepContent ----
eq('T01 拆 HH:MM', P.splitStepTime('09:00 和设计组过稿'), S('09:00', '和设计组过稿'));
eq('T02 拆时段词', P.splitStepTime('晚上 整理周报'), S('晚上', '整理周报'));
eq('T03 没时间', P.splitStepTime('整理周报'), S('', '整理周报'));
eq('T04 时间后没有空格不拆（防误伤「10:30会议纪要」以外的正文）', P.splitStepTime('10:30会议'), S('', '10:30会议'));
eq('T05 stepContent 往返', P.splitStepTime(P.stepContent(S('15:00', '去医院复查'))), S('15:00', '去医院复查'));
eq('T06 stepContent 无时间', P.stepContent(S('', '买咖啡')), '买咖啡');

// ---- lateMinutes / lateLabel / planTitle ----
const at = (h, m) => new Date(2026, 9, 11, h, m);
eq('L01 没过点 = 0', P.lateMinutes('15:00', at(11, 40)), 0);
eq('L02 过了 70 分钟', P.lateMinutes('10:30', at(11, 40)), 70);
eq('L03 时段词不算过点', P.lateMinutes('晚上', at(23, 0)), 0);
eq('L04 标签：分钟', P.lateLabel(25), '过了 25 分钟');
eq('L05 标签：小时', P.lateLabel(70), '过了 1 小时');
eq('L06 标签：没过点为空', P.lateLabel(0), '');
eq('L07 标题', P.planTitle(at(9, 0)), '今天的计划 · 10 月 11 日');

console.log(`plan-rule: ${n - fail} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
