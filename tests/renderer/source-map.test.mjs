// tests/renderer/source-map.test.mjs —— P1-B06-FIVE-STEP-2026-10-01 / S04 源区间映射
// 字符串层套件（vm 沙箱 + 真实 vendored markdown-it + 真实 rich-source-map.js / rich-text.js）。
// 期望来源：steps/01/manual-expectations/ 的人工黄金值（编写 mapper 前冻结，非待测实现生成）。
// 覆盖：人工期望逐字符、结构正例扩展、确定性、格式资格门（不猜格式）、
// 负例五类必败门（off-by-one / 越界 / 同长度异文 / 跨条目身份 / 可变字段篡改）。
// 用法：node tests/renderer/source-map.test.mjs [--out DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-source-map-'));
fs.mkdirSync(outDir, { recursive: true });

const sb = {
  console, setTimeout, clearTimeout,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  document: { createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return String(this._t == null ? '' : this._t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) },
};
sb.window = sb; sb.self = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/ui/vendor/markdown-it.umd.min.js'), 'utf8'), sb, { filename: 'markdown-it.umd.min.js' });
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/ui/rich-text.js'), 'utf8'), sb, { filename: 'rich-text.js' });
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/ui/rich-source-map.js'), 'utf8'), sb, { filename: 'rich-source-map.js' });
const NS = sb.NaYanSourceSpans;

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 400)}`);
}
const md = (text) => ({ format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text });
const EXPECT_DIR = path.join(REPO, 'docs/implementation-plan-2026-09-23/batches/P1-B06-FIVE-STEP-2026-10-01/steps/01/manual-expectations');
// 开源导出仓库不含 docs/implementation-plan-* 批次目录，内联同源合成夹具兜底以确保公开仓 test-all.mjs 可独立运行。
const FALLBACK_FIXTURES = {
  'fx1-basic.json': {
    name: 'fx1-basic-atx-fence',
    source: '# 甲\n开头段落。\n## 乙\n```js\ncode 壹\n  缩进\n```',
    identitySample: { itemId: 101, requestId: 'req-fx1', revision: null },
    expectations: [
      { kind: 'section', level: 1, titleText: '甲', start: 0, end: 36, available: true, expectedSlice: '# 甲\n开头段落。\n## 乙\n```js\ncode 壹\n  缩进\n```' },
      { kind: 'section', level: 2, titleText: '乙', start: 10, end: 36, available: true, expectedSlice: '## 乙\n```js\ncode 壹\n  缩进\n```' },
      { kind: 'code-block', lang: 'js', start: 15, end: 36, available: true, expectedSlice: '```js\ncode 壹\n  缩进\n```' },
      { kind: 'code-payload', forBlock: 1, start: 21, end: 32, available: true, expectedSlice: 'code 壹\n  缩进' },
    ],
  },
  'fx2-setext-duplicate.json': {
    name: 'fx2-setext-duplicate-container-fence',
    source: '主题\n===\n## 甲\n正文一。\n## 甲\n> 引用行\n> ```py\n> x=1\n> ```\n- 列表项\n尾段。\n',
    identitySample: { itemId: 202, requestId: 'req-fx2', revision: null },
    expectations: [
      { kind: 'section', level: 1, titleText: '主题', start: 0, end: 58, available: true, expectedSlice: '主题\n===\n## 甲\n正文一。\n## 甲\n> 引用行\n> ```py\n> x=1\n> ```\n- 列表项\n尾段。\n' },
      { kind: 'section', level: 2, titleText: '甲', start: 7, end: 17, available: true, expectedSlice: '## 甲\n正文一。\n' },
      { kind: 'section', level: 2, titleText: '甲', start: 17, end: 58, available: true, expectedSlice: '## 甲\n> 引用行\n> ```py\n> x=1\n> ```\n- 列表项\n尾段。\n' },
      { kind: 'code-block', lang: 'py', start: 28, end: 47, available: true, expectedSlice: '> ```py\n> x=1\n> ```' },
      { kind: 'code-payload', forBlock: 1, available: false, reason: '行前缀使内文非连续源切片' },
    ],
  },
  'fx3-emoji-indent.json': {
    name: 'fx3-emoji-blank-indent-eof',
    source: '# 标题 🚀\n中段。  \n\n    ind 药\n    二行\n\n尾。',
    identitySample: { itemId: 303, requestId: null, revision: null },
    expectations: [
      { kind: 'section', level: 1, titleText: '标题 🚀', start: 0, end: 35, available: true, expectedSlice: '# 标题 🚀\n中段。  \n\n    ind 药\n    二行\n\n尾。' },
      { kind: 'code-block', lang: '', start: 15, end: 31, available: true, expectedSlice: '    ind 药\n    二行' },
      { kind: 'code-payload', forBlock: 1, available: false, reason: '行前缀使内文非连续源切片' },
    ],
  },
  'fx4-crlf.json': {
    name: 'fx4-crlf-canonical',
    sourceOriginal: '# 首\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n# 次首\r\n尾段。\r\n',
    canonical: '# 首\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n# 次首\n尾段。\n',
    identitySample: { itemId: 404, requestId: 'req-fx4', revision: null },
    expectations: [
      { kind: 'section', level: 1, titleText: '首', start: 0, end: 36, available: true, expectedSlice: '# 首\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n' },
      { kind: 'section', level: 1, titleText: '次首', start: 36, end: 45, available: true, expectedSlice: '# 次首\n尾段。\n' },
    ],
  },
};

// ---------- S1：人工期望逐字符（4 fixtures × 区间+身份+切片三重） ----------
for (const f of ['fx1-basic.json', 'fx2-setext-duplicate.json', 'fx3-emoji-indent.json', 'fx4-crlf.json']) {
  const fixturePath = path.join(EXPECT_DIR, f);
  const d = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : FALLBACK_FIXTURES[f];
  const src = d.canonical !== undefined ? d.canonical : d.source;
  const decision = md(src);
  const sc = NS.build(decision, d.identitySample);
  const ents = sc.entries();
  for (const e of d.expectations) {
    const same = ents.filter((x) => x.kind === e.kind);
    const upto = d.expectations.filter((y) => d.expectations.indexOf(y) < d.expectations.indexOf(e) && y.kind === e.kind).length;
    const g = same[upto];
    if (!g) { check('S1-golden', `${d.name} ${e.kind}#${upto}：条目存在`, false, 'MISS'); continue; }
    if (!e.available) {
      check('S1-golden', `${d.name} ${e.kind}#${upto}：显式 Unavailable（${e.reason}）`,
        g.available === false && g.reason === e.reason, JSON.stringify(g));
      const r = sc.slice(g.id, decision, d.identitySample);
      check('S1-golden', `${d.name} ${e.kind}#${upto}：不可用条目 slice 拒绝`, r.ok === false, JSON.stringify(r));
      continue;
    }
    let name = `${d.name} ${e.kind}#${upto}`;
    let ok = g.available === true && g.start === e.start && g.end === e.end;
    if (e.kind === 'section') ok = ok && g.level === e.level && g.titleText === e.titleText;
    if (e.kind === 'code-block') ok = ok && g.lang === e.lang;
    check('S1-golden', `${name}：区间与元数据`, ok, JSON.stringify({ got: g, exp: e }));
    const r = sc.slice(g.id, decision, d.identitySample);
    check('S1-golden', `${name}：slice 逐字符=人工期望切片`, r.ok === true && r.text === e.expectedSlice,
      JSON.stringify((r.text || '').slice(0, 60)));
    // 身份三要素如实
    check('S1-golden', `${name}：identity 如实（requestId 缺=null 不虚构）`,
      JSON.stringify(sc.identity()) === JSON.stringify(d.identitySample), JSON.stringify(sc.identity()));
  }
  // 嵌套不交错：任意两个可用 section 区间要么相离要么包含
  const secs = ents.filter((x) => x.kind === 'section' && x.available);
  let interleave = false;
  for (let i = 0; i < secs.length; i++) for (let j = i + 1; j < secs.length; j++) {
    const a = secs[i], b = secs[j];
    const overlaps = a.start < b.end && b.start < a.end;
    if (overlaps && !(a.start <= b.start && b.end <= a.end) && !(b.start <= a.start && a.end <= b.end)) interleave = true;
  }
  check('S1-golden', `${d.name}：章节嵌套不交错`, !interleave);
  // 确定性：重建逐字节一致
  const sc2 = NS.build(decision, d.identitySample);
  check('S1-golden', `${d.name}：重复构建确定`, JSON.stringify(sc.entries()) === JSON.stringify(sc2.entries()));
}

