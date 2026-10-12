#!/usr/bin/env node
// P1-B02-REPAIR-03：Rust 规格 ↔ JS 门控一致性矩阵测试。
// 对同一批合成库，先经真实 Rust 迁移驱动（driver_init_db / migrate 预期）得到
// 「Rust 接受/拒绝」事实，再用共享 schema-gate.mjs 校验，断言两者判定一致——
// 不允许 Rust 接受而 JS 拒绝（会挡生产库），也不允许 Rust 拒绝而 JS 接受（会放行畸形）。
//
// 用法：node tests/migrations/schema-gate-consistency.mjs [--out DIR]

import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSchemaCompat } from '../../schema-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-schema-gate-consistency-'));
fs.mkdirSync(outDir, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-r3-cons-'));
const results = [];
function rec(name, ok, detail) { results.push({ name, ok, detail: String(detail).slice(0, 160) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${String(detail).slice(0, 120)}`); }

function rustOpenAndMigrate(dbPath) {
  // 真实 Rust 权威入口（驱动测试以 env 建库；对既有库则先建再迁移的路径由 driver 覆盖）。
  const r = spawnSync('cargo', ['test', '--offline', 'migrations::tests::driver_init_db', '--', '--nocapture'], {
    cwd: path.join(REPO, 'app/src-tauri'),
    env: { ...process.env, NAYAN_MIGRATION_INIT_DB: dbPath },
    encoding: 'utf8', timeout: 120000,
  });
  return r.status === 0;
}
function rustMigrateVerdict(dbPath) {
  // Rust 判定 = driver 能否成功 open_and_migrate 该库（status 0 = 接受）。
  return rustOpenAndMigrate(dbPath);
}
const v5 = fs.readFileSync(path.join(__dirname, 'fixtures/v0-5-no-window.sql'), 'utf8').replace(/^--.*$/gm, '');
const v1full = fs.readFileSync(path.join(__dirname, 'fixtures/v1-full.sql'), 'utf8').replace(/^--.*$/gm, '');

/// 逐条矩阵：Rust 判定（真实 open_and_migrate） vs JS 判定（共享门控）
const cases = [];
function addCase(name, build, rustExpect, jsExpectNote) {
  cases.push({ name, build, rustExpect, jsExpectNote });
}

// 正例：Rust 建出的 v2（Rust 接受 → JS 必须接受）
addCase('C1 Rust-init v2', (db) => { rustOpenAndMigrate(db); }, true, 'uv=2');
// 正例：三种历史 fixture（Rust 接受并升级 → 升级后 JS 接受；升级前 JS 也须接受 legacy）
for (const [fx, sql] of [['v1-full', v1full], ['v0-5', v5]]) {
  addCase('C2 legacy ' + fx + '（升级前）', (db) => {
    const c = new DatabaseSync(db); c.exec('PRAGMA busy_timeout=2000;'); c.exec(sql); c.close();
  }, 'pre', 'uv=0');
}
// 负例：quote INTEGER（v0/v2）——Rust migrate 拒绝 → JS 拒绝
function typedQuote(ver) {
  return (db) => {
    const c = new DatabaseSync(db); c.exec('PRAGMA busy_timeout=2000;');
    c.exec("CREATE TABLE suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, quote INTEGER DEFAULT 0, my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', session_ref TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')), user_msg TEXT DEFAULT '', window_id INTEGER DEFAULT 0" + (ver === 2 ? ", content_envelope TEXT" : "") + ");");
    c.exec('CREATE TABLE steps (id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER NOT NULL, content TEXT NOT NULL, is_cmd INTEGER DEFAULT 0, done INTEGER DEFAULT 0, ord INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime(\'now\',\'localtime\')), result TEXT DEFAULT \'\');');
    c.exec('CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL DEFAULT \'\', created_at TEXT DEFAULT (datetime(\'now\',\'localtime\')));');
    c.exec("CREATE TABLE session_aliases (app TEXT NOT NULL, session_ref TEXT NOT NULL, window_id INTEGER NOT NULL DEFAULT 0, alias TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY (app, session_ref, window_id));");
    c.exec('PRAGMA user_version=' + ver + ';');
    c.close();
  };
}
addCase('C3 quote INTEGER v0', typedQuote(0), false);
addCase('C4 quote INTEGER v2', typedQuote(2), false);
// 负例：CTAS 丢主键 / attachments(id) / 伪 v2（v1 表标 uv2）——Rust 拒 → JS 拒
addCase('C5 CTAS 丢主键 v0', (db) => {
  const c = new DatabaseSync(db); c.exec('PRAGMA busy_timeout=2000;'); c.exec(v5);
  c.exec('CREATE TABLE sug2 AS SELECT * FROM suggestions; DROP TABLE suggestions; ALTER TABLE sug2 RENAME TO suggestions;'); c.close();
}, false);
addCase('C6 attachments(id) v0', (db) => {
  const c = new DatabaseSync(db); c.exec('PRAGMA busy_timeout=2000;'); c.exec(v1full);
  c.exec('DROP TABLE attachments; CREATE TABLE attachments (id INTEGER PRIMARY KEY);'); c.close();
}, false);
addCase('C7 伪 v2（v1 表标 uv2）', (db) => {
  const c = new DatabaseSync(db); c.exec('PRAGMA busy_timeout=2000;'); c.exec(v1full);
  c.exec('PRAGMA user_version=2;'); c.close();
}, false);
// 负例：v0 却有 envelope → 双方都拒
addCase('C8 v0+envelope', (db) => {
  const c = new DatabaseSync(db); c.exec('PRAGMA busy_timeout=2000;'); c.exec(v1full);
  c.exec('ALTER TABLE suggestions ADD COLUMN content_envelope TEXT;'); c.close();
}, false);

for (const c of cases) {
  const db = path.join(work, c.name.replace(/[^a-zA-Z0-9]/g, '_') + '.db');
  c.build(db);
  const rustOk = rustMigrateVerdict(db);
  // JS 门控判定：按库当前 uv
  let jsOk, jsReason = '';
  {
    const conn = new DatabaseSync(db); conn.exec('PRAGMA busy_timeout=2000;');
    const uv = conn.prepare('PRAGMA user_version').get().user_version;
    const g = checkSchemaCompat(conn, uv);
    jsOk = g.ok; jsReason = g.reason || '';
    conn.close();
  }
  if (c.rustExpect === 'pre') {
    // legacy 升级前：Rust 接受（会升级），JS 也必须接受（允许 quote-only）
    rec(c.name + '：Rust 接受 ⇒ JS 接受', rustOk && jsOk, `rust=${rustOk} js=${jsOk} ${jsReason.slice(0, 60)}`);
  } else {
    const agree = rustOk === c.rustExpect && jsOk === c.rustExpect;
    rec(c.name + `：双方一致（期望 ${c.rustExpect ? '接受' : '拒绝'}）`, agree && rustOk === jsOk,
      `rust=${rustOk} js=${jsOk} ${jsReason.slice(0, 60)}`);
  }
  fs.rmSync(db, { force: true });
}

fs.writeFileSync(path.join(outDir, 'schema-gate-consistency.json'),
  JSON.stringify({ coverage: 'Rust verdict via real open_and_migrate driver vs shared JS gate on identical synthetic DBs', results }, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(failed ? `schema-gate-consistency: ${failed} 例失败` : 'schema-gate-consistency: 全部一致');
fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
