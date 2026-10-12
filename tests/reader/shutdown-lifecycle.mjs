#!/usr/bin/env node
// tests/reader/shutdown-lifecycle.mjs —— R3-F03/R4-F02 退出语义生命周期测试。
//
// 从当前 launcher.mjs 原样提取 safeWriteInRoot/cleanRoot/isInside/markerOwner/rejectInputAliases
// 与 shutdown 块（含 R4 修复标记自检），驱动真实受控 Node 子进程。六例：
//   timeout        忽略 SIGTERM → 4s 超时 SIGKILL → exit≠0、clean=false、sigkill-timeout、root/scratch 保留
//   normal-keep    优雅 exit(0)（--keep）      → exit=0、clean=true、root 保留（记录可读）
//   normal-cleanup 优雅 exit(0)（非 --keep）    → exit=0、root 四校验清理
//   ev-fail        证据目标被符号链接占位        → exit≠0、root 保留、诊断输出、sentinel 原样
//   exit42         SIGTERM handler 里 exit(42) → exit≠0、clean=false、abnormal-exit-42、root/scratch 保留
//   ext-sigkill    handler 自身 SIGKILL（非计时器）→ exit≠0、clean=false、abnormal-signal-SIGKILL、root/scratch 保留
//
// 门控：每例完整 ok 记入 JSON；任何失败 → 进程 exit≠0。
// --gate-negative：把本测试源码副本中 GATE_INJECT_POINT 置 false 运行，验证「FAIL 打印 + 非零退出」
// 的退出门控本身有效（副本用后即删，不改真实断言）。
//
// 用法：node tests/reader/shutdown-lifecycle.mjs [--out DIR] [--gate-negative]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = process.env.NAYAN_LIFECYCLE_BASE || __dirname; // 门控副本在临时目录运行时经此指回真实目录
const LAUNCHER = path.join(BASE_DIR, 'launcher.mjs');
const SELF = fileURLToPath(import.meta.url);
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(__dirname, '../../docs/implementation-plan-2026-09-23/batches/P0-B01-REPAIR-04/evidence');
fs.mkdirSync(outDir, { recursive: true });

const GATE_INJECT_POINT = /*gate-anchor*/ true; // 门控负例副本把注释锚点后的值换成 false

// ---------- 门控负例：副本强制一项断言失败，应打印 FAIL 且 exit≠0 ----------
if (process.argv.includes('--gate-negative')) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-r4-gate-'));
  const copy = path.join(parent, 'lifecycle-gate-copy.mjs');
  let src = fs.readFileSync(SELF, 'utf8');
  const anchor = '/*gate-anchor*/ true';
  if (!src.includes(anchor)) { console.error('门控标记缺失'); process.exit(2); }
  src = src.split(anchor).join('false'); // 强制 timeout 断言失败（纯注释锚点，不与任何标识符冲突）
  src = src.replace("process.argv.includes('--gate-negative')", 'false'); // 副本不再进入本分支
  fs.writeFileSync(copy, src);
  const r = spawnSync(process.execPath, [copy, '--out', parent], { encoding: 'utf8', timeout: 120000, env: { ...process.env, NAYAN_LIFECYCLE_BASE: __dirname } });
  const printedFail = (r.stdout || '').includes('FAIL');
  const nonzero = r.status !== 0;
  const ok = printedFail && nonzero;
  console.log(`${ok ? 'PASS' : 'FAIL'} gate-negative: 副本强制失败 → 打印FAIL=${printedFail} exit=${r.status}`);
  fs.rmSync(parent, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

const source = fs.readFileSync(LAUNCHER, 'utf8');

function extractFn(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`提取失败：function ${name}`);
  let i = source.indexOf('{', start), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`括号配平失败：${name}`);
}
const SAFE = extractFn('safeWriteInRoot');
const CLEAN = extractFn('cleanRoot');
const ISINSIDE = extractFn('isInside');
const MARKER = extractFn('markerOwner');
const ALIAS = extractFn('rejectInputAliases');
const SHUTDOWN = source.slice(
  source.indexOf('  let shuttingDown = false;'),
  source.indexOf('  await new Promise(() => {});')
);
// 提取点自检：被测代码必须包含 R4 统一判定的关键标记
for (const mark of ['normalEnd', 'sigterm-expected', 'abnormal-exit-', 'exitOk']) {
  if (!SHUTDOWN.includes(mark)) throw new Error(`提取的 shutdown 缺少 R4 标记 ${mark}——提取点失效`);
}

