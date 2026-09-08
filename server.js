#!/usr/bin/env node
// 建议收件箱 · 阶段 1 MVP
// 零依赖：node:http + node:sqlite（Node 22+ 自带），无需 npm install
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
// 纳言桌面 App 的主库（存在则优先用，和 App 数据互通）；否则用本项目 data/inbox.db
const APP_DB = path.join(os.homedir(), 'Library', 'Application Support', 'com.nayan.app', 'inbox.db');
const DB_PATH = process.env.DB_PATH || (existsSync(APP_DB) ? APP_DB : path.join(__dirname, 'data', 'inbox.db'));

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(
  "CREATE TABLE IF NOT EXISTS suggestions (" +
  " id INTEGER PRIMARY KEY AUTOINCREMENT," +
  " title TEXT NOT NULL," +
  " quote TEXT DEFAULT ''," +
  " my_note TEXT DEFAULT ''," +
  " source_tool TEXT DEFAULT 'other'," +
  " workspace TEXT DEFAULT ''," +
  " session_ref TEXT DEFAULT ''," +
  " tags TEXT DEFAULT ''," +
  " status TEXT DEFAULT 'inbox'," +
  " kind TEXT DEFAULT 'suggestion'," +
  " priority INTEGER DEFAULT 2," +
  " created_at TEXT DEFAULT (datetime('now','localtime'))," +
  " updated_at TEXT DEFAULT (datetime('now','localtime'))," +
  " user_msg TEXT DEFAULT ''" +
  ");"
);

try { db.exec("ALTER TABLE suggestions ADD COLUMN kind TEXT DEFAULT 'suggestion'"); } catch (e) {}
try { db.exec("ALTER TABLE suggestions ADD COLUMN user_msg TEXT DEFAULT ''"); } catch (e) {}

// 步骤清单：一张卡片可拆成多步，做一步勾一步（v0.3）；result=执行结果（v0.4）
db.exec(
  "CREATE TABLE IF NOT EXISTS steps (" +
  " id INTEGER PRIMARY KEY AUTOINCREMENT," +
  " suggestion_id INTEGER NOT NULL," +
  " content TEXT NOT NULL," +
  " is_cmd INTEGER DEFAULT 0," +
  " done INTEGER DEFAULT 0," +
  " ord INTEGER DEFAULT 0," +
  " created_at TEXT DEFAULT (datetime('now','localtime'))," +
  " result TEXT DEFAULT ''" +
  ");"
);

try { db.exec("ALTER TABLE steps ADD COLUMN result TEXT DEFAULT ''"); } catch (e) {}

function attachSteps(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(function (r) { return r.id; });
  const marks = ids.map(function () { return '?'; }).join(',');
  const steps = db.prepare('SELECT * FROM steps WHERE suggestion_id IN (' + marks + ') ORDER BY suggestion_id, ord, id').all(...ids);
  const byId = {};
  steps.forEach(function (s) {
    (byId[s.suggestion_id] = byId[s.suggestion_id] || []).push(s);
  });
  rows.forEach(function (r) { r.steps = byId[r.id] || []; });
  return rows;
}

function replaceSteps(sid, items) {
  db.prepare('DELETE FROM steps WHERE suggestion_id = ?').run(sid);
  const ins = db.prepare('INSERT INTO steps (suggestion_id, content, is_cmd, done, ord) VALUES (?,?,?,?,?)');
  items.forEach(function (s, i) { ins.run(sid, String(s.content), s.is_cmd ? 1 : 0, s.done ? 1 : 0, i); });
  db.prepare("UPDATE suggestions SET updated_at = datetime('now','localtime') WHERE id = ?").run(sid);
}

const STATUSES = ['inbox', 'todo', 'doing', 'done', 'dropped'];
const KINDS = ['suggestion', 'idle'];

// 首次启动放两条示例数据，认识界面后可删除
const count = db.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n;
if (count === 0) {
  const ins = db.prepare("INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, status) VALUES (?,?,?,?,?,?)");
  ins.run('示例：给设置页搜索框加 300ms 防抖', '建议对搜索输入做防抖处理，减少无意义的过滤计算。', '示例数据：认识界面后可直接删除。', 'dsh', '', 'todo');
  ins.run('示例：把日志写到 data/ 目录而不是项目根目录', '避免日志污染工作区。', '', 'claude-code', '', 'inbox');
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// —— AI 拆步设置（OpenAI 兼容接口；Key 只存本机 data/config.json）——
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'data', 'config.json');
const AI_PRESETS = {
  glm: { base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
  deepseek: { base_url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { base_url: '', model: '' }
};

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}

function saveConfig(cfg) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function aiChat(messages) {
  const cfg = loadConfig().ai || {};
  const base = String(cfg.base_url || '').replace(/\/+$/, '');
  if (!cfg.api_key || !base) throw new Error('请先点右上角 ⚙️ 配置 AI 供应商和 API Key');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.api_key },
    body: JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages: messages, temperature: 0.2 })
  });
  const data = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('AI 返回为空');
  return content;
}

