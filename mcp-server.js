#!/usr/bin/env node
// 建议收件箱 MCP Server · 阶段 2
// 零依赖 stdio MCP server：让 AI 助手直接把建议写进收件箱
// 注册方法见 MCP-SETUP.md；协议冒烟测试：node test-mcp.mjs
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 纳言桌面 App 的主库（存在则优先用，和 App 数据互通）；否则用本项目 data/inbox.db
const APP_DB = path.join(os.homedir(), 'Library', 'Application Support', 'com.nayan.app', 'inbox.db');
const DB_PATH = process.env.DB_PATH || (existsSync(APP_DB) ? APP_DB : path.join(__dirname, 'data', 'inbox.db'));
mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 3000;');
try { db.exec("ALTER TABLE suggestions ADD COLUMN kind TEXT DEFAULT 'suggestion'"); } catch (e) {}

// 步骤清单表（和 server.js 保持一致）
db.exec(
  "CREATE TABLE IF NOT EXISTS steps (" +
  " id INTEGER PRIMARY KEY AUTOINCREMENT," +
  " suggestion_id INTEGER NOT NULL," +
  " content TEXT NOT NULL," +
  " is_cmd INTEGER DEFAULT 0," +
  " done INTEGER DEFAULT 0," +
  " ord INTEGER DEFAULT 0," +
  " created_at TEXT DEFAULT (datetime('now','localtime'))" +
  ");"
);

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
  " priority INTEGER DEFAULT 2," +
  " created_at TEXT DEFAULT (datetime('now','localtime'))," +
  " updated_at TEXT DEFAULT (datetime('now','localtime'))" +
  ");"
);

const STATUSES = ['inbox', 'todo', 'doing', 'done', 'dropped'];

// 每个 MCP 连接的客户端身份（initialize 时上报），用来自动填「来源工具」
let clientName = '';
function mapTool(name) {
  const n = String(name || '').toLowerCase();
  if (n.indexOf('claude') >= 0) return 'claude-code';
  if (n.indexOf('codex') >= 0) return 'codex';
  if (n.indexOf('opencode') >= 0) return 'opencode';
  if (n.indexOf('zcode') >= 0 || n.indexOf('z-code') >= 0) return 'zcode';
  if (n.indexOf('antigravity') >= 0 || n.indexOf('gravity') >= 0) return 'antigravity';
  if (n.indexOf('zed') >= 0) return 'zcode';
  if (n.indexOf('dsh') >= 0 || n.indexOf('deepseek') >= 0) return 'dsh';
  return (n.slice(0, 40)) || 'mcp';
}