const results = [];
async function driveCase(caseName, { childScript, prepRoot, keep }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-r4-life-'));
  const root = path.join(parent, 'root');
  const scratch = path.join(parent, 'scratch');
  fs.mkdirSync(root); fs.mkdirSync(scratch);
  prepRoot(root);
  const RUN_ID = 'r4-' + caseName;
  const driver = path.join(parent, 'driver.cjs');
  const wiring = `
const { spawn } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
${ALIAS}
${ISINSIDE}
${MARKER}
${SAFE}
${CLEAN}
const MARKER_OWNER = 'nayan-reader-regression';
const PROD_DIRS = [];
function statSnapshot() { return { '/synthetic/prod': { size: 1 } }; }
(async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });
  const keep = ${keep};
  const root = ${JSON.stringify(root)};
  const scratch = ${JSON.stringify(scratch)};
  const RUN_ID = ${JSON.stringify(RUN_ID)};
${SHUTDOWN}
  setTimeout(shutdown, 500);
  await new Promise(() => {});
})();`;
  fs.writeFileSync(driver, wiring);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 30000 });
  const elapsed = (Date.now() - t0) / 1000;
  let runExit = null;
  try { runExit = JSON.parse(fs.readFileSync(path.join(root, 'run-exit.json'), 'utf8')); } catch (_) {}
  const rec = {
    case: caseName,
    launcher_exit: r.status,
    elapsed_seconds: Number(elapsed.toFixed(2)),
    child: runExit ? { code: runExit.code, signal: runExit.signal, stoppedBy: runExit.stoppedBy, clean: runExit.clean } : null,
    root_exists: fs.existsSync(root),
    scratch_exists: fs.existsSync(scratch),
    stdout: (r.stdout || '').trim().slice(0, 200),
    stderr: (r.stderr || '').trim().slice(0, 200),
  };
  results.push(rec);
  fs.rmSync(parent, { recursive: true, force: true });
  return rec;
}
const prepOwned = (run) => (root) => {
  fs.writeFileSync(path.join(root, 'nayan-test-owned.json'), JSON.stringify({ owner: 'nayan-reader-regression', run_id: 'x' }));
  const c = spawnSync('true');
  fs.writeFileSync(path.join(root, 'current-run.json'), JSON.stringify({ run, pid: c.pid }));
};

