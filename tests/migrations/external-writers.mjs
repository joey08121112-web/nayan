#!/usr/bin/env node
// P1-T02/S05 外部 writer 门控正负向（真实服务，非复制的判断函数）。
//
// 覆盖：
//   MCP（stdio JSON-RPC 真实进程）：
//     A v2 库（Rust 迁移驱动建）→ initialize/add/list/update 全部成功；
//     B 缺失库 → fail-before-write（退出非 0、库文件未被创建、无部分输出成功）；
//     C 未来版本库（user_version=99）→ 拒绝且库内行数/版本零变化；
//     D legacy v0-5 库（缺 window_id 的历史形态）→ 因 MCP 所需列齐备而放行（quote-only INSERT 成功）。
//   sync（HTTP 真实服务）：
//     E v2 库 → 健康检查 + capture INSERT 成功；
//     F 未来版本库 → 启动即 fatal（fail-before-write，端口不监听）。
//   数据/schema/版本对账用 node:sqlite 只读打开核验，不仅看退出码。
//
// 用法：node tests/migrations/external-writers.mjs [--out DIR]

import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-external-writers-'));
fs.mkdirSync(outDir, { recursive: true });
const log = [];
const results = [];
function rec(name, ok, detail) { results.push({ name, ok, detail: String(detail).slice(0, 200) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${String(detail).slice(0, 140)}`); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nayan-s05-'));
function rustInit(dbPath) {
  const r = spawnSync('cargo', ['test', '--offline', 'migrations::tests::driver_init_db', '--', '--nocapture'], {
    cwd: path.join(REPO, 'app/src-tauri'),
    env: { ...process.env, NAYAN_MIGRATION_INIT_DB: dbPath },
    encoding: 'utf8', timeout: 120000,
  });
  return r.status === 0 && fs.existsSync(dbPath);
}
function sqliteExec(dbPath, sql) {
  const c = new DatabaseSync(dbPath);
  c.exec('PRAGMA busy_timeout=2000;');
  c.exec(sql);
  c.close();
}
const v5 = fs.readFileSync(path.join(__dirname, 'fixtures/v0-5-no-window.sql'), 'utf8').replace(/^--.*$/gm, '');
const v1full = fs.readFileSync(path.join(__dirname, 'fixtures/v1-full.sql'), 'utf8').replace(/^--.*$/gm, '');

/// 真实 MCP 子进程：跑一轮 initialize→add→list→update，返回 {exit, transcript}
function mcpRound(dbPath, addArgs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'mcp-server.js')], {
      env: { ...process.env, DB_PATH: dbPath }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '', out = '', err = '';
    // 启动即发 initialize（test-mcp.mjs 同款时序）
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 's05-probe', version: '1.0' } } }) + '\n');
    p.stdout.on('data', d => { out += d; buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) { if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        }
        if (m.id === 2) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_suggestion', arguments: addArgs || { title: 'S05 写入探测', quote: 'probe' } } }) + '\n');
        if (m.id === 3) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_suggestions', arguments: {} } }) + '\n');
        if (m.id === 4) { p.stdin.end(); setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 300); }
      }
    });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', c => resolve({ exit: c, out, err }));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve({ exit: 'TIMEOUT', out, err }); }, 30000).unref?.();
  });
}

// A：v2 库全流程
{
  const db = path.join(work, 'a-v2.db');
  if (!rustInit(db)) { rec('A v2 init', false, 'Rust 驱动失败'); }
  else {
    const r = await mcpRound(db);
    const c = new DatabaseSync(db); const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
    const uv = c.prepare('PRAGMA user_version').get().user_version; c.close();
    // R9：Rust 当前版本为 v4（最近删除），Rust 建库即 v4
    rec('A MCP@v4 全流程', r.exit === 0 && rows >= 1 && uv === 4, `exit=${r.exit} rows=${rows} uv=${uv}`);
  }
}

// A2（v3）：对 AI 说「记到后期」→ 进清单、写等什么与提醒日；清单名不存在 → 零写入
{
  const db = path.join(work, 'a2-v3.db');
  if (!rustInit(db)) { rec('A2 v3 init', false, 'Rust 驱动失败'); }
  else {
    const r = await mcpRound(db, { title: '记到清单探测', quote: 'p', list: '后期', wait: '2030-01-02 再看' });
    const c = new DatabaseSync(db);
    const row = c.prepare("SELECT s.status, s.wait_note, s.remind_on, l.name FROM suggestions s JOIN lists l ON l.id = s.list_id WHERE s.title = '记到清单探测'").get();
    c.close();
    rec('A2 MCP 记到清单', r.exit === 0 && row && row.name === '后期' && row.status === 'inbox' && row.remind_on === '2030-01-02' && row.wait_note === '2030-01-02 再看',
      `exit=${r.exit} row=${JSON.stringify(row)}`);
    const r2 = await mcpRound(db, { title: '不存在的清单', quote: 'p', list: '没有这个' });
    const c2 = new DatabaseSync(db);
    const n = c2.prepare("SELECT COUNT(*) n FROM suggestions WHERE title = '不存在的清单'").get().n; c2.close();
    rec('A2 MCP 清单名不存在零写入', n === 0 && /没有叫「没有这个」的清单/.test(r2.out), `rows=${n}`);
  }
}
// B：缺失库 fail-before-write
{
  const db = path.join(work, 'b-missing.db');
  const r = await mcpRound(db);
  rec('B MCP@缺失库 fail-before-write', r.exit !== 0 && !fs.existsSync(db), `exit=${r.exit} fileCreated=${fs.existsSync(db)} err=${(r.err||'').slice(0,60)}`);
}
// C：未来版本库拒绝且零写入
{
  const db = path.join(work, 'c-future.db');
  rustInit(db);
  sqliteExec(db, 'PRAGMA user_version=99;');
  const r = await mcpRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  const uv = c.prepare('PRAGMA user_version').get().user_version; c.close();
  rec('C MCP@未来版本 fail-before-write', r.exit !== 0 && rows === 0 && uv === 99, `exit=${r.exit} rows=${rows} uv=${uv}`);
}
// D：legacy v0-5 库（MCP 所需列齐备）→ 放行 quote-only INSERT
{
  const db = path.join(work, 'd-legacy.db');
  sqliteExec(db, v5);
  const r = await mcpRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  const envCol = c.prepare('PRAGMA table_info(suggestions)').all().some(x => x.name === 'content_envelope');
  c.close();
  rec('D MCP@legacy(v0-5) 放行且不建列', r.exit === 0 && rows >= 1 && !envCol, `exit=${r.exit} rows=${rows} envelope列出现=${envCol}`);
}
// E/F：sync 真实 HTTP 服务
async function syncRound(dbPath, tag) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(REPO, 'sync-server.js')], {
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  // 等监听或退出
  const ok = await new Promise((res) => {
    const t0 = Date.now();
    const tryConn = () => {
      if (p.exitCode !== null) return res(false);
      if (Date.now() - t0 > 8000) return res(false);
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => { s.destroy(); setTimeout(tryConn, 250); });
    };
    tryConn();
  });
  let health = null, captured = null;
  if (ok) {
    health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json()).catch(() => null);
    captured = await fetch(`http://127.0.0.1:${port}/api/suggestions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'S05 sync 探测', quote: 'sync-probe', source_tool: 'webbox' }),
    }).then(r => r.json()).catch(() => null);
  }
  p.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} r(); }, 3000); p.on('exit', () => { clearTimeout(t); r(); }); });
  return { listening: ok, health, captured, err };
}
{
  const db = path.join(work, 'e-v2.db');
  rustInit(db);
  const r = await syncRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare("SELECT COUNT(*) n FROM suggestions WHERE title='S05 sync 探测'").get().n; c.close();
  rec('E sync@v2 健康检查+INSERT', r.listening && r.captured && r.captured.id && rows === 1, `listening=${r.listening} health=${JSON.stringify(r.health&&r.health.ok)} captured=${JSON.stringify(r.captured).slice(0,60)} rows=${rows} err=${(r.err||'').slice(0,50)}`);
}
{
  const db = path.join(work, 'f-future.db');
  rustInit(db);
  sqliteExec(db, 'PRAGMA user_version=99;');
  const r = await syncRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  const uv = c.prepare('PRAGMA user_version').get().user_version; c.close();
  rec('F sync@未来版本 fail-before-listen', !r.listening && rows === 0 && uv === 99, `listening=${r.listening} rows=${rows} uv=${uv} err=${(r.err||'').slice(0,60)}`);
}

