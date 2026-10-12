#!/usr/bin/env node
// tests/reader/launcher.mjs —— P0-T03 隔离 reader 回归入口（P0-B01-REPAIR-01 按 R1-F03 硬化）。
//
// 与上一版的关键差异（评审 R1-F03）：
//   * 启动期文件（日志/生产快照）一律写入 launcher 自建私有 scratch 目录（系统临时目录内
//     独立 mkdtemp），绝不写到 root 同级或任何未验证路径；就绪后仅复制进 root 留证据。
//   * 四个测试环境变量（ROOT/UI_DIR/PORT/RUN_ID）总是同时传递；RUN_ID 为本次运行身份，
//     就绪判定 = /__test/info 的 run_id/root/db/pid 与预期完全一致（防端口碰撞串实例），
//     且 App 子进程未提前退出——不满足绝不播种。
//   * 默认总是新建私有根目录（mkdtemp）；复用必须显式 --root + --reuse，且复用前
//     校验 marker 内容（owner==nayan-reader-regression）与路径组件前缀。
//   * 关闭：先 SIGTERM 并等待自有子进程退出（超时 SIGKILL），再写结束快照，
//     最后才按同等严格检查清理（clean 模式独立可复用）。
//
// 用法：
//   node tests/reader/launcher.mjs serve [--port N] [--keep] [--root DIR --reuse --no-seed]
//   node tests/reader/launcher.mjs negative
//   node tests/reader/launcher.mjs clean --root DIR

import { spawn, execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACH_FILES, SUGGESTIONS, fileNameOf } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const APP_BIN = path.join(REPO, 'app/src-tauri/target/debug/nayan');
const UI_DIR = path.join(REPO, 'app/ui');
const MARKER_OWNER = 'nayan-reader-regression';
const PROD_DIRS = [
  path.join(os.homedir(), 'Library/Application Support/com.nayan.app'),
  path.join(REPO, 'data'),
];

function die(msg) { console.error('launcher: ' + msg); process.exit(1); }
function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
const RUN_ID = randomBytes(8).toString('hex');

/// 组件级前缀判断（path.relative 不以 '..' 开头且不相等才视为内部），拒绝字符串 startsWith。
/// macOS 的 /var 是 /private/var 的符号链接——两侧先 realpath 规范化再比较。
function isInside(parent, child) {
  const rp = fs.realpathSync(parent);
  let rc;
  try { rc = fs.realpathSync(child); } catch (_) { rc = path.resolve(child); }
  const rel = path.relative(rp, rc);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..';
}
/// 输入路径别名检查（R3-F02）：在 realpath/规范化丢失输入信息之前执行。
/// 逐组件 lstat 用户输入：任何符号链接组件，仅当其解析结果位于系统临时目录真实路径的
/// 祖先链上（macOS /var → /private/var 一类系统级链接）才放行；临时目录内部的符号链接
/// 组件（含 root 自身为符号链接）一律拒绝——clean/复用不得经别名触达目标。
function rejectInputAliases(inputPath) {
  const realTmp = fs.realpathSync(os.tmpdir());
  const abs = path.resolve(inputPath);
  const parts = abs.split(path.sep);
  let cur = '';
  for (let i = 1; i < parts.length; i++) {
    cur = cur + path.sep + parts[i];
    let st = null;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!st.isSymbolicLink()) continue;
    const resolved = fs.realpathSync(cur);
    // R4-F01：系统例外必须同时受「链接所在位置」约束，不能只看解析目标——
    // 临时目录内部的任何用户链接（即使目标恰为 realTmp 或其系统祖先）一律拒绝。
    // 合法系统链接（如 /var → /private/var）的判定：resolved 位于 realTmp 祖先链上，
    // 且链接自身的父目录也在 resolved 的祖先链上（链接恰好「站在链上」，而非从旁路借道）。
    const isAnc = (a, b) => a === b || a === '/' || b.startsWith(a + path.sep); // 根路径是所有绝对路径的祖先
    const onTmpChain = isAnc(resolved, realTmp);
    const parentReal = fs.realpathSync(path.dirname(cur));
    const standsOnChain = isAnc(parentReal, resolved);
    const insideTmp = isAnc(realTmp, parentReal);
    if (!onTmpChain || !standsOnChain || insideTmp) {
      throw new Error('输入路径含非系统符号链接组件：' + cur + ' → ' + resolved + '（拒绝别名输入；请直接传入真实路径）');
    }
  }
  return abs;
}

