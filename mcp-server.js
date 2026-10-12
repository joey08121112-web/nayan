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
import { checkSchemaCompat, buildContentEnvelope, MAX_CONTENT_CHARS, codepointCount, isWellFormedText, IDEMPOTENCY_SQL } from './schema-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 纳言桌面 App 的主库（存在则优先用，和 App 数据互通）；否则用本项目 data/inbox.db
const APP_DB = path.join(os.homedir(), 'Library', 'Application Support', 'com.nayan.app', 'inbox.db');
const DB_PATH = process.env.DB_PATH || (existsSync(APP_DB) ? APP_DB : path.join(__dirname, 'data', 'inbox.db'));
mkdirSync(path.dirname(DB_PATH), { recursive: true });
// ── schema 兼容门控（P1-T02/S05）：MCP 不再自行建库/升级 schema。────────────────
// 权威迁移在 Rust 端（app/src-tauri/src/migrations.rs）。本服务只做只读预检：
//   user_version=2（现行）→ 放行；user_version=0（历史未版本化库）→ 仅当本服务
//   写入所需表/列齐备时按 legacy 兼容放行（绝不执行任何 DDL）；其他/缺失/未来版本
//   → fail-before-write 并给出初始化/升级说明。quote-only INSERT 在两种放行形态下
//   均为 legacy_plain（content_envelope 保持 NULL，由 Rust 端读取适配）。
//   本服务的写入面（代码事实）：INSERT suggestions(quote-only)/steps、status 更新、
//   删除——不存在 quote 更新路由，故无需结构化正文保护分支（如实声明，不加假设性代码）。
if (!existsSync(DB_PATH)) {
  console.error('[mcp] 找不到主库 ' + DB_PATH + ' —— MCP 不建库。请先启动纳言 App（Rust 权威迁移）初始化，或用 tests/migrations 的 Rust 初始化驱动生成测试库。');
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 3000;');
// P1-T04/S02：uv 与信封列能力提升到模块作用域——信封写入前先判库形态，
// 不兼容（legacy 无 content_envelope）则显式拒绝结构化请求（零写入），绝不降级为 quote-only。
const UV = db.prepare('PRAGMA user_version').get().user_version;
const HAS_ENVELOPE = db.prepare('PRAGMA table_info(suggestions)').all().some(c => c.name === 'content_envelope');
{
  const uv = UV;
  const need = {
    'suggestions': ['id','title','quote','status','kind','user_msg','tags','workspace','source_tool','my_note'],
    'steps': ['id','suggestion_id','content','is_cmd','done','ord','result'],
  };
  // ── R3-F01：共享只读 schema 门控（与 Rust ColSpec 同口径；列/类型/NOT NULL/主键，
  //    v2 与 legacy 同一入口核验——不再有只查列名或分支遗漏）────────────────────
  {
    const g = checkSchemaCompat(db, uv);
    if (!g.ok) {
      console.error('[mcp] ' + g.reason);
      process.exit(1);
    }
  }
  if (UV === 2 && !HAS_ENVELOPE) {
    // 防御性断言：门控通过的 v2 形态必含 content_envelope（checkTable 已保证；此处显式兜底）
    console.error('[mcp] user_version=2 但缺 content_envelope 列——形态无法解释，拒绝写入。');
    process.exit(1);
  }
}

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
    description: '把一条 AI 建议存进用户的「建议收件箱」（本地待办池）。当用户说"记下来 / 收进待办 / 这个建议很好先记着"时调用。请尽量传 workspace=当前项目的绝对路径，来源工具会自动记录。要保存完整原文时传 content 结构化字段（原文逐字符保真、request_id 幂等）；只传 quote 则按 legacy plain 保存。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话摘要（必填）' },
        quote: { type: 'string', description: '建议原文的关键段落（legacy 通道：plain 入库，不做结构化保真）' },
        content: {
          type: 'object',
          description: '版本化内容信封（新客户端推荐）：原文逐字符/逐字节保真 + request_id 幂等。与 quote 二选一；同时传时以 content 为权威。',
          properties: {
            schema_version: { type: 'number', description: '信封版本，当前 1（缺省 1）' },
            request_id: { type: 'string', description: '采集请求标识（必填，非空；重试复用同一 id 可免重复入库）' },
            format: { type: 'string', enum: ['plain', 'markdown', 'html'], description: '声明格式（必填，显式声明不猜测）' },
            format_provenance: { type: 'string', enum: ['declared', 'legacy_assumed_plain'], description: '格式来源，缺省 declared' },
            acquisition: { type: 'string', enum: ['ax_selection', 'region_ocr', 'clipboard', 'extension_dom', 'mcp', 'manual', 'legacy_import'], description: '采集通道，缺省 mcp' },
            original: {
              type: 'object',
              description: '原始表示（必填）',
              properties: {
                kind: { type: 'string', enum: ['text', 'bytes'] },
                text: { type: 'string', description: 'kind=text 时的原文（逐 codepoint 保留，不 trim）' },
                bytes: { type: 'array', items: { type: 'number' }, description: 'kind=bytes 时的原始字节（0-255）' },
                charset_hint: { type: 'string', description: 'kind=bytes 时可选字符集提示' }
              },
              required: ['kind']
            },
            fidelity: { type: 'object', description: '内容质量标记 { truncated: boolean }，缺省 false' }
          },
          required: ['request_id', 'format', 'original']
        },
        note: { type: 'string', description: '补充说明' },
        workspace: { type: 'string', description: '当前项目/工作区的绝对路径' },
        tags: { type: 'string', description: '标签，逗号分隔' },
        kind: { type: 'string', enum: ['suggestion', 'idle'], description: '类型：suggestion=AI建议（默认）；idle=闲时任务（额度重置前烧 token 用的不急任务）' },
        list: { type: 'string', description: '放进用户自建的清单（按清单名字）。用户说「记到后期 / 记到资料 / 记到重要」时传清单名；不传 = 收件箱。清单名不存在会报错并列出现有清单，不会自动新建。' },
        wait: { type: 'string', description: '清单是「到日期提醒」时写清等什么，例如「下周再看」「下个月再看」「11 月再看」「2026-11-01」；能看出日期的到日子会在钉板顶部提醒' }
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
          description: '建议数组，每条 {title 必填, quote 原文关键段 或 content 结构化信封, note 补充, kind: suggestion|idle, tags}。整批先全部校验再写入：任一条非法则整批拒绝（零部分写入）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '一句话摘要（必填）' },
              quote: { type: 'string', description: '建议原文关键段落（legacy 通道）' },
              content: { type: 'object', description: '版本化内容信封（同 add_suggestion 的 content 字段）' },
              note: { type: 'string', description: '补充说明' },
              kind: { type: 'string', enum: ['suggestion', 'idle'] },
              tags: { type: 'string', description: '标签，逗号分隔' }
            },
            required: ['title']
          }
        },
        workspace: { type: 'string', description: '当前项目/工作区的绝对路径' },
        list: { type: 'string', description: '整批放进哪个用户自建清单（按名字，如「后期」）；不传 = 收件箱' },
        wait: { type: 'string', description: '清单是「到日期提醒」时的「等什么」（整批共用）' }
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

