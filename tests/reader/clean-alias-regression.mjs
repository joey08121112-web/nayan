#!/usr/bin/env node
// tests/reader/clean-alias-regression.mjs —— R4-F01 clean/复用输入别名的窄范围回归。
//
// 全部使用自有合成临时数据；不触碰真实用户文件与生产库。
// 用例（每例断言退出码 + target/sentinel 存在性与内容哈希）：
//   1 direct-alias        root 本身是指向 target 的符号链接            → 拒绝（exit≠0，target/sentinel 原样）
//   2 via-tmp             临时目录内 link→系统临时目录，经其拼出 target   → 拒绝（R4-F01 主反例）
//   3 via-sys-ancestor    临时目录内 link→realTmp 的系统祖先(/private/var) → 拒绝
//   4 var-spelling        合法 root 用 /var 拼写（系统 /var→/private/var）  → 清理成功
//   5 normal              直接真实路径 + 正确 run + 已退出 pid             → 清理成功
//   6 wrong-run           显式 --run 不匹配                              → 拒绝，target 保留
//   7 live-pid            current-run 的 pid 仍存活                       → 拒绝，target 保留
//
// 用法：node tests/reader/clean-alias-regression.mjs [--out DIR]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(__dirname, 'launcher.mjs');
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1])
  : path.join(__dirname, '../../docs/implementation-plan-2026-09-23/batches/P0-B01-REPAIR-04/evidence');
fs.mkdirSync(outDir, { recursive: true });

const realTmp = fs.realpathSync(os.tmpdir());
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function mkTarget(parent, name, run) {
  const t = path.join(parent, name);
  fs.mkdirSync(t);
  fs.writeFileSync(path.join(t, 'nayan-test-owned.json'), JSON.stringify({ owner: 'nayan-reader-regression', run_id: run }));
  fs.writeFileSync(path.join(t, 'inbox.db'), 'x');
  const sentinel = path.join(t, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'synthetic; no production data');
  const c = spawnSync('true'); // 真实已退出的 pid（spawnSync 返回即结束；kill(pid,0) → ESRCH）
  fs.writeFileSync(path.join(t, 'current-run.json'), JSON.stringify({ run, pid: c.pid, at: 0 }));
  return { t, sentinel, sha0: sha(sentinel) };
}

const results = [];
function record(name, input, expectClean, run) {
  const args = ['clean', '--root', input];
  if (run) args.push('--run', run);
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', timeout: 15000 });
  return r;
}