function markerOwner(root) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'nayan-test-owned.json'), 'utf8'));
    return { owner: m.owner || '', run: m.run_id || '', raw: m };
  } catch { return null; }
}

function statSnapshot() {
  // 生产路径只做只读 stat（不打开 SQLite，避免触发 WAL 行为）
  const out = {};
  for (const d of PROD_DIRS) {
    out[d] = { exists: fs.existsSync(d) };
    if (out[d].exists) {
      for (const f of fs.readdirSync(d)) {
        if (!f.startsWith('.') && (f.endsWith('.db') || f.endsWith('.json') || f.endsWith('.log') || f.includes('-wal') || f.includes('-shm'))) {
          const p = path.join(d, f);
          const st = fs.statSync(p);
          out[p] = { size: st.size, mtimeMs: st.mtimeMs };
        }
      }
    }
  }
  return out;
}

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/// 安全写入（R2-F03）：向 root 内写文件前逐项校验目标——已存在时必须普通文件、
/// 非符号链接、nlink==1；否则拒绝写入（不尝试修复别名）。返回 true=写入成功。
function safeWriteInRoot(root, rel, data) {
  const target = path.join(root, rel);
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) throw new Error(rel + ' 是符号链接，拒绝写入');
    if (!st.isFile()) throw new Error(rel + ' 不是普通文件，拒绝写入');
    if (st.nlink !== undefined && st.nlink > 1) throw new Error(rel + ' 有 ' + st.nlink + ' 个硬链接，拒绝写入');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(target, data);
  return true;
}
/// 归档旧 run 的结束证据（R2-F02）：新 run 启动时显式失效旧 after/run-exit，保留历史不删除。
function archiveStaleEvidence(root) {
  for (const name of ['prod-after.json', 'run-exit.json']) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    let oldRun = 'unknown';
    try { oldRun = (JSON.parse(fs.readFileSync(p, 'utf8')).run || 'unknown').replace(/[^A-Za-z0-9_-]/g, ''); } catch (_) {}
    let dst = path.join(root, name.replace(/\.json$/, '') + '-archive-' + oldRun + '.json');
    let i = 0;
    while (fs.existsSync(dst)) { dst = path.join(root, name.replace(/\.json$/, '') + '-archive-' + oldRun + '-' + (++i) + '.json'); }
    fs.renameSync(p, dst);
  }
}