const TOOLS = [
  {
    name: 'add_suggestion',
    description: '把一条 AI 建议存进用户的「建议收件箱」（本地待办池）。当用户说"记下来 / 收进待办 / 这个建议很好先记着"时调用。请尽量传 workspace=当前项目的绝对路径，来源工具会自动记录。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话摘要（必填）' },
        quote: { type: 'string', description: '建议原文的关键段落' },
        note: { type: 'string', description: '补充说明' },
        workspace: { type: 'string', description: '当前项目/工作区的绝对路径' },
        tags: { type: 'string', description: '标签，逗号分隔' },
        kind: { type: 'string', enum: ['suggestion', 'idle'], description: '类型：suggestion=AI建议（默认）；idle=闲时任务（额度重置前烧 token 用的不急任务）' }
      },
      required: ['title']
    }
  },
  {
    name: 'list_suggestions',
    description: '读取用户的建议收件箱。在开始新任务前调用，可以接着用户上次未完成的建议继续工作。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'inbox', 'todo', 'doing', 'done', 'dropped'], description: 'open=未完成(收件箱+待办+专注中)，默认 open' },
        limit: { type: 'number', description: '最多返回条数，默认 20' }
      }
    }
  },
  {
    name: 'add_suggestions',
    description: '批量把多条 AI 建议存进用户的「建议收件箱」。当用户说"把这几条建议都记下来 / 逐条收进收件箱"时调用，把拆好的条目一次性传进来（不要一条条调用 add_suggestion）。请尽量传 workspace=当前项目的绝对路径。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '建议数组，每条 {title 必填, quote 原文关键段, note 补充, kind: suggestion|idle, tags}',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '一句话摘要（必填）' },
              quote: { type: 'string', description: '建议原文关键段落' },
              note: { type: 'string', description: '补充说明' },
              kind: { type: 'string', enum: ['suggestion', 'idle'] },
              tags: { type: 'string', description: '标签，逗号分隔' }
            },
            required: ['title']
          }
        },
        workspace: { type: 'string', description: '当前项目/工作区的绝对路径' }
      },
      required: ['items']
    }
  },
  {
    name: 'set_steps',
    description: '把某条建议整理成有序的步骤清单（覆盖原有步骤）。当用户说"把 #12 拆成步骤 / 整理成操作清单 / 规划一下怎么执行"时调用。步骤可以是字符串，或 {content, is_cmd}；is_cmd=true 表示该步骤是一条可直接复制到终端执行的命令，命令必须保持原文原样。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '建议 id（list_suggestions 返回的 #编号）' },
        steps: {
          type: 'array',
          description: '步骤数组（按执行顺序）',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              is_cmd: { type: 'boolean' }
            },
            required: ['content']
          }
        }
      },
      required: ['id', 'steps']
    }
  },
  {
    name: 'add_step',
    description: '给某条建议追加一个步骤（放在清单末尾）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '建议 id' },
        content: { type: 'string', description: '步骤内容' },
        is_cmd: { type: 'boolean', description: '是否为可直接执行的终端命令' }
      },
      required: ['id', 'content']
    }
  },
  {
    name: 'update_step',
    description: '更新某个步骤的完成状态或内容（做完一步打勾）。',
    inputSchema: {
      type: 'object',
      properties: {
        step_id: { type: 'number', description: '步骤 id（list_suggestions 输出里的 step#编号）' },
        done: { type: 'boolean' },
        content: { type: 'string' }
      },
      required: ['step_id']
    }
  },
  {
    name: 'update_suggestion',
    description: '更新某条建议的状态。做完一条后标记 done；开始做某条时标记 doing（会自动把其他专注中的退回待办）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '建议 id（list_suggestions 返回的 #编号）' },
        status: { type: 'string', enum: ['inbox', 'todo', 'doing', 'done', 'dropped'] }
      },
      required: ['id']
    }
  }
];

function addSuggestion(a) {
  const title = String(a.title || '').trim();
  if (!title) throw new Error('title 必填');
  const tool = mapTool(clientName);
  const kind = a.kind === 'idle' ? 'idle' : 'suggestion';
  const info = db.prepare(
    "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, tags, kind) VALUES (?,?,?,?,?,?,?)"
  ).run(title, String(a.quote || ''), String(a.note || ''), tool, String(a.workspace || ''), String(a.tags || ''), kind);
  return '已收进建议收件箱（id=' + info.lastInsertRowid + '，来源=' + tool + '）标题：' + title;
}

function listSuggestions(a) {
  const status = String(a.status || 'open');
  const limit = Math.min(Number(a.limit) || 20, 100);
  let rows;
  if (status === 'open') {
    rows = db.prepare(
      "SELECT * FROM suggestions WHERE status IN ('inbox','todo','doing')" +
      " ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, id DESC LIMIT ?"
    ).all(limit);
  } else if (STATUSES.indexOf(status) >= 0) {
    rows = db.prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
  } else {
    throw new Error('非法 status：' + status);
  }
  if (!rows.length) return status === 'open' ? '收件箱里没有未完成的建议。' : '该状态下没有建议。';
  return rows.map(function (r) {
    let line = '#' + r.id + ' [' + r.status + '] ' + r.title +
      '（' + r.source_tool + (r.workspace ? ' · ' + r.workspace : '') + '）';
    const steps = db.prepare('SELECT * FROM steps WHERE suggestion_id = ? ORDER BY ord, id').all(r.id);
    if (steps.length) {
      line += '\n' + steps.map(function (s) {
        return '   ' + (s.done ? '☑' : '□') + ' step#' + s.id + ' ' + s.content;
      }).join('\n');
    }
    return line;
  }).join('\n');
}

function updateSuggestion(a) {
  const id = Number(a.id);
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!row) throw new Error('找不到 #' + id);
  if (a.status !== undefined) {
    if (STATUSES.indexOf(a.status) < 0) throw new Error('非法 status：' + a.status);
    if (a.status === 'doing') {
      db.prepare("UPDATE suggestions SET status = 'todo', updated_at = datetime('now','localtime') WHERE status = 'doing' AND id != ?").run(id);
    }
    db.prepare("UPDATE suggestions SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(a.status, id);
    return '#' + id + ' 状态已更新为 [' + a.status + ']';
  }
  return '#' + id + ' 未做修改';
}