// ── P1-T04：结构化 content 写入（S01 版本化可选字段 / S02 先查库形态 / S03 超限显式拒绝 / S04 request_id 幂等）──
// 信封请求硬前提：库含 content_envelope 列（user_version=2 形态）。legacy 库显式拒绝
// （零写入），绝不降级 quote-only——降级即静默丢结构化保真，违背 fail-before-write。
function envelopeRejectIfUnsupported() {
  if (!HAS_ENVELOPE) {
    throw new Error('结构化 content 请求被拒绝（零写入）：当前库为历史形态（user_version=' + UV +
      '，无 content_envelope 列）。请先启动纳言 App 完成 Rust 权威迁移（或升级 App）后再用 content 字段；旧 quote-only 请求不受影响。');
  }
}
function oversizeError(size, isText) {
  return new Error('内容超限：' + size + (isText ? ' 字符' : ' 字节') + '，上限 ' + MAX_CONTENT_CHARS +
    (isText ? ' 字符' : ' 字节') + '——已整笔拒绝（未截断）。请缩小原文后重试');
}

// ── v3（2026-10-11）：我的清单 —— 对 AI 说「记到后期」直接入清单 ─────────────
const HAS_LISTS = UV >= 3;
let hasTrash = UV === 4;
function activeFilter() {
  // App 可在本进程运行期间把旧库升到 v4；升级前每次列表查询重新检测。
  if (!hasTrash) hasTrash = db.prepare('PRAGMA user_version').get().user_version === 4;
  return hasTrash ? ' AND deleted_at IS NULL' : '';
}
/// 幂等命中的行若在「最近删除」里，先恢复它（与 Rust create_with_content 同语义），返回是否恢复。
function restoreIfTrashed(id) {
  if (!activeFilter()) return false;
  return db.prepare('UPDATE suggestions SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
}
/// 「等什么」里看得出日期才给提醒日（YYYY-MM-DD）；看不出返回 null（只存原话，不自动提醒）。
/// 与 app/ui/index.html 的 parseWaitDate 同口径。
function parseWaitDate(text, now = new Date()) {
  const t = String(text || '').trim();
  if (!t) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const addDays = (n) => fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
  const ymd = (y, m, d) => { const x = new Date(y, m - 1, d); return (x.getMonth() === m - 1 && x.getDate() === d) ? x : null; };
  let m = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) { const x = ymd(+m[1], +m[2], +m[3]); return x ? fmt(x) : null; }
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) { let x = ymd(today.getFullYear(), +m[1], +m[2]); if (x && x < today) x = ymd(today.getFullYear() + 1, +m[1], +m[2]); return x ? fmt(x) : null; }
  m = t.match(/(\d{1,2})\s*月/);
  if (m && +m[1] >= 1 && +m[1] <= 12) { let x = new Date(today.getFullYear(), +m[1] - 1, 1); if (x < today) x = new Date(today.getFullYear() + 1, +m[1] - 1, 1); return fmt(x); }
  m = t.match(/(\d+)\s*天[后以]/);
  if (m) return addDays(+m[1]);
  if (/明天/.test(t)) return addDays(1);
  if (/后天/.test(t)) return addDays(2);
  if (/下(个)?(周|星期|礼拜)|一周后/.test(t)) return addDays(7);
  if (/下(个)?月/.test(t)) { const x = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate()); if (x.getDate() !== today.getDate()) x.setDate(0); return fmt(x); }
  return null;
}
function resolveList(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (!HAS_LISTS) throw new Error('「我的清单」需要新版纳言：请先打开纳言 App 完成数据升级，再记到清单（本次零写入）');
  const row = db.prepare('SELECT id, name, mode FROM lists WHERE name = ?').get(n);
  if (!row) {
    const all = db.prepare('SELECT name FROM lists ORDER BY ord, id').all().map((r) => r.name);
    throw new Error('没有叫「' + n + '」的清单（本次零写入）。现有清单：' + (all.length ? all.join('、') : '（无）') + '。要新建请在纳言侧栏「＋ 新建清单」。');
  }
  return row;
}
function putInList(id, list, wait) {
  if (!list) return '';
  const w = list.mode === 'date' ? String(wait || '').trim() : '';
  db.prepare("UPDATE suggestions SET list_id = ?, wait_note = ?, remind_on = ?, status = 'inbox' WHERE id = ?")
    .run(list.id, w, list.mode === 'date' ? parseWaitDate(w) : null, id);
  return '，放进清单「' + list.name + '」' + (w ? '（等：' + w + '）' : '');
}

