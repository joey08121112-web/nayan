#!/usr/bin/env node
// 纳言同步后端 · 本地 HTTP API（浏览器扩展入库用）
// 直写纳言 App 主库；表结构以 App（app/src-tauri/src/main.rs）为唯一权威，
// 本服务绝不建表/播种 —— 主库不存在或未初始化时直接报错退出（防 schema 漂移）。
// 零依赖：node:http + node:sqlite（Node 22+）。launchd 常驻见 com.nayan.sync.plist。
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSchemaCompat, buildContentEnvelope, MAX_CONTENT_CHARS, codepointCount, isWellFormedText, IDEMPOTENCY_SQL } from './schema-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1'; // 只绑回环，不暴露局域网
const APP_DB = path.join(os.homedir(), 'Library', 'Application Support', 'com.nayan.app', 'inbox.db');
const DB_PATH = process.env.DB_PATH || APP_DB;

function fatal(msg) {
  console.error('[纳言同步] ' + msg);
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  fatal('找不到纳言主库 ' + DB_PATH + ' —— 请先启动一次纳言 App 让它建库，再启动本服务。');
}
const db = new DatabaseSync(DB_PATH);
// F01：版本/形态预检先于任何持久 pragma（journal_mode 等），只读失败不改库状态
db.exec('PRAGMA busy_timeout = 3000;'); // 会话级设置，非持久
try {
  db.prepare('SELECT id FROM suggestions LIMIT 1').get();
} catch {
  fatal('主库存在但没有 suggestions 表（可能是空库文件）——为避免 schema 漂移本服务不建表，请先启动纳言 App 初始化。');
}
// ── schema 版本门控（P1-T02/S05）：sync 不建库/不升级，写入前只读预检。────────────
// user_version=2（现行）或 0（历史形态且写入所需表/列齐备）→ 放行；其余 fail-before-write。
// 本服务写入面（代码事实）：INSERT suggestions（quote-only 或 P1-T04 结构化信封）——
// 无 quote 更新路由，不需要结构化正文保护分支（如实声明）。
// R4-F01：门控通过后按库实际列集决定 INSERT 是否含 user_msg（v0-4 兼容写入）
let HAS_USER_MSG = true;
let HAS_ENVELOPE = false; // P1-T04/S02：仅 v2 形态为 true；legacy 库收结构化请求 → 显式 409 拒绝
{
  // ── R3-F01：共享只读 schema 门控（与 Rust/MCP 同口径；v2 与 legacy 同一入口）──
  const uv = db.prepare('PRAGMA user_version').get().user_version;
  const g = checkSchemaCompat(db, uv);
  if (!g.ok) fatal(g.reason);
  // ── R4-F01：写入能力对齐（兼容写入路径）──门控接受的 v0-4 无 user_msg 列，
  // 本服务的 INSERT 列集合按库实际存在的列构建：v0-4 写 quote-only 兼容形态
  // （不 ALTER 用户库）；v0-5/v1/v2 维持含 user_msg 的既有请求形态。
  const cols = db.prepare('PRAGMA table_info(suggestions)').all().map(c => c.name);
  HAS_USER_MSG = cols.includes('user_msg');
  HAS_ENVELOPE = cols.includes('content_envelope');
  if (uv === 2 && !HAS_ENVELOPE) fatal('user_version=2 但缺 content_envelope 列——形态无法解释，拒绝服务。');
}
// 预检通过后才启用 WAL（与 App/MCP 并发写同一库，等锁而不是报错）
db.exec('PRAGMA journal_mode = WAL;');

// P1-T04：CORS 响应头补齐——旧实现只在 OPTIONS 预检回 ACAO，实际 POST/GET 响应缺头，
// 扩展在无 host_permissions 覆盖的目标端点上读不到响应体（错误被吞成网络异常）。
// 仅对 chrome-extension:// 来源回显（本地回环服务，不扩大暴露面）。
function corsHeaders(req) {
  const origin = String(req.headers.origin || '');
  return origin.startsWith('chrome-extension://') ? { 'Access-Control-Allow-Origin': origin } : {};
}