// ---------- S2：结构正例扩展（围栏长度/语言、列表内围栏、表格相邻、空源、尾空白、组合字符） ----------
{
  // 围栏长度 ~~~~（4 波浪线）与长语言标签
  const src = '# T\n\n~~~~typescript-react lang=x\nlet a=1;\n~~~~\n';
  const sc = NS.build(md(src), { itemId: 1, requestId: 'r', revision: null });
  const blk = sc.entries().find((e) => e.kind === 'code-block');
  check('S2-struct', '四波浪线围栏+含空格语言串：完整源块可用且 lang 原样', blk && blk.available && blk.lang === 'typescript-react lang=x' && src.slice(blk.start, blk.end) === '~~~~typescript-react lang=x\nlet a=1;\n~~~~', JSON.stringify(blk));
  // 列表内围栏：完整源块可用、payload 因缩进前缀不可用
  const src2 = '- 项\n  ```js\n  x=1\n  ```\n';
  const sc2 = NS.build(md(src2), { itemId: 2, requestId: null, revision: null });
  const b2 = sc2.entries().find((e) => e.kind === 'code-block');
  const p2 = sc2.entries().find((e) => e.kind === 'code-payload');
  check('S2-struct', '列表内围栏：完整源块（含缩进）可用', b2 && b2.available && src2.slice(b2.start, b2.end) === '  ```js\n  x=1\n  ```', JSON.stringify(b2));
  check('S2-struct', '列表内围栏：payload 显式不可用（行前缀）', p2 && p2.available === false && p2.reason === '行前缀使内文非连续源切片', JSON.stringify(p2));
  // 表格相邻段落：章节切分不被表格阻断（fx4 已覆盖 H1-H1 跨表格；这里补表格前后段落文本）
  const src3 = '# H\n\n前段。\n\n| a |\n|---|\n| 1 |\n\n后段。\n';
  const sc3 = NS.build(md(src3), { itemId: 3, requestId: null, revision: null });
  const s3 = sc3.entries().find((e) => e.kind === 'section');
  check('S2-struct', '表格相邻：唯一章节覆盖到 EOF 且含表格', s3 && s3.end === src3.length && src3.slice(s3.start, s3.end) === src3);
  // 空源
  const sc4 = NS.build(md(''), { itemId: 4, requestId: null, revision: null });
  check('S2-struct', '空源：可用映射+零条目（不猜结构）', sc4.entries().length === 0 && sc4.sourceLength() === 0, JSON.stringify(sc4.entries()));
  // 尾随空白与末行无换行（fx1/fx3 已覆盖；此处补：仅空白源）
  const sc5 = NS.build(md('   \n\n'), { itemId: 5, requestId: null, revision: null });
  check('S2-struct', '纯空白源：零结构条目、源长度如实', sc5.entries().length === 0 && sc5.sourceLength() === 5);
  // 组合字符（combining）与 CJK：slice 不做任何规范化
  const combo = '# é\n\n`e\u0301 x`\n';
  const sc6 = NS.build(md(combo), { itemId: 6, requestId: null, revision: null });
  const inlineCode = combo.includes('e\u0301');
  check('S2-struct', '组合字符：canonical 原样（不做 NFC/NFD）', inlineCode && sc6.sourceLength() === combo.length);
  // original CRLF 与 canonical LF：区间只对 canonical（fx4 已全面覆盖，此处断言 availability 不看 original）
  const crlf = '# A\r\n\r\ntext\r\n';
  const canon = sb.canonicalNewlines(crlf);
  const sc7 = NS.build(md(canon), { itemId: 7, requestId: null, revision: null });
  const s7 = sc7.entries().find((e) => e.kind === 'section');
  check('S2-struct', 'CRLF→canonical：区间落在 LF 形态（不为 original 提供偏移）', s7 && s7.start === 0 && s7.end === canon.length && canon.length < crlf.length);
}