function addSuggestion(a) {
  const title = String(a.title || '').trim();
  if (!title) throw new Error('title 必填');
  const tool = mapTool(clientName);
  const kind = a.kind === 'idle' ? 'idle' : 'suggestion';
  const list = resolveList(a.list); // 清单名不对 → 写入前报错（零写入）
  if (a.content != null) {
    envelopeRejectIfUnsupported();
    const built = buildContentEnvelope(a.content, { acquisition: 'mcp' });
    if (!built.ok) throw new Error('content 信封非法（整笔拒绝，零行落库）：' + built.reason);
    const isText = built.envelope.original.kind === 'text';
    if (built.size > MAX_CONTENT_CHARS) throw oversizeError(built.size, isText);
    // S04 幂等：同 request_id 已成功收录 → 返回已有行，不再插入（与 Rust create_with_content 同查询）
    const dup = db.prepare(IDEMPOTENCY_SQL).get(built.envelope.request_id);
    if (dup) {
      const back = restoreIfTrashed(dup.id) ? '，已从最近删除恢复' : '';
      return '已收进建议收件箱（id=' + dup.id + '，duplicate=true 幂等返回' + back + '，request_id=' + built.envelope.request_id + '）标题：' + title;
    }
    const info = db.prepare(
      "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, tags, kind, content_envelope) VALUES (?,?,?,?,?,?,?,?)"
    ).run(title, built.quote, String(a.note || ''), tool, String(a.workspace || ''), String(a.tags || ''), kind, JSON.stringify(built.envelope));
    const where = putInList(info.lastInsertRowid, list, a.wait);
    return '已收进建议收件箱（id=' + info.lastInsertRowid + '，结构化保真，来源=' + tool + '，request_id=' + built.envelope.request_id + where + '）标题：' + title;
  }
  // legacy quote-only 通道（老客户端不变；P1-T04/S03：超限显式拒绝，绝不静默截断；
  // 深检补：未配对代理显式拒绝——node:sqlite 绑定会静默替换成 U+FFFD）
  const quote = String(a.quote || '');
  const qsize = codepointCount(quote);
  if (qsize > MAX_CONTENT_CHARS) throw oversizeError(qsize, true);
  if (!isWellFormedText(quote)) throw new Error('quote 含未配对代理（lone surrogate）——入库会被 SQLite 静默替换成 U+FFFD（内容静默改变），显式拒绝（零写入）');
  const info = db.prepare(
    "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, tags, kind) VALUES (?,?,?,?,?,?,?)"
  ).run(title, quote, String(a.note || ''), tool, String(a.workspace || ''), String(a.tags || ''), kind);
  const where = putInList(info.lastInsertRowid, list, a.wait);
  return '已收进建议收件箱（id=' + info.lastInsertRowid + '，来源=' + tool + where + '）标题：' + title;
}

