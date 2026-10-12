// tests/roundtrip/offline-guards.test.mjs — P1-T06-T07-REPAIR-01 第2步组②+组④（全离线）。
// 组②：从真实 index.html 逐字抽取 copyContextFor + copyorig 异步守卫分支，VM 执行真实代码，
//   在途换代/上下文替换负例必须零写入+取消 toast（R1 copy-race-probe 方法应用于修复后代码）。
// 组④：harness 负例——preflightOut 范围/非空拒绝、archive 单写、ledger 无归档拒绝（childStarted:0）。
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import { parseArgs, preflightOut } from '../renderer/nayan-reader-view/preflight-lib.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const B = path.join(REPO, 'docs/implementation-plan-2026-09-23/batches/P1-T06-T07-REPAIR-01');
const { '--out': outDir } = parseArgs(process.argv.slice(2), { '--out': 'value' });
preflightOut(outDir, REPO); fs.mkdirSync(outDir, { recursive: true });
const results = []; let fail = 0;
function check(name, ok, detail = '') { ok = ok === true; results.push({ name, ok, detail }); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <<< ' + String(detail).slice(0, 240)}`); }

// ===== 组②：VM 真实守卫 =====
const html = fs.readFileSync(path.join(REPO, 'app/ui/index.html'), 'utf8');
const a1 = html.indexOf('function copyContextFor(it){');
const a2 = html.indexOf('function fillReaderBody(el, r){');
if (a1 < 0 || a2 <= a1) throw new Error('copyContextFor anchor');
const ctxFn = html.slice(a1, a2);
const b1 = html.indexOf("        var copOrigStart={read:ctxO.readSeq");
const b2 = html.indexOf('}).catch(function(e){ toast(\'原文读取失败：\'+((e&&e.message)||String(e))); });');
if (b1 < 0 || b2 <= b1) throw new Error('copyorig async anchor');
const guardCode = html.slice(b1, b2 + '}).catch(function(e){ toast(\'原文读取失败：\'+((e&&e.message)||String(e))); });'.length);
function runGuardCase(kind) {
  const toasts = []; const sink = [];
  const el = { __nayanReaderRead: 1, __nayanCopy: null, __nayanDecision: null, __nayanIdentity: null };
  const decision = { format: 'plain', provenance: 'declared', mode: 'plain', renderable: true, text: 'new\r\ntext'.replace(/\r\n?/g, '\n') };
  const identity = { itemId: 7, requestId: 'req-g', revision: null };
  const ctx = { readSeq: 1, identity, decision, originalKind: 'text', legacy: false };
  el.__nayanCopy = ctx; el.__nayanDecision = decision; el.__nayanIdentity = identity;
  const sandbox = {
    state: { sel: 7 }, toasts, sink,
    document: { body: { contains: () => true } },
    gid: () => el,
    toast: (m) => toasts.push(String(m)),
    copyContextFor: null, // 由注入的真实函数体定义
    copyOriginalPayload: () => ({ ok: true, payload: 'should-not-be-used-here' }),
    copyOriginalOk: (btn, p) => sink.push(p),
    btn: {},
    it: { id: 7, quote: '' }, ctxO: null, cc: null,
    api: (m, u) => new Promise((res) => { sandbox.__resolve = res; }),
  };
  vm.createContext(sandbox);
  vm.runInNewContext(ctxFn + '\nglobalThis.__realCopyContextFor = copyContextFor;', sandbox);
  vm.runInNewContext('cc = __realCopyContextFor(it); ctxO = cc.ctx;', sandbox);
  if (sandbox.cc.ok !== true) return { kind, error: 'context-setup-failed', toasts, sink };
  vm.runInNewContext(['(function(){',guardCode,'})()'].join(String.fromCharCode(10)), sandbox); /* handler 内 return → 函数包裹 */
  // 场景变异（在 /content 未决时）
  if (kind === 'gen-change') { el.__nayanReaderRead = 2; el.__nayanCopy = { ...ctx, readSeq: 2 }; }
  if (kind === 'decision-change') { const d2 = { ...decision, text: 'other' }; el.__nayanDecision = d2; el.__nayanCopy = { ...ctx, decision: d2 }; }
  if (kind === 'el-replaced') { sandbox.gid = () => ({ different: true }); }
  if (kind === 'sel-switch') { sandbox.state.sel = 99; }
  const body = { id: 7, legacy: false, envelope_json: JSON.stringify({ request_id: 'req-g', canonical: decision.text, original: { kind: 'text', text: 'old\r\noriginal' } }) };
  sandbox.__resolve(body);
  return new Promise((done) => setTimeout(() => done({ kind, toasts, sink }), 60));
}
const normal = await runGuardCase('normal');
check('组② 正常：迟到前后文一致→写出 original', normal.sink.length === 1 && normal.sink[0] === 'old\r\noriginal', JSON.stringify(normal).slice(0, 160));
for (const kind of ['gen-change', 'decision-change', 'el-replaced', 'sel-switch']) {
  const c = await runGuardCase(kind);
  check(`组② ${kind}：在途变化→零写入+取消 toast`, c.sink.length === 0 && c.toasts.some((t) => /已变化/.test(t)), JSON.stringify(c).slice(0, 160));
}

// ===== 组④：harness 负例（全离线 node） =====
let threw = null; try { preflightOut(path.join(outDir, 'nested-nope'), '/etc'); } catch (e) { threw = String(e); }
check('组④ preflightOut 范围外拒绝', /must be inside|refused/i.test(threw || ''), threw);
fs.mkdirSync(path.join(outDir, 'nonempty'), { recursive: true }); fs.writeFileSync(path.join(outDir, 'nonempty', 'x'), 'x');
let threw2 = null; try { preflightOut(path.join(outDir, 'nonempty'), REPO); } catch (e) { threw2 = String(e); }
check('组④ preflightOut 非空拒绝', /nonempty.*refused/i.test(threw2 || ''), threw2);
{ // archive 单写：重复 label 拒绝
  const r = spawnSync('node', [path.join(B, 'harness/archive-src.mjs'), '--out', path.join(B, 'evidence/src-archive'), '--file', 'harness/step1-freeze.mjs', '--label', 'step1-freeze-v1', '--for', 'dup-test', '--argv', '["node","x"]', '--cmd', 'dup'], { cwd: REPO, encoding: 'utf8' });
  check('组④ archive label 单写（重复拒绝）', r.status !== 0 && /already exists/.test(r.stderr || ''), (r.stderr || '').slice(0, 120));
}
{ // ledger 无归档 .mjs 拒绝：childStarted=0
  const dummy = path.join(outDir, 'no-archive-dummy.mjs');
  fs.writeFileSync(dummy, 'console.log("never");\n');
  const led = path.join(B, 'evidence/ledger-g4');
  const r = spawnSync('node', [path.join(B, 'harness/ledger.mjs'), '--out', led, '--name', 'g4-refuse-01', '--', 'node', dummy], { cwd: REPO, encoding: 'utf8' });
  const refused = fs.existsSync(path.join(led, 'g4-refuse-01.refused.json')) ? JSON.parse(fs.readFileSync(path.join(led, 'g4-refuse-01.refused.json'), 'utf8')) : null;
  check('组④ ledger 无归档脚本拒绝+零 child', r.status === 3 && refused && refused.childStarted === 0, 'exit=' + r.status + ' refused=' + JSON.stringify(refused && refused.childStarted));
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at_utc: new Date().toISOString(), total: results.length, fail, results }, null, 1));
console.log(`\noffline-guards: ${results.length - fail}/${results.length} PASS`);
process.exit(fail ? 1 : 0);