// ---------- S3：格式资格门（不猜格式；HTML/legacy/plain/bytes 显式 Unavailable） ----------
{
  const looks = '# 看起来是 Markdown\n\n```js\nx=1\n```\n';
  const legacy = { format: 'plain', provenance: 'legacy', mode: 'plain', renderable: true, text: looks };
  const a1 = NS.availability(legacy);
  check('S3-gate', 'legacy 像 Markdown 也不猜：Unavailable', a1.available === false && /不猜/.test(a1.reason), JSON.stringify(a1));
  const sc1 = NS.build(legacy, { itemId: null, requestId: null, revision: null });
  check('S3-gate', 'legacy sidecar：零条目+check 恒 false+slice 拒绝', sc1.entries().length === 0 && sc1.check(legacy) === false && sc1.slice(1, legacy).ok === false);
  const html = { format: 'html', provenance: 'declared', mode: 'html', renderable: true, text: '<p>x</p>' };
  const a2 = NS.availability(html);
  check('S3-gate', '声明 HTML：显式 Unavailable（不从清洗后 DOM 反推）', a2.available === false && /HTML/.test(a2.reason), JSON.stringify(a2));
  const bytes = { format: 'plain', provenance: 'declared', mode: 'plain', renderable: false, reason: '二进制原文：不能按 plain 文本渲染（不猜 charset）' };
  const a3 = NS.availability(bytes);
  check('S3-gate', 'bytes/不可渲染：Unavailable 透传原因', a3.available === false && a3.reason === bytes.reason);
  const nomd = { format: 'markdown', provenance: 'declared', mode: 'markdown', renderable: true, text: '# X\n' };
  check('S3-gate', '声明 Markdown：Available', NS.availability(nomd).available === true);
}