function listSuggestions(a) {
  const status = String(a.status || 'open');
  const limit = Math.min(Number(a.limit) || 20, 100);
  const active = activeFilter();
  let rows;
  if (status === 'open') {
    rows = db.prepare(
      "SELECT * FROM suggestions WHERE status IN ('inbox','todo','doing')" + active +
      " ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, id DESC LIMIT ?"
    ).all(limit);
  } else if (STATUSES.indexOf(status) >= 0) {
    rows = db.prepare('SELECT * FROM suggestions WHERE status = ?' + active + ' ORDER BY id DESC LIMIT ?').all(status, limit);
  } else {
    throw new Error('非法 status：' + status);
  }
  if (!rows.length) return status === 'open' ? '收件箱里没有未完成的建议。' : '该状态下没有建议。';
  return rows.map(function (r) {
    let line = '#' + r.id + ' [' + r.status + '] ' + r.title +
      '（' + r.source_tool + (r.workspace ? ' · ' + r.workspace : '') + '）';
    if (HAS_LISTS && r.list_id != null) {
      const l = db.prepare('SELECT name FROM lists WHERE id = ?').get(r.list_id);
      if (l) line += ' 在清单「' + l.name + '」' + (r.wait_note ? '（等：' + r.wait_note + '）' : '');
    }
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
  const list = resolveList(a.list); // v3：整批放进同一清单；名字不对 → 零写入
  // ── 第一段：全批预校验（P1-T04/S02 + P1-B04-REPAIR-01）──
  // 只构建 prepared：title/信封构建（每条仅一次）/上限/Unicode 校验；任一条非法 → 整批拒绝、零部分写入。
  // P1-B04-REPAIR-01：幂等查重不再在本段做——事务外查库存在检查/插入竞态，且本批待插入集
  // 不参与查重（同批同 request_id 双插入的根因）。幂等统一移入第二段事务内。
  const prepared = [];
  for (const it of items) {
    const title = String((it && it.title) || '').trim();
    if (!title) continue; // 沿用既有语义：空 title 条目跳过
    const kind = it.kind === 'idle' ? 'idle' : 'suggestion';
    let requestId = null, envelopeJson = null, quote = '';
    if (it && it.content != null) {
      envelopeRejectIfUnsupported();
      const built = buildContentEnvelope(it.content, { acquisition: 'mcp' });
      if (!built.ok) throw new Error('items 中一条 content 信封非法（整批拒绝，零写入）：' + built.reason);
      const isText = built.envelope.original.kind === 'text';
      if (built.size > MAX_CONTENT_CHARS) throw oversizeError(built.size, isText);
      requestId = built.envelope.request_id;
      envelopeJson = JSON.stringify(built.envelope);
      quote = built.quote;
    } else {
      quote = String((it && it.quote) || '');
      const qsize = codepointCount(quote);
      if (qsize > MAX_CONTENT_CHARS) throw oversizeError(qsize, true);
      if (!isWellFormedText(quote)) throw new Error('items 中一条 quote 含未配对代理（整批拒绝，零写入）——入库会被 SQLite 静默替换成 U+FFFD');
    }
    prepared.push({ title, kind, requestId, envelopeJson, quote, note: String((it && it.note) || ''), tags: String((it && it.tags) || '') });
  }
  if (!prepared.length) throw new Error('items 里没有有效的 title');
  // ── 第二段：BEGIN IMMEDIATE 事务内查重 + 插入（first accepted write wins）──
  // 同一写事务内，当前连接能看到本事务先前的 INSERT——「库内已有」与「本批前面刚插入」
  // 两种重复形态由同一条 IDEMPOTENCY_SQL 自然覆盖，无需全局 Set 或缓存。
  // 同 request_id 首条成功写入即权威内容；后续同 ID（哪怕正文不同）不插入、不覆盖，
  // 返回 duplicate 与同一真实行 ID。BEGIN IMMEDIATE 串行化本批量入口的检查/插入窗口。
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (e) {
    // 事务未开启，不属于本次——不执行 ROLLBACK；明确失败，零写入
    throw new Error('add_suggestions 无法取得写事务（BEGIN IMMEDIATE 失败，本批零写入）：' + e.message);
  }
  const created = [];
  const dups = [];
  try {
    // 语句按需准备：纯 legacy 批在无 content_envelope 列的历史库上不能因无条件
    // prepare 含该列的语句而失败（结构化条目已过 envelopeRejectIfUnsupported，
    // 走到这里的 insEnv/idem 仅在确有结构化条目时准备）
    const insPlain = db.prepare(
      "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, tags, kind) VALUES (?,?,?,?,?,?,?)"
    );
    const needEnv = prepared.some((p) => p.envelopeJson != null);
    const insEnv = needEnv ? db.prepare(
      "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, tags, kind, content_envelope) VALUES (?,?,?,?,?,?,?,?)"
    ) : null;
    const idem = needEnv ? db.prepare(IDEMPOTENCY_SQL) : null;
    const realTitle = db.prepare('SELECT id, title FROM suggestions WHERE id = ?');
    for (const p of prepared) {
      if (p.requestId != null) {
        const dup = idem.get(p.requestId);
        if (dup) {
          // 展示已存行的真实标题（库内已有或本批首条），不拿后到条目的 title 冒充已存内容
          const existing = realTitle.get(dup.id);
          const back = restoreIfTrashed(dup.id) ? '，已从最近删除恢复' : '';
          dups.push('#' + dup.id + '（duplicate=true，未新增未覆盖' + back + '） ' + (existing ? existing.title : p.title) + ' ← request_id=' + p.requestId);
          continue;
        }
        const info = insEnv.run(p.title, p.quote, p.note, tool, workspace, p.tags, p.kind, p.envelopeJson);
        putInList(info.lastInsertRowid, list, a.wait);
        created.push('#' + info.lastInsertRowid + ' ' + p.title);
      } else {
        // legacy quote-only 条目：无 request_id 不参与幂等，按原路径 INSERT；
        // 不同 request_id 的相同正文也分别 INSERT（不做正文去重）
        const info = insPlain.run(p.title, p.quote, p.note, tool, workspace, p.tags, p.kind);
        putInList(info.lastInsertRowid, list, a.wait);
        created.push('#' + info.lastInsertRowid + ' ' + p.title);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    // 查询/INSERT/COMMIT 任一步失败：回滚整批，不返回局部成功；回滚自身失败保留诊断
    let rollbackDiag = '';
    try { db.exec('ROLLBACK'); } catch (e2) { rollbackDiag = '（ROLLBACK 亦失败，保留诊断：' + e2.message + '）'; }
    throw new Error('add_suggestions 整批失败已回滚（零新增）' + rollbackDiag + '：' + e.message);
  }
  // COMMIT 成功后才生成回复；新增数只计 created，duplicate 不计入新增
  const parts = [];
  if (created.length) parts.push('已逐条收进建议收件箱（新增 ' + created.length + ' 条，来源=' + tool + (list ? '，放进清单「' + list.name + '」' : '') + '）：\n' + created.join('\n'));
  if (dups.length) parts.push('幂等返回（request_id 已存在：duplicate=true、未新增、未覆盖，指向同一真实行）：\n' + dups.join('\n'));
  return parts.join('\n');
}

function setSteps(a) {
  const id = Number(a.id);
  const card = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!card) throw new Error('找不到 #' + id);
  const items = (Array.isArray(a.steps) ? a.steps : [])
    .map(function (s) { return typeof s === 'string' ? { content: s } : s; })
    .filter(function (s) { return s && String(s.content || '').trim(); })
    .map(function (s) { return { content: String(s.content).trim(), is_cmd: !!s.is_cmd, done: !!s.done }; });
  if (!items.length) throw new Error('steps 不能为空');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM steps WHERE suggestion_id = ?').run(id);
    const ins = db.prepare('INSERT INTO steps (suggestion_id, content, is_cmd, done, ord) VALUES (?,?,?,?,?)');
    items.forEach(function (s, i) { ins.run(id, s.content, s.is_cmd ? 1 : 0, s.done ? 1 : 0, i); });
    db.prepare("UPDATE suggestions SET updated_at = datetime('now','localtime') WHERE id = ?").run(id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }
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