async function main() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-r4-reg-'));
  const log = [];

  // 1 direct-alias
  {
    const { t, sentinel, sha0 } = mkTarget(parent, 't-direct', 'r4a');
    const alias = path.join(parent, 'alias-direct');
    fs.symlinkSync(t, alias);
    const r = record('direct-alias', alias, false);
    const ok = r.status !== 0 && fs.existsSync(t) && fs.existsSync(sentinel) && sha(sentinel) === sha0;
    log.push({ case: 'direct-alias', exit: r.status, target_exists: fs.existsSync(t), sentinel_unchanged: sha(sentinel) === sha0, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} direct-alias: exit=${r.status} target=${fs.existsSync(t)} sentinel=${sha(sentinel) === sha0}`);
  }
  // 2 via-tmp：临时目录内 link → realTmp
  {
    const { t, sentinel, sha0 } = mkTarget(parent, 't-viatmp', 'r4b');
    const link = path.join(parent, 'via-tmp');
    fs.symlinkSync(realTmp, link);
    // 经 link 拼 realTmp 的其余部分 + parent 名 + target 名
    const rel = path.relative(realTmp, t);
    const input = path.join(link, rel);
    const r = record('via-tmp', input, false, 'r4b');
    const ok = r.status !== 0 && fs.existsSync(t) && sha(sentinel) === sha0;
    log.push({ case: 'via-tmp(link→realTmp inside tmp)', input_kind: 'symlink inside tmp targeting realTmp', exit: r.status, target_exists: fs.existsSync(t), sentinel_unchanged: sha(sentinel) === sha0, ok, stderr: (r.stderr || '').slice(0, 120) });
    console.log(`${ok ? 'PASS' : 'FAIL'} via-tmp: exit=${r.status} target=${fs.existsSync(t)} sentinel=${sha(sentinel) === sha0}`);
  }
  // 3 via-sys-ancestor：临时目录内 link → realTmp 的系统祖先（/private/var）
  {
    const { t, sentinel, sha0 } = mkTarget(parent, 't-sysanc', 'r4c');
    const link = path.join(parent, 'via-sys');
    fs.symlinkSync(path.dirname(path.dirname(realTmp)), link); // /private/var（realTmp 的系统祖先）
    const rel = path.relative(path.dirname(path.dirname(realTmp)), t);
    const input = path.join(link, rel);
    const r = record('via-sys-ancestor', input, false, 'r4c');
    const ok = r.status !== 0 && fs.existsSync(t) && sha(sentinel) === sha0;
    log.push({ case: 'via-sys-ancestor(link→/private/var inside tmp)', exit: r.status, target_exists: fs.existsSync(t), sentinel_unchanged: sha(sentinel) === sha0, ok, stderr: (r.stderr || '').slice(0, 120) });
    console.log(`${ok ? 'PASS' : 'FAIL'} via-sys-ancestor: exit=${r.status} target=${fs.existsSync(t)} sentinel=${sha(sentinel) === sha0}`);
  }
  // 4 var-spelling：合法 root 用 /var 拼写 → 系统例外生效，清理成功
  {
    const { t } = mkTarget(parent, 't-var', 'r4d');
    const varSpelled = realTmp.replace(/^\/private/, '') ? t.replace(/^\/private/, '') : t;
    const r = record('var-spelling', varSpelled, true, 'r4d');
    const ok = r.status === 0 && !fs.existsSync(t);
    log.push({ case: 'var-spelling(/var 系统链接不误伤)', input: varSpelled, exit: r.status, target_exists: fs.existsSync(t), ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} var-spelling: exit=${r.status} cleaned=${!fs.existsSync(t)}`);
  }
  // 5 normal：直接路径 + 正确 run + 已退出 pid
  {
    const { t } = mkTarget(parent, 't-normal', 'r4e');
    const r = record('normal', t, true, 'r4e');
    const ok = r.status === 0 && !fs.existsSync(t);
    log.push({ case: 'normal', exit: r.status, target_exists: fs.existsSync(t), ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} normal: exit=${r.status} cleaned=${!fs.existsSync(t)}`);
  }
  // 6 wrong-run
  {
    const { t, sentinel, sha0 } = mkTarget(parent, 't-wrong', 'r4f');
    const r = record('wrong-run', t, false, 'not-the-run');
    const ok = r.status !== 0 && fs.existsSync(t) && sha(sentinel) === sha0;
    log.push({ case: 'wrong-run', exit: r.status, target_exists: fs.existsSync(t), ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} wrong-run: exit=${r.status} target=${fs.existsSync(t)}`);
  }
  // 7 live-pid
  {
    const { t, sentinel, sha0 } = mkTarget(parent, 't-live', 'r4g');
    const live = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { detached: false, stdio: 'ignore' }); // spawnSync 同步等待…改用 spawn
    const { spawn } = await import('node:child_process');
    const lv = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(t, 'current-run.json'), JSON.stringify({ run: 'r4g', pid: lv.pid }));
    const r = record('live-pid', t, false, 'r4g');
    const ok = r.status !== 0 && fs.existsSync(t) && sha(sentinel) === sha0;
    lv.kill('SIGKILL'); lv.on('exit', () => {});
    log.push({ case: 'live-pid', exit: r.status, target_exists: fs.existsSync(t), ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} live-pid: exit=${r.status} target=${fs.existsSync(t)}`);
  }

  results.push(...log);
  fs.writeFileSync(path.join(outDir, 'clean-alias-regression.json'),
    JSON.stringify({ coverage: 'actual clean CLI; synthetic owned targets and sentinels only; no production data', results: log }, null, 2));
  const failed = log.filter(x => !x.ok).length;
  console.log(failed ? `clean-alias-regression: ${failed} 例失败` : 'clean-alias-regression: 7/7 通过');
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) { /* live-pid 目标目录可能被占用 */ }
  process.exit(failed ? 1 : 0);
}
main();
