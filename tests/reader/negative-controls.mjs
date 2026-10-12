#!/usr/bin/env node
// tests/reader/negative-controls.mjs —— 验证器的负向控制（P0-B01-REPAIR-01 / 门 2 / R1-F01）。
//
// 全部使用合成数据（自有 mkdtemp 目录），不触碰生产路径、不启动 App。
// 每个用例构造一个「看似通过」的损坏 root，运行 tests/reader/verify.mjs，
// 断言其退出码非 0（PENDING 的 exit 3 也算非 0，但除「缺 prod-after」用例显式期待 3/1 外，
// 其余损坏必须拿到 1=FAIL，而不是靠 PENDING 蒙混）。
// 最后一个用例是正向控制：完整合法的 after-ui 状态必须 exit 0——证明负向控制不是
// 「verify 永远报错」的假阴性。
//
// 用法：node tests/reader/negative-controls.mjs

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACH_FILES, COPY_EXPECTED, SUGGESTIONS, fileNameOf } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(__dirname, 'verify.mjs');
const MARKER_OWNER = 'nayan-reader-regression';
const RUN = 'negctrl' + randomBytes(4).toString('hex');

// 与 app/src-tauri/src/main.rs open_db 的 DDL 镜像（仅用于构造验证器测试数据；
// schema 变更时此处需同步——测试目录内的显式依赖，不构成第二份生产实现）
const DDL = `
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, quote TEXT DEFAULT '',
  my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '',
  session_ref TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox',
  kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2,
  created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')),
  user_msg TEXT DEFAULT '', window_id INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER NOT NULL, path TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

function sha256Text(s) { return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'); }

/// 构造一个合法的 after-ui 状态 root；corrupt 回调在其上做定向破坏
function buildRoot({ corrupt } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-vc-'));
  const filesDir = path.join(root, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'nayan-test-owned.json'),
    JSON.stringify({ owner: MARKER_OWNER, run_id: RUN, pid: process.pid, created_at: 0 }));
  const db = new DatabaseSync(path.join(root, 'inbox.db'));
  db.exec(DDL);
  const skipSuggestion = corrupt?.skipSuggestion || null;
  let sid = 0;
  const idOf = new Map();
  for (const s of SUGGESTIONS) {
    if (corrupt?.skipAllSuggestions) break;
    if (corrupt?.renameTitle === s.key) {
      idOf.set(s.key, ++sid);
      db.prepare('INSERT INTO suggestions (id, title, quote) VALUES (?,?,?)').run(sid, '被改名的标题', s.quote);
      continue;
    }
    if (corrupt?.duplicateTitle === s.key) {
      idOf.set(s.key, ++sid);
      db.prepare('INSERT INTO suggestions (id, title, quote) VALUES (?,?,?)').run(sid, s.title, s.quote);
      // 同名第二行用远离种子的 id，制造「标题重复但 id 不同」的损坏
      db.prepare('INSERT INTO suggestions (id, title, quote) VALUES (?,?,?)').run(900 + sid, s.title, s.quote);
      continue;
    }
    if (skipSuggestion === s.key) continue;
    idOf.set(s.key, ++sid);
    const quote = corrupt?.changeQuote === s.key ? s.quote + ' 被篡改' : s.quote;
    db.prepare('INSERT INTO suggestions (id, title, quote) VALUES (?,?,?)').run(sid, s.title, quote);
  }
  // 附件：种子绑定 + after-ui 净效果（T1 增加运行期引用）
  const bind = [];
  for (const f of ATTACH_FILES) {
    if (!f.forKey || corrupt?.skipAllSuggestions) continue;
    const sidForFile = idOf.get(f.forKey);
    if (sidForFile == null) continue; // 所属正文行被跳过时，其附件绑定一并跳过
    if (corrupt?.misbind === f.forKey) {
      const wrongSid = idOf.get(corrupt.misbindTo);
      db.prepare('INSERT INTO attachments (suggestion_id, path, name) VALUES (?,?,?)').run(wrongSid, path.join(filesDir, fileNameOf(f)), fileNameOf(f));
      continue;
    }
    db.prepare('INSERT INTO attachments (suggestion_id, path, name) VALUES (?,?,?)').run(sidForFile, path.join(filesDir, fileNameOf(f)), fileNameOf(f));
    bind.push(f);
  }
  // after-ui：T1 的运行期引用
  const runtime = ATTACH_FILES.find(f => f.forKey === null);
  if (!corrupt?.skipAllSuggestions) {
    db.prepare('INSERT INTO attachments (suggestion_id, path, name) VALUES (?,?,?)').run(idOf.get('t1'), path.join(filesDir, fileNameOf(runtime)), fileNameOf(runtime));
  }
  if (corrupt?.orphanAttachments) {
    for (let i = 0; i < 6; i++) {
      db.prepare('INSERT INTO attachments (suggestion_id, path, name) VALUES (?,?,?)').run(999 + i, '/synthetic/orphan.md', 'orphan.md');
    }
  }
  db.close();
  // 源文件（runtime 文件已在 ATTACH_FILES 循环内一并处理，勿重复计入）
  const manifestFiles = [];
  for (const f of ATTACH_FILES) {
    const p = path.join(filesDir, fileNameOf(f));
    if (!f.deleteAfterAttach) {
      const isRuntime = f.forKey === null;
      const skip = corrupt?.missingFile === (isRuntime ? 't1-runtime' : f.forKey);
      if (!skip) fs.writeFileSync(p, f.content, 'utf8');
    }
    manifestFiles.push({ abs: p, name: fileNameOf(f), deleted: !!f.deleteAfterAttach, sha256: sha256Text(f.content) });
  }
  // manifest
  if (!corrupt?.dropManifest) {
    fs.writeFileSync(path.join(root, 'manifest-seed.json'),
      JSON.stringify({ root, run: RUN, idOf: Object.fromEntries(idOf), files: corrupt?.emptyManifest ? [] : manifestFiles }, null, 2));
  }
  // 生产快照 + run 绑定结束证据（R2-F02 格式）
  const snap = JSON.stringify({ '/synthetic/prod': { size: 1, mtimeMs: 1 } }, null, 2);
  fs.writeFileSync(path.join(root, 'prod-before.json'), snap);
  if (!corrupt?.dropAfter) {
    const afterRun = corrupt?.staleAfterRun ? 'an-old-run' : RUN;
    fs.writeFileSync(path.join(root, 'prod-after.json'),
      JSON.stringify({ run: afterRun, pid: 424242, finishedAt: 0, snapshot: JSON.parse(snap) }, null, 2));
  }
  if (!corrupt?.dropRunExit) {
    fs.writeFileSync(path.join(root, 'run-exit.json'),
      JSON.stringify({ run: RUN, pid: 424242, code: 0, clean: corrupt?.dirtyExit ? false : true, finishedAt: 0 }, null, 2));
  }
  // run 身份 + sink
  fs.writeFileSync(path.join(root, 'current-run.json'), JSON.stringify({ run: RUN }));
  if (!corrupt?.dropSink) {
    const lines = [];
    for (const c of COPY_EXPECTED) {
      const text = corrupt?.staleSink ? c.quote : c.quote;
      const run = corrupt?.staleSink ? 'an-old-run' : RUN;
      lines.push(JSON.stringify({ run, label: c.label, text, at_unix_ms: 1 }));
    }
    fs.writeFileSync(path.join(root, 'copy-sink.jsonl'), lines.join('\n') + '\n');
  }
  return root;
}

function runVerify(root, extra = []) {
  const r = spawnSync(process.execPath, [VERIFY, '--root', root, '--phase', 'after-ui', ...extra], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const cases = [];
function caseRun(name, corrupt, { expectCodes = [1], extra = [] } = {}) {
  const root = buildRoot({ corrupt });
  const { code, out } = runVerify(root, extra);
  const ok = expectCodes.includes(code);
  const firstFail = out.split('\n').filter(l => l.startsWith('FAIL')).slice(0, 2).join(' | ');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: verify exit=${code}（期望 ${expectCodes.join('/')}）${firstFail ? ' — ' + firstFail : ''}`);
  cases.push(ok);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// ---- 总控反例（R1-F01 原样场景）：0 正文+6 孤儿+空清单+sink+缺 after → 旧版 exit 0 ----