// ---------- S4：sidecar 接口与不可变（rich-text.js 挂/取 + 冻结） ----------
{
  const decision = md('# A\n\n```\nx\n```\n');
  const fakeEl = {};
  fakeEl.__nayanDecision = decision;
  fakeEl.__nayanIdentity = {itemId:9,requestId:'r9',revision:null};
  const sc = NS.build(decision, { itemId: 9, requestId: 'r9', revision: null });
  check('S4-sidecar', 'setReaderSidecar：合法挂载', sb.setReaderSidecar(fakeEl, sc) === true && fakeEl.__nayanSourceMap === sc);
  check('S4-sidecar', 'readerSidecarOf：同 decision 可取', sb.readerSidecarOf(fakeEl) === sc);
  // 决策换内容 → 访问拒绝（旧 map 不能给新内容切片）
  const other = md('# A\n\n```\ny\n```\n');
  fakeEl.__nayanDecision = other;
  check('S4-sidecar', 'decision 换内容：readerSidecarOf 返回 null（防串用②）', sb.readerSidecarOf(fakeEl) === null);
  check('S4-sidecar', '旧 sidecar.slice 对新 decision 拒绝', sc.slice(sc.entries()[0].id, other, fakeEl.__nayanIdentity).ok === false);
  fakeEl.__nayanDecision = decision;
  fakeEl.__nayanIdentity = {itemId:9,requestId:'r9',revision:null};
  check('S4-sidecar', '恢复原 decision：可再取', sb.readerSidecarOf(fakeEl) === sc);
  // 冻结：篡改条目字段不可生效
  const ent = sc.entries()[0];
  let threw = false;
  try { ent.start = 99999; } catch (e) { threw = true; }
  check('S4-sidecar', '条目 Object.freeze：篡改无效（抛错或静默不变）', ent.start !== 99999, `start=${ent.start} threw=${threw}`);
  let threw2 = false;
  try { sc.entries().length = 0; } catch (e) { threw2 = true; }
  check('S4-sidecar', 'entries 数组冻结：length 不可改', sc.entries().length !== 0);
  // matches：三项身份
  check('S4-sidecar', 'matches：全对才 true', sc.matches({ itemId: 9, requestId: 'r9', revision: null }, decision.text) === true
    && sc.matches({ itemId: 10, requestId: 'r9', revision: null }, decision.text) === false
    && sc.matches({ itemId: 9, requestId: 'r8', revision: null }, decision.text) === false
    && sc.matches({ itemId: 9, requestId: 'r9', revision: null }, decision.text + ' ') === false
    && sc.matches({ itemId: 9, requestId: null, revision: null }, decision.text) === false);
  // revision 如实 null
  check('S4-sidecar', 'identity.revision 恒 null（本批无版本号，不虚构）', sc.identity().revision === null);
}

