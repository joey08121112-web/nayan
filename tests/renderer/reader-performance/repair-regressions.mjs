// tests/renderer/reader-performance/repair-regressions.mjs —— P1-B06-PERF-01-REPAIR-01 / R1-F03+F04
// 固定负例回放（不跑浏览器）：严格性能门、注入归因检测与退出分类的常驻门控单测。
// 全部输入为固定合成对象，与真实测量共用同一 gate.mjs 实现（单一事实源，预算派生不自我背书）。
// 用法：node tests/renderer/reader-performance/repair-regressions.mjs [--out DIR]；任何负例未被拒绝或正常对照被误伤都 exit 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePerformanceGate, detectInjectionAttribution, classifyInjectRun, validateTrial } from './gate.mjs';

const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const outDir = argOf('--out');
const results = [];
let fail = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 300)}`);
}

/* ---------- 合成夹具工厂（shape 与 reader-performance 真实输出一致） ---------- */
/* over.trial：施加于全部试跑（预算负例用）；over.trialAt：仅施加于第 5 例（单项字段负例用） */
const mkFix = (bytes, nTrials = 31, over = {}) => {
  const blocks = bytes === 102400 ? 100 : 1000;
  const trial = (o = {}) => ({ status: 'rendered', rendered: true, identityOk: true, bodyTextLen: 500, visibleMs: 100, maxDrift: 20, driftN: 1, samples: [{scheduled: 0, fired: o.maxDrift ?? 20}], entries: blocks * 4, domNodes: 2000, ...o });
  const trials = [];
  for (let i = 0; i < nTrials; i++) {
    const o = Object.assign({}, over.trial || {});
    if (i === 5) Object.assign(o, over.trialAt || {});
    trials.push(trial(o));
  }
  return { label: `synthetic-${bytes}`, bytes, blocks,
    counts: { headings: blocks * 2, fences: blocks, entries: blocks * 4 },
    cold: trials[0], warm: {}, trials, ...over.fixture || {} };
};

/* ---------- R1-F03：严格预算门 ---------- */
check('F03 干净对照 ordinary-100KiB（100ms/20ms）通过', evaluatePerformanceGate([mkFix(102400)]).gateFail === 0);
check('F03 干净对照 ordinary-1MiB（100ms/20ms）通过（含阻塞门）', evaluatePerformanceGate([mkFix(1048576)]).gateFail === 0);
{
  const r = evaluatePerformanceGate([mkFix(102400, 31, { trial: { visibleMs: 300 } })]);
  check('F03 负例 100KiB/warm p95=300ms 必失败（旧实现漏检点）', r.gateFail >= 1 && r.failures.some((x) => x.includes('visible-budget')), JSON.stringify(r.failures));
}
{
  const r = evaluatePerformanceGate([mkFix(1048576, 31, { trial: { maxDrift: 150 } })]);
  check('F03 负例 1MiB/全部采样 maxDrift=150ms 必失败（旧实现整门跳过点）', r.gateFail >= 1 && r.failures.some((x) => x.includes('input-blocking-budget')), JSON.stringify(r.failures));
}
{
  const f = mkFix(102400); delete f.bytes;
  const r = evaluatePerformanceGate([f]);
  check('F03 负例 bytes 缺失必显式失败', r.gateFail >= 1 && r.failures.some((x) => x.includes('bytes-missing')), JSON.stringify(r.failures));
}
{
  const r = evaluatePerformanceGate([mkFix(999999)]);
  check('F03 负例 bytes 未知长度(999999)必失败', r.gateFail >= 1 && r.failures.some((x) => x.includes('bytes-unknown')), JSON.stringify(r.failures));
}
{
  const r = evaluatePerformanceGate([mkFix(102400, 0)]);
  check('F03 负例 空 trials 必失败', r.gateFail >= 1 && r.failures.some((x) => x.includes('trials-missing')), JSON.stringify(r.failures));
}
{
  const f = mkFix(102400, 31, { trialAt: { visibleMs: NaN } });
  const r = evaluatePerformanceGate([f]);
  check('F03 负例 NaN visibleMs 必失败', r.gateFail >= 1 && r.failures.some((x) => x.includes('not-finite')), JSON.stringify(r.failures));
}
for (const st of ['pending', 'failed', 'cancelled']) {
  const f = mkFix(102400, 31, { trialAt: { status: st, rendered: false } });
  const r = evaluatePerformanceGate([f]);
  check(`F03 负例 trial status=${st} 必失败`, r.gateFail >= 1 && r.failures.some((x) => x.includes('not-rendered')), JSON.stringify(r.failures));
}
{
  const f = mkFix(102400, 31, { trialAt: { driftN: 0 } });
  const r = evaluatePerformanceGate([f]);
  check('F03 负例 采样为空(driftN=0) 必失败', r.gateFail >= 1 && r.failures.some((x) => x.includes('drift-samples-empty')), JSON.stringify(r.failures));
}
{
  const f = mkFix(102400, 31, { trialAt: { entries: 399 } });
  const r = evaluatePerformanceGate([f]);
  check('F03 负例 entries 数不符必失败', r.gateFail >= 1 && r.failures.some((x) => x.includes('entries')), JSON.stringify(r.failures));
}
{
  const f = mkFix(102400); f.counts = { headings: 1, fences: 1, entries: 400 };
  const r = evaluatePerformanceGate([f]);
  check('F03 负例 结构计数不符必失败', r.gateFail >= 1 && r.failures.some((x) => x.includes('structure-counts')), JSON.stringify(r.failures));
}
{
  const f = mkFix(1048576, 31, { trial: { visibleMs: 1200 } });
  const r = evaluatePerformanceGate([f]);
  check('F03 已知密集失败形态（1MiB/1200ms）如实失败（不放宽）', r.gateFail >= 1 && r.failures.some((x) => x.includes('visible-budget')), JSON.stringify(r.failures));
}

/* ---------- R1-F04：注入归因检测 ---------- */
const s = (scheduled, fired) => ({ scheduled, fired });
check('F04 归因正例：样本横跨注入窗口 → caught', detectInjectionAttribution([s(0, 10), s(10, 260), s(260, 270)], 50, 200).caught === true,
  JSON.stringify(detectInjectionAttribution([s(0, 10), s(10, 260), s(260, 270)], 50, 200)));
{
  const r = detectInjectionAttribution([s(0, 10), s(250, 400)], 50, 200);   // 噪声块都在注入窗口之外
  check('F04 负例 高背景噪声但无样本覆盖注入窗口 → 不算捕获（旧 caught 逻辑会误报）', r.caught === false, JSON.stringify(r));
}
{
  const r = detectInjectionAttribution([s(100, 260)], 50, 200);
  check('F04 负例 样本仅覆盖后半窗口（scheduled>injStart）→ 不算捕获', r.caught === false, JSON.stringify(r));
}
{
  const r = detectInjectionAttribution([], 50, 200);
  check('F04 负例 观察器无样本（漏记注入）→ 不算捕获', r.caught === false && r.reason === 'no-samples', JSON.stringify(r));
}
{
  const r = detectInjectionAttribution([s(0, 300)], NaN, 200);
  check('F04 负例 注入窗口不完整 → 不算捕获', r.caught === false && r.reason === 'invalid-injection-window', JSON.stringify(r));
}

/* ---------- R1-F04：退出分类 ---------- */
const cls = (o) => classifyInjectRun(o);
check('F04 分类 完整成功 → 3', cls({ thrown: null, controlValid: true, controlGatePassed: true, injectedValid: true, attributed: true, evidenceWritten: true, cleanupOk: true }).code === 3);
check('F04 分类 异常 → 1（不被成功码冒充）', cls({ thrown: new Error('x'), controlValid: true, controlGatePassed: true, injectedValid: true, attributed: true, evidenceWritten: true, cleanupOk: true }).code === 1);
check('F04 分类 证据写失败 → 4', cls({ thrown: null, controlValid: true, controlGatePassed: true, injectedValid: true, attributed: true, evidenceWritten: false, cleanupOk: true }).code === 4);
check('F04 分类 清理失败 → 5（旧实现仍 exit3 的反例）', cls({ thrown: null, controlValid: true, controlGatePassed: true, injectedValid: true, attributed: true, evidenceWritten: true, cleanupOk: false }).code === 5);
check('F04 分类 对照污染/无效 → 6', cls({ thrown: null, controlValid: false, controlGatePassed: true, injectedValid: true, attributed: true, evidenceWritten: true, cleanupOk: true }).code === 6);
check('F04 分类 对照自身未过门 → 6', cls({ thrown: null, controlValid: true, controlGatePassed: false, injectedValid: true, attributed: true, evidenceWritten: true, cleanupOk: true }).code === 6);
check('F04 分类 观察器盲区 → 7', cls({ thrown: null, controlValid: true, controlGatePassed: true, injectedValid: true, attributed: false, evidenceWritten: true, cleanupOk: true }).code === 7);
check('F04 分类 attributed 未知 → 1（不静默成功）', cls({ thrown: null, controlValid: true, controlGatePassed: true, injectedValid: true, attributed: undefined, evidenceWritten: true, cleanupOk: true }).code === 1);

// R2: every corruption starts from an otherwise complete, passing trial.
for (const key of ['identityOk','bodyTextLen','samples','driftN','visibleMs','maxDrift','entries','domNodes']) {
  const f=mkFix(102400); delete f.trials[5][key];
  check('R2 missing '+key+' rejected',evaluatePerformanceGate([f]).gateFail>0);
}
for (const [key,value] of [['identityOk',false],['bodyTextLen',0],['samples',[]],['visibleMs',-1],['maxDrift',-1],['driftN',2],['samples',[{scheduled:5,fired:4}]],['samples',[{scheduled:0,fired:NaN}]]]) {
  const f=mkFix(102400);f.trials[5][key]=value;
  check('R2 corrupt '+key+' '+JSON.stringify(value)+' rejected',evaluatePerformanceGate([f]).gateFail>0);
}
check('R2 short injection window never captured',detectInjectionAttribution([s(10,10)],10,11).caught===false);
const complete={thrown:null,controlValid:true,controlGatePassed:true,injectedValid:true,attributed:true,evidenceWritten:true,cleanupOk:true};
for (const key of ['controlValid','controlGatePassed','injectedValid','attributed','evidenceWritten','cleanupOk']) {
  for (const value of [undefined,null,'true']) {
    check('R2 classification '+key+'='+String(value)+' never3',cls({...complete,[key]:value}).code!==3);
  }
}
check('R2 injected failure never3',cls({...complete,injectedValid:false}).code===9);
// Read-only historical replay is not a fresh timing run.
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
for(const name of ['A','B']) {
  const old=JSON.parse(fs.readFileSync(path.join(repo,'docs/implementation-plan-2026-09-23/batches/P1-B06-PERF-01-REPAIR-01/evidence/performance-attempt-'+name+'/reader-performance.json'),'utf8'));
  check('R2 historical '+name+' rows still complete',old.fixtures.every(f=>f.trials.every(t=>validateTrial(t,f.blocks*4)===null)));
  const gate=evaluatePerformanceGate(old.fixtures);
  check('R2 historical '+name+' performance failures retained',gate.gateFail===3&&gate.failures.every(x=>/visible-budget|input-blocking-budget/.test(x)),JSON.stringify(gate));
}

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'repair-regressions-results.json'), JSON.stringify({ at_utc: new Date().toISOString(), total: results.length, pass: results.length - fail, fail, results, cwd: process.cwd(), argv: process.argv }, null, 2));
}
console.log(`repair-regressions: ${results.length - fail}/${results.length} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