// （先放「有正文但孤儿+空清单」的完整组合，再放更极端的 0 正文版本）
caseRun('总控复合反例（孤儿+空清单+缺after）', { orphanAttachments: true, emptyManifest: true, dropAfter: true }, { expectCodes: [1] });
caseRun('0 正文极端版', { skipSuggestion: 't1', skipAllSuggestions: true, orphanAttachments: true, emptyManifest: true, dropAfter: true, dropSink: true }, { expectCodes: [1] });
caseRun('缺一条正文行', { skipSuggestion: 't3' });
caseRun('标题被改名', { renameTitle: 't3' });
caseRun('标题重复', { duplicateTitle: 't3' });
caseRun('quote 被篡改', { changeQuote: 't5' });
caseRun('附件错绑（t2 的挂到 t1）', { misbind: 't2', misbindTo: 't1' });
caseRun('源文件丢失', { missingFile: 't3' });
caseRun('运行期引用源文件丢失', { missingFile: 't1-runtime' });
caseRun('manifest 缺失', { dropManifest: true });
caseRun('manifest 空清单', { emptyManifest: true });
caseRun('sink 只有旧 run 记录', { staleSink: true });
caseRun('sink 缺失', { dropSink: true });
caseRun('缺 prod-after（最终模式）', { dropAfter: true }, { expectCodes: [1] });
caseRun('缺 prod-after（--mid-run 应 PENDING exit 3）', { dropAfter: true }, { expectCodes: [3], extra: ['--mid-run'] });
// R2-F02 负例族：旧 run 的 after 即使内容相同也不得被当前 run 消费
caseRun('旧 run 的 after（最终模式拒绝）', { staleAfterRun: true }, { expectCodes: [1] });
caseRun('旧 run 的 after（mid-run PENDING 3）', { staleAfterRun: true }, { expectCodes: [3], extra: ['--mid-run'] });
caseRun('缺 run-exit（最终模式拒绝）', { dropRunExit: true }, { expectCodes: [1] });
caseRun('缺 run-exit（mid-run PENDING 3）', { dropRunExit: true }, { expectCodes: [3], extra: ['--mid-run'] });
caseRun('run-exit.clean=false（异常退出拒绝）', { dirtyExit: true }, { expectCodes: [1] });

// ---- 正向控制：完整合法状态必须 exit 0（证明验证器并非一律报错） ----
{
  const root = buildRoot({});
  const { code, out } = runVerify(root);
  const ok = code === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} 正向控制：完整合法状态 exit=0（实际 exit=${code}）`);
  if (!ok) console.log(out);
  cases.push(ok);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

const pass = cases.every(Boolean);
console.log(pass ? 'negative-controls: 全部通过（验证器负向控制成立 + 正向不误伤）'
                 : 'negative-controls: 存在失败用例');
process.exit(pass ? 0 : 1);