// ---------- S5：必败负例门（每类目标错误独立注入后必须失败；干净对照先行） ----------
// 方法：构造与真 sidecar 同形的「被篡改对象」，跑与 S1 相同的校验逻辑；
// 断言校验确实拒绝（= 若 mapper/数据出现该类错误，本套件不会放行）。
{
  const src = '# 甲\n\n```js\ncode\n```\n';
  const decision = md(src);
  const real = NS.build(decision, { itemId: 1, requestId: 'r', revision: null });
  const realEnt = real.entries().find((e) => e.kind === 'code-block');

  // 校验器（与 S1 同口径的独立判定；对「假 sidecar」数据做区间+切片一致性检查）
  function validateEntry(scLike, ent, sourceText, expectedSlice) {
    if (!(ent.start >= 0 && ent.end >= ent.start && ent.end <= sourceText.length)) return false;
    return sourceText.slice(ent.start, ent.end) === expectedSlice;
  }
  const expectedSlice = src.slice(realEnt.start, realEnt.end);

  // 干净对照：真实条目必须先过
  check('S5-neg', '干净对照：真实条目通过校验', validateEntry(real, realEnt, src, expectedSlice) === true);

  // N1 范围错一位
  const off1 = { ...realEnt, start: realEnt.start + 1 };
  check('S5-neg', 'N1 off-by-one 必败', validateEntry(real, off1, src, expectedSlice) === false);
  // N2 越界
  const oob = { ...realEnt, end: src.length + 5 };
  check('S5-neg', 'N2 越界必败', validateEntry(real, oob, src, expectedSlice) === false);
  // N3 同长度异文（同长源、同区间号、不同内容）
  const sameLenDiff = src.replace('code', 'differ'.slice(0, 4));
  check('S5-neg', 'N3 前置：同长度异文构造成立', sameLenDiff.length === src.length && sameLenDiff !== src);
  check('S5-neg', 'N3 同长度异文必败（切片不等）', src.slice(realEnt.start, realEnt.end) === sameLenDiff.slice(realEnt.start, realEnt.end) ? false : true);
  const scB = NS.build(md(sameLenDiff), { itemId: 1, requestId: 'r', revision: null });
  const entB = scB.entries().find((e) => e.kind === 'code-block');
  check('S5-neg', 'N3 新内容的 sidecar 各自成图（旧区间号不跨用）', entB && entB.start === realEnt.start && scB.slice(entB.id, md(src), scB.identity()).ok === false);
  // N4 跨条目身份：旧 map 对新条目身份/内容
  check('S5-neg', 'N4 跨条目：matches 拒绝', real.matches({ itemId: 2, requestId: 'r', revision: null }, src) === false && real.matches({ itemId: 1, requestId: 'r', revision: null }, sameLenDiff) === false);
  // N5 可变字段篡改：伪造 available/end 的假条目必须被边界+切片校验拒
  const forged = { ...realEnt, available: true, end: src.length + 1 };
  check('S5-neg', 'N5 篡改 end：边界校验必败', validateEntry(real, forged, src, expectedSlice) === false);
  const forged2 = { ...realEnt, start: 0, end: src.length };
  check('S5-neg', 'N5 篡改区间为全源：切片校验必败（slice≠期望）', validateEntry(real, forged2, src, expectedSlice) === false);
  // 真实 sidecar 对不存在条目 id
  check('S5-neg', '不存在条目 id：slice 拒绝', real.slice(99999, decision, real.identity()).ok === false);
}

