#!/usr/bin/env node
// scripts/test-all.mjs —— 一键跑全部测试 + 基线对账（R9-B2）。
//
// 用法（在仓库根目录）：
//   node scripts/test-all.mjs                       # 跑全部；先检查 debug 二进制新鲜度
//   node scripts/test-all.mjs --only dom,real-app-v4 # 只跑指定项（名字见 scripts/test-baseline.json）
//   node scripts/test-all.mjs --no-build            # 跳过二进制新鲜度检查与构建
//
// 规则：
//   * 每项单独设超时（macOS 没有 timeout 命令，用子进程+计时器，超时先 SIGTERM 后 SIGKILL，
//     连同子进程组一起杀）。
//   * 结果和 scripts/test-baseline.json 对比：失败>0、退出码非 0、超时、或通过数比基线少 → 标红。
//     通过数比基线多不算红（说明新增了用例），会标注 +N 提醒更新基线。
//   * native-security-gates 依赖 native-ui 的输出目录（--suite-out），脚本内部自动串联。
//   * 所有测试本身（B1 之后）默认把证据写到系统临时目录，本脚本不再传 --out。
//   * 结束时检查 git status 是否干净（信息行，不影响退出码）。
//   * 有任何红 → 退出码 1。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/test-baseline.json'), 'utf8'));

const argv = process.argv.slice(2);
const onlyArg = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const noBuild = argv.includes('--no-build');
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;

// cargo 环境同 app/deploy.sh；每项仅在目标路径存在时才覆盖，避免不同机器 SDK 名不同。
const CLANG = '/Library/Developer/CommandLineTools/usr/bin/clang';
const SDKS = '/Library/Developer/CommandLineTools/SDKs';
const CARGO_ENV = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
if (fs.existsSync(CLANG)) {
  CARGO_ENV.CC = CLANG;
  CARGO_ENV.CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER = CLANG;
}
const sdk = fs.existsSync(SDKS) ? fs.readdirSync(SDKS).filter((d) => /^MacOSX\d+\.?\d*\.sdk$/.test(d)).sort().pop() : null;
if (sdk) CARGO_ENV.SDKROOT = path.join(SDKS, sdk);

// ---------- 解析器：从测试输出里取 通过/失败 数 ----------
const sumRe = /test result: (ok|FAILED)\.? (\d+) passed; (\d+) failed; (\d+) ignored/g;
const PARSERS = {
  slash: (s) => { const m = s.match(/(\d+)\/(\d+) pass, (\d+) fail/); return m ? { pass: +m[1], fail: +m[3] } : null; },
  xiang: (s) => { const m = s.match(/(\d+) 项通过，(\d+) 项失败/); return m ? { pass: +m[1], fail: +m[2] } : null; },
  li: (s) => { const m = s.match(/(\d+) 例通过/); return m ? { pass: +m[1], fail: (s.match(/^FAIL/gm) || []).length } : null; },
  extpath: (s) => { const m = s.match(/(\d+) 通过 \/ (\d+) 失败/); return m ? { pass: +m[1], fail: +m[2] } : null; },
  passlines: (s) => ({ pass: (s.match(/^PASS/gm) || []).length, fail: (s.match(/^FAIL/gm) || []).length }),
  okline: (marker, count) => (s) => (s.includes(marker) ? { pass: count, fail: 0 } : null),
  cargo: (s) => {
    let pass = 0, fail = 0, ignored = 0, any = false;
    for (const m of s.matchAll(sumRe)) { any = true; pass += +m[2]; fail += +m[3]; ignored += +m[4]; }
    return any ? { pass, fail, note: `${ignored} ignored` } : null;
  },
};