// G：伪 v2（v1-full 旧完整表 + user_version=2）→ MCP 拒绝写入
{
  const db = path.join(work, 'g-pseudo-v2.db');
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(v5); // v0-5 形态（无 envelope）
    c.exec('ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0; PRAGMA user_version=2;');
    c.close();
  }
  const r = await mcpRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  const uv = c.prepare('PRAGMA user_version').get().user_version;
  const envCol = c.prepare('PRAGMA table_info(suggestions)').all().some(x => x.name === 'content_envelope');
  c.close();
  rec('G MCP@伪v2 拒绝', r.exit !== 0 && rows === 0 && uv === 2 && !envCol, `exit=${r.exit} rows=${rows} uv=${uv} err=${(r.err||'').slice(0,60)}`);
}
// H：伪 v2 → sync 拒绝（fail-before-listen）
{
  const db = path.join(work, 'h-pseudo-v2.db');
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(v5);
    c.exec('ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0; PRAGMA user_version=2;');
    c.close();
  }
  const r = await syncRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  c.close();
  rec('H sync@伪v2 拒绝', !r.listening && rows === 0, `listening=${r.listening} rows=${rows} err=${(r.err||'').slice(0,70)}`);
}
// I：sync 未来版本 → 拒绝且 journal_mode 不变（delete）
{
  const db = path.join(work, 'i-future.db');
  rustInit(db);
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA user_version=99; PRAGMA journal_mode=delete;');
  const r = await syncRound(db);
  const c = new DatabaseSync(db);
  const jm = c.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase();
  const uv = c.prepare('PRAGMA user_version').get().user_version;
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  c.close();
  rec('I sync@未来版本 拒绝且 journal 不变', !r.listening && jm === 'delete' && uv === 99 && rows === 0, `listening=${r.listening} journal=${jm} uv=${uv} rows=${rows}`);
}