function addSuggestions(a) {
  const items = Array.isArray(a.items) ? a.items : [];
  if (!items.length) throw new Error('items 不能为空');
  const tool = mapTool(clientName);
  const workspace = String(a.workspace || '');
  const ins = db.prepare(
    "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, tags, kind) VALUES (?,?,?,?,?,?,?)"
  );
  const ids = [];
  for (const it of items) {
    const title = String((it && it.title) || '').trim();
    if (!title) continue;
    const kind = it.kind === 'idle' ? 'idle' : 'suggestion';
    const info = ins.run(title, String(it.quote || ''), String(it.note || ''), tool, workspace, String(it.tags || ''), kind);
    ids.push('#' + info.lastInsertRowid + ' ' + title);
  }
  if (!ids.length) throw new Error('items 里没有有效的 title');
  return '已逐条收进建议收件箱（共 ' + ids.length + ' 条，来源=' + tool + '）：\n' + ids.join('\n');
}

function setSteps(a) {
  const id = Number(a.id);
  const card = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!card) throw new Error('找不到 #' + id);
  const items = (Array.isArray(a.steps) ? a.steps : [])
    .map(function (s) { return typeof s === 'string' ? { content: s } : s; })
    .filter(function (s) { return s && String(s.content || '').trim(); });
  if (!items.length) throw new Error('steps 不能为空');
  db.prepare('DELETE FROM steps WHERE suggestion_id = ?').run(id);
  const ins = db.prepare('INSERT INTO steps (suggestion_id, content, is_cmd, ord) VALUES (?,?,?,?)');
  items.forEach(function (s, i) { ins.run(id, String(s.content).trim(), s.is_cmd ? 1 : 0, i); });
  db.prepare("UPDATE suggestions SET updated_at = datetime('now','localtime') WHERE id = ?").run(id);
  const saved = db.prepare('SELECT * FROM steps WHERE suggestion_id = ? ORDER BY ord, id').all(id);
  return '#' + id + ' 已保存 ' + saved.length + ' 步：\n' + saved.map(function (s, i) {
    return (i + 1) + '. ' + s.content;
  }).join('\n');
}

function addStep(a) {
  const id = Number(a.id);
  const card = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!card) throw new Error('找不到 #' + id);
  const content = String(a.content || '').trim();
  if (!content) throw new Error('content 必填');
  const max = db.prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM steps WHERE suggestion_id = ?').get(id).m;
  const info = db.prepare('INSERT INTO steps (suggestion_id, content, is_cmd, ord) VALUES (?,?,?,?)')
    .run(id, content, a.is_cmd ? 1 : 0, max + 1);
  return '#' + id + ' 已追加步骤 step#' + info.lastInsertRowid + '：' + content;
}

function updateStep(a) {
  const sid = Number(a.step_id);
  const step = db.prepare('SELECT * FROM steps WHERE id = ?').get(sid);
  if (!step) throw new Error('找不到 step#' + sid);
  const next = Object.assign({}, step, a);
  db.prepare('UPDATE steps SET content = ?, is_cmd = ?, done = ? WHERE id = ?')
    .run(String(next.content || step.content), next.is_cmd ? 1 : 0, next.done ? 1 : 0, sid);
  return 'step#' + sid + ' 已更新' + (a.done !== undefined ? '（done=' + (a.done ? 'true' : 'false') + '）' : '');
}

async function handle(msg) {
  const method = msg.method;
  if (method === 'initialize') {
    const p = msg.params || {};
    if (p.clientInfo && p.clientInfo.name) clientName = p.clientInfo.name;
    return { jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: p.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'suggestion-inbox', version: '0.3.0' }
    } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = msg.params.name;
    const args = msg.params.arguments || {};
    let text;
    if (name === 'add_suggestion') text = addSuggestion(args);
    else if (name === 'add_suggestions') text = addSuggestions(args);
    else if (name === 'list_suggestions') text = listSuggestions(args);
    else if (name === 'set_steps') text = setSteps(args);
    else if (name === 'add_step') text = addStep(args);
    else if (name === 'update_step') text = updateStep(args);
    else if (name === 'update_suggestion') text = updateSuggestion(args);
    else throw new Error('未知工具：' + name);
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: text }] } };
  }
  throw new Error('未知方法：' + method);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function (line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
  if (msg.id === undefined || msg.id === null) return; // 通知：不回复
  handle(msg).then(function (result) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }, function (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } }) + '\n');
  });
});