// ---------- 测试清单（顺序对齐 §0.2）----------
const TESTS = [
  { name: 'cargo', cmd: ['cargo', 'test'], cwd: 'app/src-tauri', env: CARGO_ENV, timeout: 15 * 60_000, parse: PARSERS.cargo, needsBin: true },
  { name: 'dom', cmd: ['node', 'tests/renderer/dom.test.mjs'], timeout: 5 * 60_000, parse: PARSERS.slash },
  { name: 'helpers', cmd: ['node', 'tests/renderer/helpers.test.mjs'], timeout: 2 * 60_000, parse: PARSERS.slash },
  { name: 'rich-dom', cmd: ['node', 'tests/renderer/rich-dom.test.mjs'], timeout: 5 * 60_000, parse: PARSERS.slash },
  { name: 'rich', cmd: ['node', 'tests/renderer/rich.test.mjs'], timeout: 2 * 60_000, parse: PARSERS.slash },
  { name: 'source-map', cmd: ['node', 'tests/renderer/source-map.test.mjs'], timeout: 2 * 60_000, parse: PARSERS.slash },
  { name: 'reader-async', cmd: ['node', 'tests/renderer/reader-async.test.mjs'], timeout: 5 * 60_000, parse: PARSERS.slash },
  { name: 'title-rule', cmd: ['node', 'tests/renderer/title-rule.test.mjs'], timeout: 2 * 60_000, parse: PARSERS.passlines },
  { name: 'plan-rule', cmd: ['node', 'tests/renderer/plan-rule.test.mjs'], timeout: 2 * 60_000, parse: PARSERS.xiang },
  // native-ui 的输出目录要喂给 native-security-gates（--suite-out），所以显式指定并登记。
  { name: 'native-ui', cmd: ['node', 'tests/renderer/native-ui.test.mjs'], timeout: 15 * 60_000, parse: PARSERS.xiang,
    args: ['--out', ''], outDirOf: 'native-ui' },
  { name: 'native-security-gates', cmd: ['node', 'tests/renderer/native-security-gates.test.mjs'], timeout: 5 * 60_000,
    parse: PARSERS.okline('native-security-gates: 3 门全部按设计工作', 3),
    argsFn: (ctx) => ['--out', fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-gates-')), '--suite-out', ctx['native-ui']] },
  { name: 'real-app', cmd: ['node', 'tests/renderer/real-app.test.mjs'], timeout: 10 * 60_000, parse: PARSERS.slash, needsBin: true },
  { name: 'real-app-rich', cmd: ['node', 'tests/renderer/real-app-rich.test.mjs'], timeout: 10 * 60_000, parse: PARSERS.slash, needsBin: true },
  { name: 'real-app-v4', cmd: ['node', 'tests/renderer/real-app-v4.test.mjs'], timeout: 10 * 60_000, parse: PARSERS.xiang, needsBin: true },
  { name: 'capture-walkthrough', cmd: ['node', 'tests/capture/capture-walkthrough.mjs'], timeout: 15 * 60_000, parse: PARSERS.xiang, needsBin: true },
  { name: 'delivery-bridge', cmd: ['node', 'tests/capture/delivery-bridge.test.mjs'], timeout: 15 * 60_000, parse: PARSERS.xiang },
  { name: 'extension-real-path', cmd: ['node', 'tests/ingestion/extension-real-path.mjs'], timeout: 10 * 60_000, parse: PARSERS.extpath },
  { name: 'external-writers', cmd: ['node', 'tests/migrations/external-writers.mjs'], timeout: 15 * 60_000, parse: PARSERS.li },
  { name: 'schema-gate-consistency', cmd: ['node', 'tests/migrations/schema-gate-consistency.mjs'], timeout: 15 * 60_000, parse: PARSERS.okline('全部一致', null) },
  { name: 'mcp-ingestion', cmd: ['node', 'tests/ingestion/mcp-ingestion.test.mjs'], timeout: 15 * 60_000, parse: PARSERS.li },
  { name: 'sync-ingestion', cmd: ['node', 'tests/ingestion/sync-ingestion.test.mjs'], timeout: 15 * 60_000, parse: PARSERS.li },
  { name: 'envelope-goldens', cmd: ['node', 'tests/ingestion/envelope-goldens.test.mjs'], timeout: 2 * 60_000, parse: PARSERS.li },
  { name: 'box-overlay', cmd: ['node', 'tests/capture/box-overlay.test.mjs'], timeout: 2 * 60_000, parse: PARSERS.passlines },
  { name: 'trash-external', cmd: ['node', 'tests/migrations/trash-external.test.mjs'], timeout: 5 * 60_000, parse: PARSERS.li },
];

// ---------- debug 二进制新鲜度 ----------
function binaryStale() {
  const bin = path.join(REPO, 'app/src-tauri/target/debug/nayan');
  if (!fs.existsSync(bin)) return { stale: true, reason: '二进制不存在' };
  const binM = fs.statSync(bin).mtimeMs;
  let newest = 0, newestFile = '';
  const consider = (p) => { const st = fs.statSync(p); if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = p; } };
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); e.isDirectory() ? walk(p) : p.endsWith('.rs') && consider(p); } };
  walk(path.join(REPO, 'app/src-tauri/src'));
  for (const f of ['Cargo.toml', 'Cargo.lock', 'tauri.conf.json', 'build.rs']) {
    const p = path.join(REPO, 'app/src-tauri', f);
    fs.existsSync(p) && consider(p);
  }
  return newest > binM ? { stale: true, reason: `源码较新：${path.relative(REPO, newestFile)}` } : { stale: false };
}

// ---------- 跑一个子进程（带超时，杀整组）----------
function runOne({ argv: command, cwd = '.', env = process.env, timeout }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(command[0], command.slice(1), { cwd: path.join(REPO, cwd), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '', killed = false;
    const pull = (d) => { out += d; if (out.length > 24 * 1024 * 1024) out = out.slice(-16 * 1024 * 1024); };
    child.stdout.on('data', pull);
    child.stderr.on('data', pull);
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 5000);
    }, timeout);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out: out + String(e), ms: Date.now() - t0, timeout: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - t0, timeout: killed }); });
  });
}

