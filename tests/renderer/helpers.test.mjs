// tests/renderer/helpers.test.mjs —— P1-T05 字符串层 helper 套件（无 DOM）
// 检验对象：app/ui/rich-text.js 的 canonicalNewlines / readerBody 纯函数。
// 期望值来源：tests/content/golden（Rust 产出，独立于 JS 实现）+ 文档化规则边界。
// 用法：node tests/renderer/helpers.test.mjs [--out DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadGoldens, rendererExtras, synthEnvelope, REPO } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out') || fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-helpers-'));
fs.mkdirSync(outDir, { recursive: true });

// 载入被测源（rich-text.js 是经典脚本，vm 沙箱里给出 esc 所需的最小 document 桩）
const src = fs.readFileSync(path.join(REPO, 'app', 'ui', 'rich-text.js'), 'utf8');
const sandbox = { document: { createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return String(this._t == null ? '' : this._t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { canonicalNewlines, readerBody } = sandbox;

const results = [];
let fail = 0;
function check(caseName, name, ok, detail = '') {
  results.push({ case: caseName, name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${name}${ok ? '' : '  <<< ' + detail}`);
}
const cps = (s) => [...s];

// ---------- H1：canonicalNewlines 与 Rust golden 逐字符一致 ----------
const goldens = loadGoldens().filter((g) => g.canonical != null);
for (const g of goldens) {
  const got = canonicalNewlines(g.originalText);
  const ok = got === g.canonical;
  let firstDiff = '';
  if (!ok) {
    const a = cps(got), b = cps(g.canonical);
    let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    firstDiff = `len ${a.length} vs ${b.length}, first diff @cp ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
  }
  check('H1-golden', `${g.name}: canonicalNewlines(原文)===Rust canonical`, ok, firstDiff);
}
// 幂等 + 边界
check('H1-boundary', '幂等 canonicalNewlines(canonicalNewlines(x))===canonicalNewlines(x)',
  ['a\r\nb\rc', '', '\r', '\r\n\r\n', 'x\ny'].every((x) => canonicalNewlines(canonicalNewlines(x)) === canonicalNewlines(x)));
check('H1-boundary', '\\n 原样不动（不产生双重规范化）', canonicalNewlines('a\nb') === 'a\nb');
check('H1-boundary', 'null/undefined → 空串（不抛错）', canonicalNewlines(null) === '' && canonicalNewlines(undefined) === '');

// ---------- H2：readerBody 分派矩阵 ----------
for (const g of loadGoldens()) {
  const r = readerBody(g.envelope, g.originalText || '');
  if (g.binary) {
    check('H2-dispatch', `${g.name}: bytes 原文 → renderable=false + 原因`, !r.renderable && !!r.reason, JSON.stringify(r));
    continue;
  }
  const ok = r.renderable && r.text === g.canonical
    && r.format === (g.legacy ? 'plain' : g.format)
    && r.provenance === (g.legacy ? 'legacy' : 'declared');
  check('H2-dispatch', `${g.name}: 信封分派 → format=${g.format}${g.legacy ? '(legacy)' : ''} text===canonical`,
    ok, JSON.stringify({ format: r.format, provenance: r.provenance, renderable: r.renderable }));
}
// legacy（无信封）
{
  const ex = rendererExtras()[4]; // x05 legacy-looks-md
  const r = readerBody(null, ex.original);
  check('H2-legacy', 'legacy 无信封 → plain/legacy + canonical 口径', r.renderable && r.format === 'plain' && r.provenance === 'legacy' && r.text === ex.canonical, JSON.stringify(r));
  const rEmpty = readerBody(null, undefined);
  check('H2-legacy', 'legacy 空正文 → 空串不抛错', rEmpty.renderable && rEmpty.text === '');
}
// markdown 声明：本批按 plain 原样显示（不解释）
{
  const g = loadGoldens().find((x) => x.format === 'markdown');
  const r = readerBody(g.envelope, '');
  check('H2-markdown', '声明 markdown（本批）→ 原样 canonical 文本、无结构化重排', r.renderable && r.text === g.canonical, JSON.stringify({ head: r.text.slice(0, 20) }));
}
// html 声明：canonical 可用（文本型原文）→ 显示 html 源码文本
{
  const g = loadGoldens().find((x) => x.format === 'html');
  const r = readerBody(g.envelope, '');
  check('H2-html', '声明 html → 显示 canonical 源码文本（不执行）', r.renderable && r.text === g.canonical, JSON.stringify({ len: r.text && r.text.length }));
}
// 派生值缺失降级链：canonical 缺 → plain_projection → original.text
{
  const env = synthEnvelope('line1\r\nline2', 'req-degrade');
  const noCanonical = { ...env, canonical: undefined };
  const r1 = readerBody(noCanonical, '');
  check('H2-degrade', 'canonical 缺 → 用 plain_projection（同口径）', r1.renderable && r1.text === 'line1\nline2');
  const noProj = { ...env, canonical: undefined, plain_projection: { status: 'unavailable', reason: 'x' } };
  const r2 = readerBody(noProj, '');
  check('H2-degrade', 'canonical+投影均缺 → 用 original.text 并规范化', r2.renderable && r2.text === 'line1\nline2');
  const noAll = { ...env, canonical: undefined, plain_projection: { status: 'unavailable', reason: 'x' }, original: { kind: 'text', text: 'raw\rline' } };
  check('H2-degrade', 'original 兜底也做换行规范化', readerBody(noAll, '').text === 'raw\nline');
}
// 未知格式串：分派不炸，按声明路径处理（format 透传）
{
  const env = { ...synthEnvelope('abc', 'req-unknown'), format: 'future_format' };
  const r = readerBody(env, '');
  check('H2-unknown-fmt', '未知格式值 → 不抛错、format 透传、文本可用', r.renderable && r.format === 'future_format' && r.text === 'abc', JSON.stringify(r));
}

// ---------- H3：渲染器特有边界的字符串层期望 ----------
for (const ex of rendererExtras()) {
  const got = canonicalNewlines(ex.original);
  check('H3-extras', `${ex.name}: canonicalNewlines === 期望`, got === ex.canonical, JSON.stringify(got.slice(0, 60)));
  const r = readerBody(synthEnvelope(ex.original, 'req-' + ex.name), '');
  check('H3-extras', `${ex.name}: 信封分派文本 === 期望`, r.renderable && r.text === ex.canonical);
}

// ---------- 汇总落盘 ----------
const summary = { suite: 'helpers', total: results.length, pass: results.length - fail, fail, at: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, 'helpers-results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\nhelpers.test.mjs: ${summary.pass}/${summary.total} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