// A timeout
{
  const rec = await driveCase('timeout', {
    childScript: "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
    prepRoot: prepOwned('r4-timeout'), keep: false,
  });
  const ok = GATE_INJECT_POINT
    && rec.launcher_exit !== 0
    && rec.child && rec.child.clean === false && rec.child.stoppedBy === 'sigkill-timeout'
    && rec.root_exists === true && rec.scratch_exists === true;
  rec.ok = ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} timeout: exit=${rec.launcher_exit} clean=${rec.child && rec.child.clean} stoppedBy=${rec.child && rec.child.stoppedBy} root=${rec.root_exists} scratch=${rec.scratch_exists} ${rec.elapsed_seconds}s`);
}
// B normal-keep
{
  const rec = await driveCase('normal-keep', {
    childScript: "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);",
    prepRoot: prepOwned('r4-normal-keep'), keep: true,
  });
  const ok = rec.launcher_exit === 0 && rec.child && rec.child.clean === true
    && (rec.child.stoppedBy === 'exit0' || rec.child.stoppedBy === 'sigterm-expected')
    && rec.root_exists === true;
  rec.ok = ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} normal-keep: exit=${rec.launcher_exit} clean=${rec.child && rec.child.clean} stoppedBy=${rec.child && rec.child.stoppedBy} root=${rec.root_exists}`);
}
// B2 normal-cleanup
{
  const rec = await driveCase('normal-cleanup', {
    childScript: "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);",
    prepRoot: prepOwned('r4-normal-cleanup'), keep: false,
  });
  const ok = rec.launcher_exit === 0 && rec.root_exists === false;
  rec.ok = ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} normal-cleanup: exit=${rec.launcher_exit} root已清理=${!rec.root_exists}`);
}
// C ev-fail
{
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-r4-ev-'));
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'synthetic');
  const rec = await driveCase('ev-fail', {
    childScript: "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);",
    prepRoot: (root) => { prepOwned('r4-ev-fail')(root); fs.symlinkSync(sentinel, path.join(root, 'prod-after.json')); },
    keep: false,
  });
  const sentinelKept = fs.existsSync(sentinel) && fs.readFileSync(sentinel, 'utf8') === 'synthetic';
  const ok = rec.launcher_exit !== 0 && rec.root_exists === true
    && (rec.stderr.includes('证据写入失败') || rec.stdout.includes('证据写入失败')) && sentinelKept;
  rec.ok = ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ev-fail: exit=${rec.launcher_exit} root=${rec.root_exists} 诊断=${(rec.stderr || rec.stdout).includes('证据写入失败')} sentinel=${sentinelKept}`);
  fs.rmSync(outside, { recursive: true, force: true });
}
// D exit42：SIGTERM handler 内 exit(42) → 异常
{
  const rec = await driveCase('exit42', {
    childScript: "process.on('SIGTERM',()=>process.exit(42)); setInterval(()=>{},1000);",
    prepRoot: prepOwned('r4-exit42'), keep: false,
  });
  const ok = rec.launcher_exit !== 0 && rec.child && rec.child.clean === false
    && rec.child.stoppedBy === 'abnormal-exit-42' && rec.child.code === 42
    && rec.root_exists === true && rec.scratch_exists === true;
  rec.ok = ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} exit42: exit=${rec.launcher_exit} clean=${rec.child && rec.child.clean} stoppedBy=${rec.child && rec.child.stoppedBy} root=${rec.root_exists} scratch=${rec.scratch_exists}`);
}
// E ext-sigkill：handler 自身 SIGKILL（非计时器）→ 异常
{
  const rec = await driveCase('ext-sigkill', {
    childScript: "process.on('SIGTERM',()=>process.kill(process.pid,'SIGKILL')); setInterval(()=>{},1000);",
    prepRoot: prepOwned('r4-ext-sigkill'), keep: false,
  });
  const ok = rec.launcher_exit !== 0 && rec.child && rec.child.clean === false
    && rec.child.stoppedBy === 'abnormal-signal-SIGKILL' && rec.child.signal === 'SIGKILL'
    && rec.root_exists === true && rec.scratch_exists === true;
  rec.ok = ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ext-sigkill: exit=${rec.launcher_exit} clean=${rec.child && rec.child.clean} stoppedBy=${rec.child && rec.child.stoppedBy} root=${rec.root_exists} scratch=${rec.scratch_exists}`);
}

fs.writeFileSync(path.join(outDir, 'shutdown-lifecycle.json'),
  JSON.stringify({ coverage: 'verbatim-extracted shutdown/safeWriteInRoot/cleanRoot from current launcher; real controlled children; synthetic roots only; extracted_anchors=[let shuttingDown = false;, await new Promise(() => {});]', results }, null, 2));
const failed = results.filter(r => r.ok !== true).length;
console.log(`lifecycle: ${results.length - failed}/${results.length} 通过（每例 ok 已写入 ${path.join(outDir, 'shutdown-lifecycle.json')}）`);
process.exit(failed ? 1 : 0);