async function waitForInfo(port, expect, childExit, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExit.exited) return { err: 'App 子进程提前退出（exit=' + childExit.code + '），详见 scratch/app-stdout.log' };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__test/info`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) {
        const info = await r.json();
        // 身份握手：run/root/db/pid 全部一致才认可（防把 fixture 播给别的实例）
        if (info.run_id !== expect.run) return { err: '端口上的实例 run 身份不符（' + info.run_id + ' ≠ ' + expect.run + '）——拒绝播种' };
        if (path.resolve(info.root) !== path.resolve(expect.root)) return { err: '端口上的实例 root 不符：' + info.root };
        if (path.resolve(info.db) !== path.resolve(path.join(expect.root, 'inbox.db'))) return { err: '端口上的实例 db 不符：' + info.db };
        if (String(info.pid) !== String(expect.pid)) return { err: '端口上的实例 pid 不符：' + info.pid };
        return { info };
      }
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { err: '测试桥 25s 内未就绪' };
}

async function api(port, method, urlPath, body) {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let v = null;
  try { v = JSON.parse(text); } catch (_) { v = text; }
  if (!r.ok) throw new Error(`${method} ${urlPath} -> HTTP ${r.status}: ${text}`);
  return v;
}

function startApp(root, port, logTo) {
  if (!fs.existsSync(APP_BIN)) die('找不到 App debug 二进制：' + APP_BIN + '（先 cd app/src-tauri && cargo build --offline）');
  const out = fs.openSync(logTo, 'a');
  return spawn(APP_BIN, [], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      NAYAN_TEST_PROFILE: root,
      NAYAN_TEST_UI_DIR: UI_DIR,
      NAYAN_TEST_PORT: String(port),
      NAYAN_TEST_RUN_ID: RUN_ID,
    },
    stdio: ['ignore', out, out],
  });
}

async function seed(port, root) {
  const filesDir = path.join(root, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const fileMap = new Map();
  for (const f of ATTACH_FILES) {
    const abs = path.join(filesDir, fileNameOf(f));
    fs.writeFileSync(abs, f.content, 'utf8');
    fileMap.set(f.key, { abs, file: f });
  }
  const idOf = new Map();
  for (const s of SUGGESTIONS) {
    const row = await api(port, 'POST', '/api/suggestions', {
      title: s.title, quote: s.quote, source_tool: s.source_tool,
      workspace: s.workspace, session_ref: s.session_ref, kind: 'suggestion',
    });
    idOf.set(s.key, row.id);
  }
  const attached = [];
  for (const f of ATTACH_FILES) {
    if (!f.forKey) continue;
    const sid = idOf.get(f.forKey);
    const r = await api(port, 'POST', `/api/suggestions/${sid}/attachments`, { path: fileMap.get(f.key).abs });
    attached.push({ suggestion: f.forKey, sid, attId: r.id, path: fileMap.get(f.key).abs });
    if (f.deleteAfterAttach) fs.rmSync(fileMap.get(f.key).abs);
  }
  const manifest = {
    root, run: RUN_ID, port,
    seededAt: new Date().toISOString(),
    idOf: Object.fromEntries(idOf),
    attached,
    files: [...fileMap.values()].map(({ abs, file }) => ({
      abs, name: fileNameOf(file), deleted: !!file.deleteAfterAttach,
      sha256: sha256Text(file.content),
    })),
  };
  fs.writeFileSync(path.join(root, 'manifest-seed.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
function sha256Text(s) { return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'); }

function appWindowCount(pid) {
  // 信息性：该进程的窗口项数（tao/Tauri 的内部辅助窗为无标题离屏窗，非 WebView）
  try {
    const out = execSync(
      `swift "${path.join(__dirname, 'windows-for-pid.swift')}" ${pid}`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim();
    const n = Number(out.split('\n')[0]);
    return { count: n, titled: out.split('\n').slice(1).filter(l => l.split('|')[1]?.trim()).length };
  } catch { return { count: -1, titled: -1 }; }
}
function webviewChildCount(pid) {
  // R1-F02 辅助证据：WKWebView 会派生 com.apple.WebKit.* XPC 子进程；
  // 测试模式清空 app.windows 后应为 0（无任何 WebView → 无默认 WKWebsiteDataStore 触碰）
  try {
    const out = execSync(`pgrep -P ${pid} || true`, { encoding: 'utf8' }).trim();
    if (!out) return 0;
    const kids = out.split('\n').filter(Boolean);
    let wk = 0;
    for (const k of kids) {
      const cmd = execSync(`ps -o command= -p ${k}`, { encoding: 'utf8' });
      if (cmd.includes('WebKit')) wk++;
    }
    return wk;
  } catch { return -1; }
}

async function cmdServe(args) {
  const keep = args.includes('--keep');
  const noSeed = args.includes('--no-seed');
  const reuse = args.includes('--reuse');
  const rootIdx = args.indexOf('--root');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : await freePort();

  let root;
  if (reuse) {
    if (rootIdx < 0) die('--reuse 必须与 --root 同用（复用显式目录）');
    root = path.resolve(args[rootIdx + 1]);
    if (!path.isAbsolute(root)) die('--root 必须是绝对路径');
    if (!isInside(os.tmpdir(), root)) die('拒绝复用：root 不在系统临时目录内（组件级前缀校验）');
    const m = markerOwner(root);
    if (!m || m.owner !== MARKER_OWNER) die('拒绝复用：root 缺少/损坏/伪造所有权标记（owner 必须为 ' + MARKER_OWNER + '）');
    if (!fs.existsSync(path.join(root, 'inbox.db'))) die('--reuse 要求已存在的隔离库');
    try { root = fs.realpathSync(rejectInputAliases(root)); }
    catch (e) { die('拒绝复用：' + e.message); }
  } else {
    if (rootIdx >= 0) die('新建模式不接受 --root（复用请加 --reuse；launcher 始终自建私有目录）');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-reader-test-'));
  }

  // launcher 私有 scratch：一切启动期写入只进这里，绝不写 root 同级
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-launcher-'));
  const scratchLog = path.join(scratch, 'app-stdout.log');
  const prodBefore = statSnapshot();
  fs.writeFileSync(path.join(scratch, 'prod-before.json'), JSON.stringify(prodBefore, null, 2));

  const child = startApp(root, port, scratchLog);
  const childExit = { exited: false, code: null };
  child.on('exit', (c) => { childExit.exited = true; childExit.code = c; });

  const { info, err: infoErr } = await waitForInfo(port, { run: RUN_ID, root, pid: String(child.pid) }, childExit);
  if (infoErr) {
    try { child.kill('SIGKILL'); } catch (_) {}
    const msg = infoErr + '（scratch=' + scratch + '）';
    if (!keep) try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
    if (!reuse) try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    die(msg);
  }

  // R2-F02：新 run 启动即归档旧 run 的 after/run-exit（保留历史、当前 run 不得消费旧 after）
  archiveStaleEvidence(root);
  // 就绪后把启动期文件写入 root 作为证据；写入前经 safeWrite 别名校验，失败视为就绪失败
  try {
    safeWriteInRoot(root, 'prod-before.json', fs.readFileSync(path.join(scratch, 'prod-before.json')));
    safeWriteInRoot(root, 'app-stdout.log', fs.readFileSync(scratchLog));
    safeWriteInRoot(root, 'current-run.json', JSON.stringify({ run: RUN_ID, port, pid: child.pid, at: new Date().toISOString() }, null, 2));
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (_) {}
    die('证据写入失败（别名校验或写盘）：' + e.message);
  }

  let manifest = null;
  if (!noSeed) manifest = await seed(port, root);

  const logPath = path.join(root, 'nayan.log');
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const winInfo = appWindowCount(child.pid);
  const wkChildren = webviewChildCount(child.pid);
  console.log('[launcher] 测试实例就绪');
  console.log(JSON.stringify({
    run: RUN_ID,
    url: `http://127.0.0.1:${port}/`,
    infoUrl: `http://127.0.0.1:${port}/__test/info`,
    root, port, db: info.db, config: info.config, log: info.log,
    appPid: child.pid,
    markerRun: info.marker_run_id,
    seeded: manifest ? Object.keys(manifest.idOf).length : 0,
    appWindows: winInfo,               // 信息性：内部辅助窗（无标题、离屏、非 WebView）
    webviewChildren: wkChildren,       // 辅助证据：期望 0（主要证据是窗口配置清空的代码事实）
    isolationLog: {
      hotkeysSkipped: logText.includes('测试模式：跳过全局热键注册'),
      clipWatchSkipped: logText.includes('测试模式：剪贴板 watcher 未启动'),
      noMigration: !logText.includes('已从旧库导入') && !logText.includes('迁移失败'),
    },
  }, null, 2));

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    let killed = false; // 超时强杀 → 非正常结束
    try { child.kill('SIGTERM'); } catch (_) {}
    const killTimer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, 4000);
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      // R2-F02：结束证据带 run 身份，只能在对应进程确实停止后生成。
      // R4-F02：统一「正常主动结束」判定，并驱动 clean/abnormal/stoppedBy/退出码/清理——
      //   正常 = exit 0（无信号），或本 launcher 请求的预期 SIGTERM 终止（code=null, signal=SIGTERM, 非超时）；
      //   非零 code（如 42）、任何非预期信号（含非计时器 SIGKILL）、超时强杀 = 异常。
      const expectedTerm = !killed && signal === 'SIGTERM' && code === null;
      const normalExit0 = code === 0 && signal == null;
      const normalEnd = normalExit0 || expectedTerm;
      const stoppedBy = killed ? 'sigkill-timeout'
        : expectedTerm ? 'sigterm-expected'
        : normalExit0 ? 'exit0'
        : (signal ? 'abnormal-signal-' + signal : 'abnormal-exit-' + code);
      let evidenceOk = true;
      const afterRec = { run: RUN_ID, pid: child.pid, finishedAt: new Date().toISOString(), snapshot: statSnapshot() };
      const exitRec = { run: RUN_ID, pid: child.pid, code: code, signal: signal || null, stoppedBy: stoppedBy, requested: 'launcher-shutdown', clean: normalEnd, finishedAt: new Date().toISOString() };
      try {
        fs.writeFileSync(path.join(scratch, 'prod-after.json'), JSON.stringify(afterRec, null, 2));
        safeWriteInRoot(root, 'prod-after.json', JSON.stringify(afterRec, null, 2));
        safeWriteInRoot(root, 'run-exit.json', JSON.stringify(exitRec, null, 2));
      } catch (e) {
        evidenceOk = false;
        console.error('[launcher] 结束证据写入失败：' + e.message);
      }
      // R3-F03/R4-F02：异常（超时强杀 / 非零退出 / 非预期信号 / 证据写失败）不执行自动目录删除
      const abnormal = !normalEnd || !evidenceOk;
      let cleaned = true;
      if (abnormal) {
        console.error('[launcher] 异常结束（' + stoppedBy + (evidenceOk ? '' : ' + 证据写入失败') + '）：保留隔离根目录与日志供取证：' + root + '（scratch=' + scratch + '）');
      } else {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
        if (!keep) {
          cleaned = cleanRoot(root, /*quiet*/false);
          if (!cleaned) console.error('[launcher] 清理未通过校验，目录保留：' + root);
        } else {
          console.log('[launcher] --keep：保留隔离根目录', root);
        }
      }
      // R3-F03：退出码 = 主动优雅停机 && 证据写入成功 && （--keep 或 清理成功）。
      // 超时强杀即使证据写成功也必须非零；清理失败不静默宣称全部成功。
      const exitOk = !abnormal && cleaned;
      process.exit(exitOk ? 0 : 1);
    });
    // 兜底：8s 后退出；证据未就绪时不得 exit 0
    setTimeout(() => process.exit(1), 8000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

/// 严格清理（R2-F03）：路径组件前缀 + marker 内容 + 目标身份 + 实例已停止，全部通过才删。
/// 身份 = 显式 --run 参数，或 root 内受控 launcher 写入的 current-run.json 的 run；
/// 存活 = current-run.json 的 pid 仍在运行则拒绝（不接受“只有通用 owner”的目录）。
function cleanRoot(root, quiet, expectRun) {
  // R3-F02：先拒绝别名输入（信息未被 realpath 丢弃），再做既有身份/存活/边界校验
  let absInput;
  try { absInput = rejectInputAliases(root); }
  catch (e) { if (!quiet) console.error('拒绝清理：' + e.message); return false; }
  const real = fs.realpathSync(absInput);
  if (!isInside(os.tmpdir(), real)) { if (!quiet) console.error('拒绝清理：不在系统临时目录内', real); return false; }
  const m = markerOwner(real);
  if (!m || m.owner !== MARKER_OWNER) { if (!quiet) console.error('拒绝清理：所有权标记缺失/损坏/伪造', real); return false; }
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(path.join(real, 'current-run.json'), 'utf8')); } catch (_) {}
  // 身份：显式 --run 必须匹配 current-run 记录的最后 run；无参数时以 current-run 为身份
  //（marker 记录的是创建 run，与最后 run 不同是重启复用后的正常态，不作为拒绝理由）。
  const runOk = expectRun ? (cur && cur.run === expectRun) : !!cur && !!cur.run;
  if (!runOk) { if (!quiet) console.error('拒绝清理：无法确认目标身份（current-run 缺失或不匹配）', real); return false; }
  if (cur.pid) {
    try { process.kill(cur.pid, 0); if (!quiet) console.error('拒绝清理：实例 pid ' + cur.pid + ' 仍在运行', real); return false; }
    catch (e) { if (e.code !== 'ESRCH') { if (!quiet) console.error('拒绝清理：pid 存活检查失败 ' + e.code, real); return false; } }
  }
  fs.rmSync(real, { recursive: true, force: true });
  if (!quiet) console.log('[launcher] 已清理（owner+路径+身份+存活四校验通过，run=' + cur.run + '）', real);
  return true;
}