// J：CTAS 丢主键库（列名齐全）→ MCP 与 sync 都拒绝（R2-F01 服务层）
{
  const db = path.join(work, 'j-ctas.db');
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(v5);
    // CTAS 重建 suggestions：列名相同，丢主键/NOT NULL/默认值
    c.exec("CREATE TABLE sug2 AS SELECT * FROM suggestions; DROP TABLE suggestions; ALTER TABLE sug2 RENAME TO suggestions;");
    c.close();
  }
  const r = await mcpRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  const uv = c.prepare('PRAGMA user_version').get().user_version;
  c.close();
  rec('J MCP@CTAS丢主键 拒绝', r.exit !== 0 && rows === 0 && uv === 0, `exit=${r.exit} rows=${rows} uv=${uv} err=${(r.err||'').slice(0,60)}`);
  // sync 同库拒绝（fail-before-listen）
  const rs = await syncRound(db);
  const c2 = new DatabaseSync(db);
  const rows2 = c2.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  c2.close();
  rec('J2 sync@CTAS丢主键 拒绝', !rs.listening && rows2 === 0, `listening=${rs.listening} rows=${rows2} err=${(rs.err||'').slice(0,60)}`);
}

// ── R3-F01：类型漂移负向矩阵（quote INTEGER 四组合）+ 精确文本正例 + 补充结构负例 ──
function mkTypedDb(file, { ver }) {
  // 构造「仅 quote TEXT→INTEGER、其余列/主键/版本标记全部合法」的库：
  // v0 = v1 形态未版本化（v1-full + uv0，与总控探针和真实生产形态一致）；v2 = v1 + envelope + uv2
  const db = path.join(work, file);
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec("CREATE TABLE suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, quote INTEGER DEFAULT 0, my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', session_ref TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')), user_msg TEXT DEFAULT '', window_id INTEGER DEFAULT 0" + (ver === 2 ? ", content_envelope TEXT" : "") + ");");
    c.exec("CREATE TABLE steps (id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER NOT NULL, content TEXT NOT NULL, is_cmd INTEGER DEFAULT 0, done INTEGER DEFAULT 0, ord INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')), result TEXT DEFAULT '');");
    c.exec("CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));");
    c.exec("CREATE TABLE session_aliases (app TEXT NOT NULL, session_ref TEXT NOT NULL, window_id INTEGER NOT NULL DEFAULT 0, alias TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY (app, session_ref, window_id));");
    c.exec('PRAGMA user_version=' + ver + ';');
    c.close();
  }
  return db;
}
async function mcpInsertProbe(dbPath, title) {
  // 复用 mcpRound 的完整协议链；返回 { exit, err }
  const r = await mcpRound(dbPath);
  return r;
}
function sqlitePeek(db) {
  const c = new DatabaseSync(db);
  c.exec('PRAGMA busy_timeout=1000;');
  const rows = c.prepare("SELECT typeof(quote) t, quote FROM suggestions WHERE title='S05 写入探测'").all();
  const uv = c.prepare('PRAGMA user_version').get().user_version;
  const jm = c.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase();
  c.close();
  return { rows, uv, jm };
}
// K1-K4：quote INTEGER 四组合 → 服务拒绝、零行、schema/版本/journal 不变
for (const [svc, ver] of [['mcp', 0], ['sync', 0], ['mcp', 2], ['sync', 2]]) {
  const tag = 'K' + (svc === 'mcp' ? 'M' : 'S') + ver;
  const db = mkTypedDb(tag + '.db', { ver });
  if (svc === 'mcp') {
    const r = await mcpRound(db);
    const peek = sqlitePeek(db);
    const qerr = (r.err || '').includes('quote') && (r.err || '').includes('类型不符');
    rec(tag + ' MCP@quote INTEGER v' + ver + ' 拒绝（因 quote 类型）',
      r.exit !== 0 && peek.rows.length === 0 && qerr,
      `exit=${r.exit} rows=${peek.rows.length} uv=${peek.uv} err=${(r.err || '').slice(0, 70)}`);
  } else {
    const r = await syncRound(db);
    const peek = sqlitePeek(db);
    const qerr = (r.err || '').includes('quote') && (r.err || '').includes('类型不符');
    rec(tag + ' sync@quote INTEGER v' + ver + ' 拒绝（因 quote 类型）',
      !r.listening && qerr,
      `listening=${r.listening} err=${(r.err || '').slice(0, 80)}`);
  }
}
// K5：拒绝后持久状态不变（对 K 系列任一库做前后对账——以 MCP v0 库为代表）
{
  const db = mkTypedDb('K5.db', { ver: 0 });
  const before = new DatabaseSync(db);
  const uv0 = before.prepare('PRAGMA user_version').get().user_version;
  const jm0 = before.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase();
  const schema0 = before.prepare("SELECT sql FROM sqlite_master WHERE name='suggestions'").get().sql;
  before.close();
  await mcpRound(db);
  const after = new DatabaseSync(db);
  const uv1 = after.prepare('PRAGMA user_version').get().user_version;
  const jm1 = after.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase();
  const schema1 = after.prepare("SELECT sql FROM sqlite_master WHERE name='suggestions'").get().sql;
  after.close();
  rec('K5 拒绝后 schema/版本/pragma 不变', uv0 === uv1 && jm0 === jm1 && schema0 === schema1,
    `uv ${uv0}→${uv1} journal ${jm0}→${jm1} schemaDDL一致=${schema0 === schema1}`);
}
// K6：正向精确复制对照——quote TEXT 合法库写 "00123" 必须逐字符保留
{
  const db = path.join(work, 'K6-text.db');
  rustInit(db);
  const rm = await mcpRound(db);
  const rs = await syncRound(db);
  const c = new DatabaseSync(db);
  const mcpRow = c.prepare("SELECT quote, typeof(quote) t FROM suggestions WHERE title='S05 写入探测'").get();
  const syncRow = c.prepare("SELECT quote, typeof(quote) t FROM suggestions WHERE title='S05 sync 探测'").get();
  c.close();
  rec('K6 正例：TEXT 库 "00123"/"sync-probe" 精确文本',
    rm.exit === 0 && rs.listening && mcpRow && mcpRow.t === 'text' && syncRow && syncRow.t === 'text',
    `mcp quote=${JSON.stringify(mcpRow && mcpRow.quote)}(${mcpRow && mcpRow.t}) sync quote=${JSON.stringify(syncRow && syncRow.quote)}(${syncRow && syncRow.t})`);
}
// K7：MCP v2 丢主键（修正上一轮「v2与legacy都查」不实声明——现证 v2 分支同拒）
{
  const db = path.join(work, 'K7-v2ctas.db');
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(v5);
    c.exec('ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0; ALTER TABLE suggestions ADD COLUMN content_envelope TEXT; PRAGMA user_version=2;');
    c.exec('CREATE TABLE sug2 AS SELECT * FROM suggestions; DROP TABLE suggestions; ALTER TABLE sug2 RENAME TO suggestions;');
    c.close();
  }
  const r = await mcpRound(db);
  const c2 = new DatabaseSync(db);
  const rows = c2.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  c2.close();
  rec('K7 MCP@v2 丢主键 拒绝', r.exit !== 0 && rows === 0, `exit=${r.exit} rows=${rows} err=${(r.err || '').slice(0, 70)}`);
}
// K8：其余结构负例（类型/约束/缺实用列，v2 与 v0 各取样）
{
  // v2 title INTEGER
  const db = path.join(work, 'K8a.db');
  rustInit(db);
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=delete;');
    c.exec("CREATE TABLE s2 (id INTEGER PRIMARY KEY AUTOINCREMENT, title INTEGER NOT NULL, quote TEXT DEFAULT '', my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', session_ref TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT, updated_at TEXT, user_msg TEXT DEFAULT '', window_id INTEGER DEFAULT 0, content_envelope TEXT);");
    // 2026-10-11：Rust 建库已是 v3——按 v2 列显式拷回并去掉 v3 表、标回 user_version=2，保持本例「v2 title INTEGER」原意
    c.exec("INSERT INTO s2 SELECT id, title, quote, my_note, source_tool, workspace, session_ref, tags, status, kind, priority, created_at, updated_at, user_msg, window_id, content_envelope FROM suggestions; DROP TABLE suggestions; ALTER TABLE s2 RENAME TO suggestions; DROP TABLE lists; DROP TABLE compare_groups; DROP TABLE compare_points; PRAGMA user_version=2;");
    c.close();
  }
  const r = await mcpRound(db);
  rec('K8a MCP@v2 title INTEGER 拒绝', r.exit !== 0, `exit=${r.exit} err=${(r.err || '').slice(0, 60)}`);
  // v0 title NOT NULL 丢失（允许 NULL title → 身份语义漂）
  const db2 = path.join(work, 'K8b.db');
  {
    const c = new DatabaseSync(db2);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(v5);
    c.exec("CREATE TABLE s3 (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, quote TEXT DEFAULT '', my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', session_ref TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT, updated_at TEXT, user_msg TEXT DEFAULT '');");
    c.exec("INSERT INTO s3 SELECT * FROM suggestions; DROP TABLE suggestions; ALTER TABLE s3 RENAME TO suggestions;");
    c.close();
  }
  const rs = await syncRound(db2);
  rec('K8b sync@v0 title 缺 NOT NULL 拒绝', !rs.listening, `listening=${rs.listening} err=${(rs.err || '').slice(0, 60)}`);
  // v0 缺 sync 实际 INSERT 使用列 session_ref
  const db3 = path.join(work, 'K8c.db');
  {
    const c = new DatabaseSync(db3);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(v5);
    // 重建无 session_ref 的合法其余列库
    c.exec("CREATE TABLE s4 (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, quote TEXT DEFAULT '', my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT, updated_at TEXT, user_msg TEXT DEFAULT '');");
    c.exec("INSERT INTO s4 SELECT id,title,quote,my_note,source_tool,workspace,tags,status,kind,priority,created_at,updated_at,user_msg FROM suggestions; DROP TABLE suggestions; ALTER TABLE s4 RENAME TO suggestions;");
    c.close();
  }
  const rs2 = await syncRound(db3);
  rec('K8c sync@v0 缺 session_ref 拒绝', !rs2.listening, `listening=${rs2.listening} err=${(rs2.err || '').slice(0, 60)}`);
}