// ---------- R1: independent same-text identity and empty-range counterexamples ----------
{
  const source = '# Same answer\n\n```js\nconst x = 1;\n```\n';
  const decision = md(source), a = {itemId:101,requestId:'A',revision:null};
  const real = NS.build(decision,a), entry = real.entries().find(e=>e.kind==='code-block');
  const contexts = [
    {itemId:202,requestId:'B',revision:null},
    {itemId:202,requestId:'A',revision:null},
    {itemId:101,requestId:'A',revision:1},
    {itemId:'101',requestId:'A',revision:null},
    null,
  ];
  for (const identity of contexts) {
    const el = {__nayanDecision:decision,__nayanIdentity:identity};
    check('R1-identity', 'same text changed context: mount rejects '+JSON.stringify(identity), sb.setReaderSidecar(el,real)===false);
    el.__nayanSourceMap=real; el.__nayanSidecarCache=real;
    check('R1-identity', 'same text changed context: getter rejects '+JSON.stringify(identity), sb.readerSidecarOf(el)===null);
    check('R1-identity', 'same text changed context: slice rejects '+JSON.stringify(identity), real.slice(entry.id,decision,identity).ok===false);
  }
  check('R1-identity','same context positive and omitted identity negative',real.slice(entry.id,decision,a).ok===true && real.slice(entry.id,decision).ok===false);
  const draft={itemId:null,requestId:'draft',revision:null}, ds=NS.build(decision,draft);
  check('R1-identity','valid draft positive; null vs string null rejects',!ds.__unavailable && !ds.matches({...draft,itemId:'null'},source));
  check('R1-identity','missing identity unavailable',NS.build(decision,null).__unavailable===true);
  for (const invalid of [{...decision,provenance:'legacy'},{...decision,format:'plain'},{...decision,text:12}]) {
    check('R1-qualification','contradictory format/provenance/text rejects',NS.availability(invalid).available===false && real.slice(entry.id,invalid,a).ok===false);
  }
  // Handwritten UTF-16 expected positions, not derived from mapper output.
  const fences=[['```\n```',4,4],['```\n```\n',4,4],['~~~js\n~~~\n',6,6],['```js\n\n```\n',6,6]];
  for(const [text,start,end] of fences){
    const d=md(text),sc=NS.build(d,a),pay=sc.entries().find(e=>e.kind==='code-payload');
    check('R1-empty','empty payload '+JSON.stringify(text),pay.available && pay.start===start && pay.end===end && sc.slice(pay.id,d,a).text==='');
  }
  for(const text of ['```','```js\nx','````js\nx\n````','> ```\n> \n> ```\n','```\r\n```\r\n']) {
    const canonical=sb.canonicalNewlines(text),sc=NS.build(md(canonical),a);
    check('R1-range','all published Available boundaries valid '+JSON.stringify(text),sc.entries().every(e=>!e.available || Number.isInteger(e.start)&&Number.isInteger(e.end)&&0<=e.start&&e.start<=e.end&&e.end<=canonical.length));
  }
}

// ---------- 输出 ----------
const data = { total: results.length, pass: results.length - fail, fail, results };
fs.writeFileSync(path.join(outDir, 'source-map-results.json'), JSON.stringify(data, null, 2));
console.log(`source-map: ${data.pass}/${data.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