async function expectReject(caseName, env, watch) {
  // watch: { rootToWatch?, sentinels?, preExisting?: {marker,db} }
  // preExisting 声明用例自建的文件：对这些不做「未创建」断言（它们本来就在）
  const before = statSnapshot();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-'));
  const logTo = path.join(scratch, 'app-stdout.log');
  const out = [];
  const child = spawn(APP_BIN, [], { cwd: os.tmpdir(), env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(logTo, 'a'), fs.openSync(logTo, 'a')] });
  child.stdout?.on?.('data', () => {});
  const code = await new Promise((res) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} res('TIMEOUT'); }, 15000);
    child.on('exit', (c) => { clearTimeout(t); res(c); });
  });
  const after = statSnapshot();
  const dbCreated = watch?.rootToWatch ? fs.existsSync(path.join(watch.rootToWatch, 'inbox.db')) : false;
  const markerCreated = watch?.rootToWatch ? fs.existsSync(path.join(watch.rootToWatch, 'nayan-test-owned.json')) : false;
  const prodChanged = JSON.stringify(before) !== JSON.stringify(after);
  const sentinelsOk = (watch?.sentinels || []).every(s => {
    const h = fs.existsSync(s.file) ? sha256(s.file) : null;
    return h === s.beforeHash;
  });
  const logText = fs.existsSync(logTo) ? fs.readFileSync(logTo, 'utf8') : '';
  const pre = watch?.preExisting || {};
  const noNewDb = pre.db || !dbCreated;
  const noNewMarker = pre.marker || !markerCreated;
  const ok = code === 78 && noNewDb && !prodChanged && sentinelsOk && noNewMarker;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${caseName}: exit=${code} dbCreated=${dbCreated} markerCreated=${markerCreated} prodChanged=${prodChanged} sentinelsUnchanged=${sentinelsOk}`);
  if (logText.trim()) console.log('  stderr: ' + logText.trim().split('\n').slice(0, 2).join('\n  '));
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  if (watch?.cleanup) { try { fs.rmSync(watch.cleanup, { recursive: true, force: true }); } catch (_) {} }
  return ok;
}

async function cmdNegative() {
  if (!fs.existsSync(APP_BIN)) die('找不到 App debug 二进制（先构建）');
  const runId = 'neg' + randomBytes(4).toString('hex');
  const base = { NAYAN_TEST_UI_DIR: UI_DIR, NAYAN_TEST_PORT: String(await freePort()), NAYAN_TEST_RUN_ID: runId };
  const results = [];
  const mkSentinel = (dir) => {
    const f = path.join(dir, 'sentinel-' + randomBytes(4).toString('hex') + '.data');
    fs.writeFileSync(f, 'sentinel-content-' + Math.random());
    return { file: f, beforeHash: sha256(f) };
  };

  // a. 缺 ROOT（UI/PORT/RUN 都在）→ 上一版会走生产分支，必须改为拒绝
  results.push(await expectReject('缺 ROOT 拒绝（不回生产）', base, null));
  // b. 相对路径 ROOT
  results.push(await expectReject('相对路径拒绝', { ...base, NAYAN_TEST_PROFILE: 'relative/path' }, null));
  // c. 生产 App 数据目录
  results.push(await expectReject('生产目录拒绝', { ...base, NAYAN_TEST_PROFILE: PROD_DIRS[0] }, null));
  // d. 符号链接根 → 生产目录
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-symlink-'));
    const link = path.join(tmpRoot, 'escape');
    fs.symlinkSync(PROD_DIRS[0], link);
    results.push(await expectReject('符号链接根逃逸拒绝', { ...base, NAYAN_TEST_PROFILE: link }, { rootToWatch: tmpRoot, cleanup: tmpRoot }));
  }
  // e. inbox.db 符号链接 → 根外 sentinel（叶子逃逸）；marker 用无效 {} 也会被拒
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-outside-'));
    const sentinel = mkSentinel(outside);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-leaf-'));
    fs.writeFileSync(path.join(root, 'nayan-test-owned.json'), JSON.stringify({ owner: MARKER_OWNER, run_id: runId }));
    fs.symlinkSync(sentinel.file, path.join(root, 'inbox.db'));
    results.push(await expectReject('inbox.db 叶子符号链接逃逸拒绝', { ...base, NAYAN_TEST_PROFILE: root }, { rootToWatch: root, sentinels: [sentinel], preExisting: { marker: true, db: true }, cleanup: outside }));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  // e2. inbox.db 硬链接 → 根外 sentinel（nlink>1 拒绝）
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-hl-'));
    const sentinel = mkSentinel(outside);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-hardlink-'));
    fs.writeFileSync(path.join(root, 'nayan-test-owned.json'), JSON.stringify({ owner: MARKER_OWNER, run_id: runId }));
    fs.linkSync(sentinel.file, path.join(root, 'inbox.db'));
    results.push(await expectReject('inbox.db 硬链接拒绝（nlink>1）', { ...base, NAYAN_TEST_PROFILE: root }, { rootToWatch: root, sentinels: [sentinel], preExisting: { marker: true, db: true }, cleanup: outside }));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  // e3. files/ 符号链接 → 根外目录（种子写入不得落根外）
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-files-'));
    const sentinel = mkSentinel(outside);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-fileslk-'));
    fs.writeFileSync(path.join(root, 'nayan-test-owned.json'), JSON.stringify({ owner: MARKER_OWNER, run_id: runId }));
    fs.symlinkSync(outside, path.join(root, 'files'));
    results.push(await expectReject('files/ 符号链接拒绝', { ...base, NAYAN_TEST_PROFILE: root }, { rootToWatch: root, sentinels: [sentinel], preExisting: { marker: true }, cleanup: outside }));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  // e4. prod-after.json 符号链接 → 根外文件（结束证据写入不得经别名落盘）
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-ev-'));
    const sentinel = mkSentinel(outside);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-evlk-'));
    fs.writeFileSync(path.join(root, 'nayan-test-owned.json'), JSON.stringify({ owner: MARKER_OWNER, run_id: runId }));
    fs.symlinkSync(sentinel.file, path.join(root, 'prod-after.json'));
    results.push(await expectReject('prod-after.json 符号链接拒绝', { ...base, NAYAN_TEST_PROFILE: root }, { rootToWatch: root, sentinels: [sentinel], preExisting: { marker: true }, cleanup: outside }));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  // f. marker 损坏（{}）
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-badmarker-'));
    fs.writeFileSync(path.join(root, 'nayan-test-owned.json'), '{}');
    results.push(await expectReject('marker 损坏（{}）拒绝', { ...base, NAYAN_TEST_PROFILE: root }, { rootToWatch: root, preExisting: { marker: true }, cleanup: root }));
  }
  // g. marker 伪造 owner
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-foreign-'));
    fs.writeFileSync(path.join(root, 'nayan-test-owned.json'), JSON.stringify({ owner: 'someone-else', run_id: runId }));
    results.push(await expectReject('marker owner 不符拒绝', { ...base, NAYAN_TEST_PROFILE: root }, { rootToWatch: root, preExisting: { marker: true }, cleanup: root }));
  }
  // h. 非空目录无 marker
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-nomarker-'));
    fs.writeFileSync(path.join(root, '别人的文件.txt'), 'not ours');
    results.push(await expectReject('无标记非空目录拒绝', { ...base, NAYAN_TEST_PROFILE: root }, { rootToWatch: root, cleanup: root }));
  }
  // i. 缺 UI_DIR
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-noui-'));
    results.push(await expectReject('缺 UI_DIR 拒绝', { NAYAN_TEST_PROFILE: root, NAYAN_TEST_PORT: base.NAYAN_TEST_PORT, NAYAN_TEST_RUN_ID: runId }, { rootToWatch: root, cleanup: root }));
  }
  // j. 缺 RUN_ID
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-norun-'));
    results.push(await expectReject('缺 RUN_ID 拒绝', { NAYAN_TEST_PROFILE: root, NAYAN_TEST_UI_DIR: UI_DIR, NAYAN_TEST_PORT: base.NAYAN_TEST_PORT }, { rootToWatch: root, cleanup: root }));
  }
  // k. 端口 = 58777（生产单实例端口）
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-neg-port-'));
    results.push(await expectReject('占用 58777 拒绝', { ...base, NAYAN_TEST_PORT: '58777', NAYAN_TEST_PROFILE: root }, { rootToWatch: root, cleanup: root }));
  }
  // l. ROOT = 系统临时目录本身
  results.push(await expectReject('ROOT=临时目录本身拒绝', { ...base, NAYAN_TEST_PROFILE: os.tmpdir() }, null));

  const pass = results.every(Boolean);
  console.log(pass ? 'negative: 全部拒绝用例通过（fail-closed 成立）' : 'negative: 存在失败用例');
  process.exit(pass ? 0 : 1);
}

function cmdClean(args) {
  const rootIdx = args.indexOf('--root');
  const runIdx = args.indexOf('--run');
  if (rootIdx < 0) die('clean 需要 --root');
  const root = path.resolve(args[rootIdx + 1]);
  if (!fs.existsSync(path.join(root, 'nayan-test-owned.json'))) die('拒绝：目录没有 nayan 测试所有权标记 ' + root);
  if (!cleanRoot(root, false, runIdx >= 0 ? args[runIdx + 1] : null)) process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'serve') await cmdServe(rest);
else if (cmd === 'negative') await cmdNegative();
else if (cmd === 'clean') cmdClean(rest);
else {
  console.log('用法: launcher.mjs serve [--port N] [--keep] [--root DIR --reuse --no-seed] | negative | clean --root DIR');
  process.exit(cmd ? 1 : 0);
}