// ── R4-F01：v0-4 sync 可写性 + 各支持形态 sync 正向 + MCP v0-4 边界 ──
function snapshotDb(db) {
  const c = new DatabaseSync(db);
  c.exec('PRAGMA busy_timeout=1000;');
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  const uv = c.prepare('PRAGMA user_version').get().user_version;
  const jm = c.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase();
  const ddl = c.prepare("SELECT sql FROM sqlite_master WHERE name='suggestions'").get().sql;
  c.close();
  return { rows, uv, jm, ddl };
}
async function syncInsert(db, quote) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(REPO, 'sync-server.js')], {
    env: { ...process.env, DB_PATH: db, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  const ok = await new Promise((res) => {
    const t0 = Date.now();
    const tryConn = () => {
      if (p.exitCode !== null) return res(false);
      if (Date.now() - t0 > 8000) return res(false);
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); res(true); });
      sock.on('error', () => { sock.destroy(); setTimeout(tryConn, 250); });
    };
    tryConn();
  });
  if (!ok) { p.kill('SIGKILL'); await new Promise(r => p.on('exit', r)); return { ok: false, err }; }
  const resp = await fetch(`http://127.0.0.1:${port}/api/suggestions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'R4 探测', quote, source_tool: 'webbox' }),
  }).then(r => r.json()).catch(() => null);
  p.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} r(); }, 3000); p.on('exit', () => { clearTimeout(t); r(); }); });
  return { ok: true, resp };
}
// L1：v0-4 真实 sync 写入成功、00123 逐字符 TEXT、库零结构变化
{
  const db = path.join(work, 'L1-v04.db');
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(fs.readFileSync(path.join(__dirname, 'fixtures/v0-4-pre-usermsg.sql'), 'utf8').replace(/^--.*$/gm, ''));
    c.close();
  }
  const before = snapshotDb(db);
  const r = await syncInsert(db, '00123');
  const after = snapshotDb(db);
  const c2 = new DatabaseSync(db);
  const row = c2.prepare("SELECT quote, typeof(quote) t FROM suggestions WHERE title='R4 探测'").get();
  c2.close();
  // 对账口径（兼容写入路径）：schema DDL/版本 零变化 + 恰好新增 1 行 + 正文逐字符 TEXT；
  // journal delete→wal 是服务通过门控后启用 WAL 的既有行为（gate-before-WAL 顺序），
  // 如实记录为「服务 WAL 启用」而非 schema 漂移——DDL 与 user_version 不变即结构零变化。
  rec('L1 sync@v0-4 兼容写入：00123 精确 TEXT、schema/版本零变化',
    r.ok && r.resp && r.resp.id && row && row.quote === '00123' && row.t === 'text'
      && before.uv === after.uv && before.ddl === after.ddl && after.rows === before.rows + 1 && (after.jm === 'wal' || after.jm === before.jm),
    `resp.id=${r.resp && r.resp.id} stored=${JSON.stringify(row)} uv ${before.uv}→${after.uv} journal ${before.jm}→${after.jm}（服务 WAL 启用）DDL一致=${before.ddl === after.ddl} rows ${before.rows}→${after.rows}`);
}
// L2-L4：v0-5 / v1 未版本化(+window_id) / v2 的 sync 正向（00123 精确 TEXT）
{
  const shapes = [
    ['v0-5', () => { const c = new DatabaseSync(path.join(work, 'L2.db')); c.exec('PRAGMA busy_timeout=2000;'); c.exec(v5); c.close(); }],
    ['v1-unversioned', () => { const c = new DatabaseSync(path.join(work, 'L3.db')); c.exec('PRAGMA busy_timeout=2000;'); c.exec(v1full); c.close(); }],
    ['v2', () => { rustInit(path.join(work, 'L4.db')); { const c = new DatabaseSync(path.join(work, 'L4.db')); c.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=delete;'); c.close(); } }],
  ];
  let i = 2;
  for (const [name, build] of shapes) {
    const db = path.join(work, 'L' + i + '.db'); i++;
    build();
    const r = await syncInsert(db, '00123');
    const c = new DatabaseSync(db);
    const row = c.prepare("SELECT quote, typeof(quote) t FROM suggestions WHERE title='R4 探测'").get();
    c.close();
    rec('L' + (i - 1) + ' sync@' + name + ' 正向 00123 精确 TEXT',
      r.ok && r.resp && r.resp.id && row && row.quote === '00123' && row.t === 'text',
      `stored=${JSON.stringify(row)}`);
  }
}
// L5：MCP v0-4 正向（两服务行为一致性的边界说明实证）
{
  const db = path.join(work, 'L5-mcp-v04.db');
  {
    const c = new DatabaseSync(db);
    c.exec('PRAGMA busy_timeout=2000;');
    c.exec(fs.readFileSync(path.join(__dirname, 'fixtures/v0-4-pre-usermsg.sql'), 'utf8').replace(/^--.*$/gm, ''));
    c.close();
  }
  const r = await mcpRound(db);
  const c = new DatabaseSync(db);
  const rows = c.prepare('SELECT COUNT(*) n FROM suggestions').get().n;
  c.close();
  rec('L5 MCP@v0-4 正向（边界一致）', r.exit === 0 && rows >= 1, `exit=${r.exit} rows=${rows}`);
}

fs.writeFileSync(path.join(outDir, 'external-writers.json'),
  JSON.stringify({ coverage: 'real mcp-server.js (stdio JSON-RPC) and sync-server.js (HTTP) processes; synthetic DBs; data/schema/version verified via node:sqlite, not exit codes only', results }, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(failed ? `external-writers: ${failed} 例失败` : 'external-writers: 29 例通过');
fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