const fmt = (n) => (n == null ? '—' : String(n));
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', OFF = '\x1b[0m';

// ---------- main ----------
const selected = TESTS.filter((t) => !only || only.has(t.name));
if (only) {
  const known = new Set(TESTS.map((t) => t.name));
  for (const n of only) if (!known.has(n)) { console.error(`未知测试名：${n}（可选：${[...known].join(', ')}）`); process.exit(2); }
}

if (!noBuild && selected.some((t) => t.needsBin)) {
  const st = binaryStale();
  if (st.stale) {
    console.log(`debug 二进制比源码旧（${st.reason}），先 cargo build --offline ...`);
    const b = await runOne({ argv: ['cargo', 'build', '--offline'], cwd: 'app/src-tauri', env: CARGO_ENV, timeout: 15 * 60_000 });
    if (b.code !== 0) {
      console.log(`${RED}构建失败：${OFF}\n${b.out.slice(-4000)}`);
      process.exit(1);
    }
    console.log(`构建完成（${sec(b.ms)}）`);
  }
}

const ctx = {}; // native-ui 的输出目录给 security-gates 用
const rows = [];
let anyRed = false;

for (const t of selected) {
  process.stdout.write(`跑 ${t.name} ... `);
  let args = t.argsFn ? t.argsFn(ctx) : (t.args ? [...t.args] : []);
  if (t.outDirOf) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `nayan-${t.name}-`));
    args = args.map((a, i) => (i > 0 && args[i - 1] === '--out' ? d : a));
    ctx[t.outDirOf] = d;
  }
  const r = await runOne({ argv: [...t.cmd, ...args], cwd: t.cwd, env: t.env, timeout: t.timeout });
  const parsed = t.parse(r.out);
  let pass = parsed?.pass ?? null, fail = parsed?.fail ?? 0, note = parsed?.note || '';
  let verdict = 'ok', why = [];

  if (r.timeout) { verdict = 'red'; why.push(`超时 ${sec(t.timeout)} 被杀`); fail = fail || 1; }
  else if (r.code !== 0) { verdict = 'red'; why.push(`退出码 ${r.code}`); if (!parsed) fail = fail || 1; }
  if (parsed && fail > 0 && verdict !== 'red') { verdict = 'red'; }
  if (parsed && fail > 0) why.push(`${fail} 失败`);
  if (!parsed && !r.timeout && r.code === 0) { note = '未匹配到汇总行'; }
  if (t.parse === PARSERS.okline && !parsed && r.code === 0) { verdict = 'red'; why.push('缺少标记行'); }

  const base = BASELINE[t.name];
  let baseCell = '—';
  if (base) {
    baseCell = base.pass == null ? (base.note || '标记行') : `${base.pass}${base.fail ? `/${base.fail}f` : ''}`;
    if (verdict !== 'red' && base.pass != null && pass != null && pass < base.pass) { verdict = 'red'; why.push(`比基线少 ${base.pass - pass}`); }
    if (verdict === 'ok' && base.pass != null && pass != null && pass > base.pass) note += ` +${pass - base.pass}（比基线多，可更新基线）`;
  } else baseCell = '无基线';

  if (verdict === 'red') anyRed = true;
  rows.push({ name: t.name, pass, fail, ms: r.ms, base: baseCell, verdict, note: [why.join('；'), note].filter(Boolean).join('；') });
  console.log(`${verdict === 'red' ? RED + '✗' + OFF : GREEN + '✓' + OFF} ${sec(r.ms)}`);
  // 红了就把输出末尾打出来：CI 上没有别的地方能看到失败原因。
  if (verdict === 'red') console.log(DIM + r.out.split('\n').slice(-40).join('\n') + OFF);
}

// 仓库干净检查（信息行，不参与红绿）
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
const dirtyFiles = (dirty.stdout || '').split('\n').filter(Boolean);
rows.push({ name: '(git 仓库干净)', pass: null, fail: null, ms: 0, base: '', verdict: dirtyFiles.length ? 'info-dirty' : 'info', note: dirtyFiles.length ? `${dirtyFiles.length} 个未提交变更（自查是否测试产物）` : '无未提交变更' });

const W = { name: 24, pass: 7, fail: 7, ms: 9, base: 10 };
const line = (c) => [c.name.padEnd(W.name), fmt(c.pass).padStart(W.pass), fmt(c.fail).padStart(W.fail), sec(c.ms).padStart(W.ms), c.base.padStart(W.base)].join(' ');
console.log(`\n${'测试'.padEnd(W.name)}${'通过'.padStart(W.pass)}${'失败'.padStart(W.fail)}${'耗时'.padStart(W.ms)}${'基线'.padStart(W.base)}  判定 / 备注`);
console.log('-'.repeat(100));
for (const r of rows) {
  const tag = r.verdict === 'red' ? `${RED}✗ RED${OFF}` : r.verdict.startsWith('info') ? `${DIM}· info${OFF}` : `${GREEN}✓ ok${OFF}`;
  console.log(`${line(r)}  ${tag}${r.note ? `  ${r.note}` : ''}`);
}
console.log('-'.repeat(100));
const totalMs = rows.reduce((a, r) => a + r.ms, 0);
console.log(`合计 ${sec(totalMs)}；${rows.filter((r) => r.verdict === 'red').length} 红 / ${rows.filter((r) => r.verdict === 'ok').length} 绿`);
process.exit(anyRed ? 1 : 0);