let hasTrash = db.prepare('PRAGMA user_version').get().user_version >= 4;
function activeWhere() {
  // 旧库由 App 升级；未检测到 v4 时，每次列表/项目计数查询前重读版本。
  if (!hasTrash) hasTrash = db.prepare('PRAGMA user_version').get().user_version >= 4;
  return hasTrash ? 'deleted_at IS NULL' : '1=1';
}

function json(req, res, code, data) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(req)));
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体超过 1MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('无效 JSON')); }
    });
    req.on('error', reject);
  });
}

// 外部只允许写这些文本字段；status/kind/priority 等交给库默认值，不让外部乱改状态
const WRITABLE = ['title', 'quote', 'my_note', 'source_tool', 'workspace', 'session_ref', 'tags', 'user_msg'];
// R4-F01：门控通过后按库实际列集决定 INSERT 是否含 user_msg（v0-4 兼容写入）

const server = createServer(async function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(req, res, 200, { ok: true, db: DB_PATH });
    }
    // 扩展项目选择器：直接返回数组 [{name, count}]
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const rows = db.prepare(
        'SELECT workspace AS name, COUNT(*) AS count FROM suggestions WHERE ' + activeWhere() + ' GROUP BY workspace ORDER BY count DESC, name'
      ).all();
      return json(req, res, 200, rows);
    }
    if (req.method === 'GET' && url.pathname === '/api/suggestions') {
      const status = url.searchParams.get('status');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const active = activeWhere();
      const rows = status
        ? db.prepare('SELECT * FROM suggestions WHERE ' + active + ' AND status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM suggestions WHERE ' + active + ' ORDER BY id DESC LIMIT ?').all(limit);
      return json(req, res, 200, rows);
    }
    if (req.method === 'POST' && url.pathname === '/api/suggestions') {
      let b;
      try { b = await readBody(req); } catch (e) { return json(req, res, 400, { error: e.message }); }
      const title = String(b.title || '').trim();
      if (!title) return json(req, res, 400, { error: 'title 不能为空' });
      // ── P1-T04/S01+S02：结构化 content 信封请求（新客户端）────────────────────
      // 权威性：content 存在时信封为唯一正文来源（请求里的 quote 字段不采信）。
      // legacy 库（无 content_envelope）→ 显式 409 拒绝、零写入，绝不降级 quote-only。
      if (b.content != null) {
        if (!HAS_ENVELOPE) {
          return json(req, res, 409, { error: '结构化 content 请求被拒绝（零写入）：当前库为历史形态（无 content_envelope 列）。请先启动纳言 App 完成 Rust 权威迁移后再用 content 字段；旧 quote-only 请求不受影响。' });
        }
        const built = buildContentEnvelope(b.content, { acquisition: 'extension_dom' });
        if (!built.ok) return json(req, res, 400, { error: 'content 信封非法（零写入）：' + built.reason });
        const isText = built.envelope.original.kind === 'text';
        if (built.size > MAX_CONTENT_CHARS) {
          return json(req, res, 413, { error: '内容超限：' + built.size + (isText ? ' 字符' : ' 字节') + '，上限 ' + MAX_CONTENT_CHARS + (isText ? ' 字符' : ' 字节') + '——已整笔拒绝（未截断）。原文仍在客户端，可缩小后原样重试' });
        }
        // S04 幂等：同 request_id 已入库 → 返回已有行（duplicate=true），不重复插入
        const dup = db.prepare(IDEMPOTENCY_SQL).get(built.envelope.request_id);
        if (dup) {
          // 命中的行在「最近删除」里 → 先恢复（与 Rust create_with_content 同语义），否则用户看不到这次收录
          if (activeWhere() !== '1=1') db.prepare('UPDATE suggestions SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(dup.id);
          const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(dup.id);
          row.duplicate = true;
          return json(req, res, 200, row);
        }
        const vals = {
          title,
          quote: built.quote,
          my_note: String(b.my_note == null ? '' : b.my_note),
          source_tool: String(b.source_tool == null ? 'webbox' : b.source_tool),
          workspace: String(b.workspace == null ? '' : b.workspace),
          session_ref: String(b.session_ref == null ? '' : b.session_ref),
          tags: String(b.tags == null ? '' : b.tags),
          user_msg: String(b.user_msg == null ? '' : b.user_msg),
          content_envelope: JSON.stringify(built.envelope),
        };
        for (const k of WRITABLE) {
          if (codepointCount(vals[k]) > MAX_CONTENT_CHARS) {
            return json(req, res, 413, { error: '字段 ' + k + ' 超过 ' + MAX_CONTENT_CHARS + ' 字符上限——已整笔拒绝（未截断）' });
          }
          if (!isWellFormedText(vals[k])) {
            return json(req, res, 400, { error: '字段 ' + k + ' 含未配对代理（lone surrogate）——已整笔拒绝（零写入，防 SQLite 静默替换成 U+FFFD）' });
          }
        }
        const info = db.prepare(
          'INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags, user_msg, content_envelope) ' +
          'VALUES (@title, @quote, @my_note, @source_tool, @workspace, @session_ref, @tags, @user_msg, @content_envelope)'
        ).run(vals);
        const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid);
        row.duplicate = false;
        return json(req, res, 200, row);
      }
      // ── legacy quote-only 通道（老客户端不变；P1-T04/S03：移除 slice(0,100000) 静默截断）──
      // R4-F01：正文逐字符原样入库（不 trim/不截断）；超限 → 显式 413 整笔拒绝、零行。
      // 深检补：未配对代理显式 400 拒绝——node:sqlite 绑定会静默替换成 U+FFFD（内容静默改变）。
      const vals = {};
      for (const k of WRITABLE) {
        vals[k] = String(b[k] == null ? '' : b[k]);
        const size = codepointCount(vals[k]);
        if (size > MAX_CONTENT_CHARS) {
          return json(req, res, 413, { error: '字段 ' + k + ' 超限：' + size + ' 字符，上限 ' + MAX_CONTENT_CHARS + '——已整笔拒绝（未截断）。原文仍在客户端，可缩小后重试' });
        }
        if (!isWellFormedText(vals[k])) {
          return json(req, res, 400, { error: '字段 ' + k + ' 含未配对代理（lone surrogate）——入库会被 SQLite 静默替换成 U+FFFD（内容静默改变），已整笔拒绝（零写入）' });
        }
      }
      let info;
      if (HAS_USER_MSG) {
        info = db.prepare(
          'INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags, user_msg) ' +
          'VALUES (@title, @quote, @my_note, @source_tool, @workspace, @session_ref, @tags, @user_msg)'
        ).run(vals);
      } else {
        const { user_msg, ...valsNoUserMsg } = vals; // v0-4：列集不含 user_msg，参数集同步剔除
        info = db.prepare(
          'INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags) ' +
          'VALUES (@title, @quote, @my_note, @source_tool, @workspace, @session_ref, @tags)'
        ).run(valsNoUserMsg);
      }
      const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid);
      return json(req, res, 200, row);
    }
    // 仅放行浏览器扩展来源的预检（host_permissions 已覆盖，此处是兜底）
    if (req.method === 'OPTIONS' && String(req.headers.origin || '').startsWith('chrome-extension://')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    return json(req, res, 404, { error: 'not found' });
  } catch (e) {
    return json(req, res, 500, { error: String((e && e.message) || e) });
  }
});

server.on('error', function (e) {
  fatal('监听 ' + HOST + ':' + PORT + ' 失败：' + e.message);
});
server.listen(PORT, HOST, function () {
  console.log('[纳言同步] ' + HOST + ':' + PORT + ' ← 主库 ' + DB_PATH);
});