function parseStepJson(text) {
  const t = String(text || '').trim().replace(/^```(json)?\s*/m, '').replace(/```\s*$/m, '');
  const start = t.indexOf('['), end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr.map(function (s) {
      if (typeof s === 'string') return { content: s.trim(), is_cmd: false };
      return { content: String(s.content || s.step || '').trim(), is_cmd: !!(s.is_cmd || s.isCmd) };
    }).filter(function (s) { return s.content; });
  } catch (e) { return []; }
}

const server = createServer(async function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/suggestions' && req.method === 'GET') {
      const status = url.searchParams.get('status') || '';
      const tool = url.searchParams.get('tool') || '';
      const kind = url.searchParams.get('kind') || '';
      const q = url.searchParams.get('q') || '';
      let sql = 'SELECT * FROM suggestions';
      const where = []; const params = [];
      if (STATUSES.indexOf(status) >= 0) { where.push('status = ?'); params.push(status); }
      if (tool) { where.push('source_tool = ?'); params.push(tool); }
      if (KINDS.indexOf(kind) >= 0) { where.push('kind = ?'); params.push(kind); }
      if (q) { where.push('(title LIKE ? OR quote LIKE ? OR my_note LIKE ?)'); const like = '%' + q + '%'; params.push(like, like, like); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += " ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'inbox' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, id DESC";
      json(res, 200, attachSteps(db.prepare(sql).all(...params)));
      return;
    }
    if (url.pathname === '/api/suggestions' && req.method === 'POST') {
      const b = await readBody(req);
      const title = String(b.title || '').trim();
      if (!title) return json(res, 400, { error: 'title 必填' });
      const kind = KINDS.indexOf(b.kind) >= 0 ? b.kind : 'suggestion';
      const info = db.prepare(
        "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags, kind, user_msg) VALUES (?,?,?,?,?,?,?,?,?)"
      ).run(title, String(b.quote || ''), String(b.my_note || ''), String(b.source_tool || 'other'), String(b.workspace || ''), String(b.session_ref || ''), String(b.tags || ''), kind, String(b.user_msg || ''));
      json(res, 201, db.prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid));
      return;
    }
    // 批量入箱：AI 一次拆好几条时用（MCP add_suggestions 也走这里）
    if (url.pathname === '/api/suggestions/batch' && req.method === 'POST') {
      const b = await readBody(req);
      const items = Array.isArray(b.items) ? b.items : [];
      const ins = db.prepare(
        "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags, kind, user_msg) VALUES (?,?,?,?,?,?,?,?,?)"
      );
      const out = [];
      for (const it of items) {
        const title = String((it && it.title) || '').trim();
        if (!title) continue;
        const kind = KINDS.indexOf(it.kind) >= 0 ? it.kind : 'suggestion';
        const info = ins.run(title, String(it.quote || ''), String(it.my_note || ''), String(it.source_tool || 'other'), String(it.workspace || ''), String(it.session_ref || ''), String(it.tags || ''), kind, String(it.user_msg || ''));
        out.push(db.prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid));
      }
      if (!out.length) return json(res, 400, { error: 'items 里没有有效的 title' });
      json(res, 201, out);
      return;
    }
    const m = url.pathname.match(/^\/api\/suggestions\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      const id = Number(m[1]);
      const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
      if (!row) return json(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.status !== undefined && STATUSES.indexOf(b.status) < 0) return json(res, 400, { error: '非法 status' });
      // 「一次只专注一条」：新的 doing 会自动把旧的 doing 退回 todo
      if (b.status === 'doing') {
        db.prepare("UPDATE suggestions SET status = 'todo', updated_at = datetime('now','localtime') WHERE status = 'doing' AND id != ?").run(id);
      }
      const next = Object.assign({}, row, b);
      db.prepare(
        "UPDATE suggestions SET title = ?, quote = ?, my_note = ?, source_tool = ?, workspace = ?, session_ref = ?, tags = ?, kind = ?, status = ?, priority = ?, user_msg = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(String(next.title), String(next.quote || ''), String(next.my_note || ''), String(next.source_tool || 'other'), String(next.workspace || ''), String(next.session_ref || ''), String(next.tags || ''), String(next.kind || 'suggestion'), String(next.status || 'inbox'), Number(next.priority == null ? 2 : next.priority), String(next.user_msg || ''), id);
      json(res, 200, db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id));
      return;
    }
    if (m && req.method === 'DELETE') {
      db.prepare('DELETE FROM steps WHERE suggestion_id = ?').run(Number(m[1]));
      db.prepare('DELETE FROM suggestions WHERE id = ?').run(Number(m[1]));
      json(res, 200, { ok: true });
      return;
    }
    // 步骤清单：POST 整体替换或追加，PATCH/DELETE 管单步
    const mSteps = url.pathname.match(/^\/api\/suggestions\/(\d+)\/steps$/);
    if (mSteps && req.method === 'POST') {
      const sid = Number(mSteps[1]);
      const card = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(sid);
      if (!card) return json(res, 404, { error: 'not found' });
      const b = await readBody(req);
      let items = (Array.isArray(b.steps) ? b.steps : []).map(function (s) {
        return typeof s === 'string' ? { content: s } : s;
      }).filter(function (s) { return s && String(s.content || '').trim(); })
        .map(function (s) { return { content: String(s.content).trim(), is_cmd: !!s.is_cmd, done: !!s.done }; });
      if (!items.length) return json(res, 400, { error: 'steps 不能为空' });
      if (b.mode === 'append') {
        const cur = db.prepare('SELECT * FROM steps WHERE suggestion_id = ? ORDER BY ord, id').all(sid);
        items = cur.concat(items);
      }
      replaceSteps(sid, items);
      json(res, 200, attachSteps([db.prepare('SELECT * FROM suggestions WHERE id = ?').get(sid)])[0]);
      return;
    }
    const mStep = url.pathname.match(/^\/api\/steps\/(\d+)$/);
    if (mStep && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const id = Number(mStep[1]);
      const step = db.prepare('SELECT * FROM steps WHERE id = ?').get(id);
      if (!step) return json(res, 404, { error: 'not found' });
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM steps WHERE id = ?').run(id);
        return json(res, 200, { ok: true });
      }
      const b = await readBody(req);
      const next = Object.assign({}, step, b);
      db.prepare('UPDATE steps SET content = ?, is_cmd = ?, done = ?, result = ? WHERE id = ?')
        .run(String(next.content || step.content), next.is_cmd ? 1 : 0, next.done ? 1 : 0, String(next.result || ''), id);
      json(res, 200, db.prepare('SELECT * FROM steps WHERE id = ?').get(id));
      return;
    }
    // 项目分组列表（捕获小窗选项目、侧栏分组用）
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      const rows = db.prepare("SELECT workspace AS name, COUNT(*) AS count FROM suggestions GROUP BY workspace ORDER BY count DESC, name").all();
      json(res, 200, rows);
      return;
    }
    // AI 拆步：读取本机 data/config.json 里的 API Key，调用 OpenAI 兼容接口
    const mSplit = url.pathname.match(/^\/api\/ai\/split\/(\d+)$/);
    if (mSplit && req.method === 'POST') {
      const id = Number(mSplit[1]);
      const card = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
      if (!card) return json(res, 404, { error: 'not found' });
      const sys = '你是任务拆解助手。把用户给出的内容（一段 AI 建议、操作指引或含命令的终端输出）整理成有序执行步骤。' +
        '只输出 JSON 数组，形如 [{"content":"步骤描述","is_cmd":true}]，is_cmd=true 表示该步骤是一条可直接复制到终端执行的命令。' +
        '最多 12 步；命令必须保持原文原样，不要改写；合并重复内容；不要输出数组以外的任何文字。';
      const user = '标题：' + card.title + '\n\n内容：\n' + (card.quote || card.title);
      try {
        const reply = await aiChat([{ role: 'system', content: sys }, { role: 'user', content: user }]);
        const arr = parseStepJson(reply);
        if (!arr.length) throw new Error('AI 没有返回有效步骤，原文开头：' + reply.slice(0, 80));
        replaceSteps(id, arr);
        json(res, 200, attachSteps([db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id)])[0]);
      } catch (e) {
        json(res, 502, { error: String((e && e.message) || e) });
      }
      return;
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      const ai = (loadConfig().ai) || {};
      const preset = AI_PRESETS[ai.provider] || AI_PRESETS.glm;
      json(res, 200, {
        provider: ai.provider || 'glm',
        base_url: ai.base_url || preset.base_url,
        model: ai.model || preset.model,
        has_key: !!ai.api_key
      });
      return;
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const provider = AI_PRESETS[b.provider] ? b.provider : 'custom';
      const preset = AI_PRESETS[provider];
      const cfg = loadConfig();
      cfg.ai = Object.assign({}, cfg.ai, {
        provider: provider,
        base_url: String(b.base_url || preset.base_url || '').replace(/\/+$/, ''),
        model: String(b.model || preset.model || '')
      });
      if (b.api_key === null) cfg.ai.api_key = '';
      else if (typeof b.api_key === 'string' && b.api_key.trim()) cfg.ai.api_key = b.api_key.trim();
      saveConfig(cfg);
      json(res, 200, { ok: true, provider: cfg.ai.provider, base_url: cfg.ai.base_url, model: cfg.ai.model, has_key: !!cfg.ai.api_key });
      return;
    }
    if (url.pathname === '/api/settings/test' && req.method === 'POST') {
      try {
        const reply = await aiChat([{ role: 'user', content: '只回复两个字：正常' }]);
        json(res, 200, { ok: true, reply: String(reply).slice(0, 40) });
      } catch (e) {
        json(res, 502, { error: String((e && e.message) || e) });
      }
      return;
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (file.indexOf('..') < 0) {
        const full = path.join(__dirname, file);
        if (existsSync(full)) {
          const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type });
          res.end(readFileSync(full));
          return;
        }
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, function () {
  console.log('建议收件箱已启动: http://localhost:' + PORT);
});
