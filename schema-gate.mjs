// schema-gate.mjs —— MCP/sync 共用的只读 schema 兼容门控（P1-B02-REPAIR-03 / R3-F01）
//
// 目标：外部 writer 在任何持久写入/服务就绪信号之前，按与 Rust（migrations.rs 的
// ColSpec 结构校验）同口径的规格验证库形态——列集合、类型亲和、NOT NULL、主键。
// 不再只查列名或只查 id；quote TEXT 等正文列类型漂移在此被拒（SQLite 不会替我们
// 拒绝 INTEGER quote——写入会静默把 "00123" 存成 123）。
//
// 使用：checkSchemaCompat(db, userVersion) → { ok: true } 或 { ok: false, reason }。
// 纯只读（PRAGMA table_info / sqlite_master / user_version），不执行任何 DDL。
//
// 规格来源：app/src-tauri/src/migrations.rs 的 SUG_V2_SPECS/STEPS_V2_SPECS 等
//（与 Rust 已接受规格保持一致——一致性矩阵见 tests/migrations/SCHEMA-GATE.md）。
// 服务接受规则：
//   * v2：四表列集合/类型/NOT NULL/主键与 Rust v2 规格完全一致（含 content_envelope）。
//   * v0 legacy：历史链（v0-4 无 user_msg → v0-5 +user_msg；window_id/content_envelope 必须不存在）；
//     steps 允许无 result（v0-4）。legacy 通过后仍只做 quote-only INSERT（既有兼容边界）。
//   * v3（2026-10-11）：v2 + suggestions 四列（list_id/wait_note/remind_on/compare_group_id）+ lists/compare_groups/compare_points 三表。
//   * v4（R9）：v3 + deleted_at TEXT 与非唯一完整索引；外部服务只读验证，不做迁移。
//   * 其他版本：拒绝。

// 列规格：[名称, 声明类型(大写比较), NOT NULL, 主键序号(0=非主键)]
const SUG_CORE = [
  ['id', 'INTEGER', false, 1],
  ['title', 'TEXT', true, 0],
  ['quote', 'TEXT', false, 0],
  ['my_note', 'TEXT', false, 0],
  ['source_tool', 'TEXT', false, 0],
  ['workspace', 'TEXT', false, 0],
  ['session_ref', 'TEXT', false, 0],
  ['tags', 'TEXT', false, 0],
  ['status', 'TEXT', false, 0],
  ['kind', 'TEXT', false, 0],
  ['priority', 'INTEGER', false, 0],
  ['created_at', 'TEXT', false, 0],
  ['updated_at', 'TEXT', false, 0],
];
const USER_MSG = ['user_msg', 'TEXT', false, 0];
const WINDOW_ID = ['window_id', 'INTEGER', false, 0];
const CONTENT_ENVELOPE = ['content_envelope', 'TEXT', false, 0];

const SUG_V2 = [...SUG_CORE, USER_MSG, WINDOW_ID, CONTENT_ENVELOPE];
const SUG_V0_5 = [...SUG_CORE, USER_MSG]; // v0-5（git 63e47cb）
const SUG_V0_4 = [...SUG_CORE]; // v0-4（推断形态，见 fixtures 出处）

const STEPS_CORE = [
  ['id', 'INTEGER', false, 1],
  ['suggestion_id', 'INTEGER', true, 0],
  ['content', 'TEXT', true, 0],
  ['is_cmd', 'INTEGER', false, 0],
  ['done', 'INTEGER', false, 0],
  ['ord', 'INTEGER', false, 0],
  ['created_at', 'TEXT', false, 0],
];
const STEPS_RESULT = ['result', 'TEXT', false, 0];
const STEPS_V2 = [...STEPS_CORE, STEPS_RESULT];

const ATTACHMENTS = [
  ['id', 'INTEGER', false, 1],
  ['suggestion_id', 'INTEGER', true, 0],
  ['path', 'TEXT', true, 0],
  ['name', 'TEXT', true, 0],
  ['created_at', 'TEXT', false, 0],
];
const SESSION_ALIASES = [
  ['app', 'TEXT', true, 1],
  ['session_ref', 'TEXT', true, 2],
  ['window_id', 'INTEGER', true, 3],
  ['alias', 'TEXT', true, 0],
  ['updated_at', 'TEXT', false, 0],
];

const KNOWN_TABLES = ['suggestions', 'steps', 'attachments', 'session_aliases'];

// v3（2026-10-11，界面第四版 R4）：+ 我的清单 / 同题对比；与 migrations.rs SUG_V3_EXTRA_SPECS/LISTS_SPECS 等逐列一致
const SUG_V3 = [...SUG_V2,
  ['list_id', 'INTEGER', false, 0],
  ['wait_note', 'TEXT', false, 0],
  ['remind_on', 'TEXT', false, 0],
  ['compare_group_id', 'INTEGER', false, 0],
];
const LISTS = [
  ['id', 'INTEGER', false, 1],
  ['name', 'TEXT', true, 0],
  ['mode', 'TEXT', true, 0],
  ['color', 'TEXT', true, 0],
  ['ord', 'INTEGER', true, 0],
  ['last_reviewed_on', 'TEXT', false, 0],
  ['created_at', 'TEXT', false, 0],
];
const COMPARE_GROUPS = [
  ['id', 'INTEGER', false, 1],
  ['question', 'TEXT', true, 0],
  ['note', 'TEXT', true, 0],
  ['resolved', 'INTEGER', true, 0],
  ['result_id', 'INTEGER', false, 0],
  ['created_at', 'TEXT', false, 0],
];
const COMPARE_POINTS = [
  ['id', 'INTEGER', false, 1],
  ['suggestion_id', 'INTEGER', true, 0],
  ['ord', 'INTEGER', true, 0],
  ['text', 'TEXT', true, 0],
  ['source', 'TEXT', true, 0],
  ['consensus_key', 'TEXT', true, 0],
  ['verdict', 'TEXT', true, 0],
];
const SUG_V4 = [...SUG_V3, ['deleted_at', 'TEXT', false, 0]];
const V3_TABLES = [...KNOWN_TABLES, 'lists', 'compare_groups', 'compare_points'];

function tableInfo(db, table) {
  return db.prepare('PRAGMA table_info(' + table + ')').all();
}

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/// 单表结构校验：列集合精确相等 + 类型（大小写不敏感）+ NOT NULL + 主键序号
function checkTable(db, table, specs) {
  const rows = tableInfo(db, table);
  const got = rows.map(r => r.name);
  const exp = specs.map(s => s[0]);
  if (got.join(',') !== exp.join(',')) {
    return table + ' 列集合不符：got [' + got.join(',') + '] ≠ expect [' + exp.join(',') + ']';
  }
  for (const r of rows) {
    const s = specs.find(x => x[0] === r.name);
    if (String(r.type).toUpperCase() !== s[1]) {
      return table + '.' + r.name + ' 类型不符：' + r.type + ' ≠ ' + s[1] + '（正文列类型漂移会静默改变写入内容，拒绝）';
    }
    if ((r.notnull === 1) !== s[2]) {
      return table + '.' + r.name + ' NOT NULL 语义不符';
    }
    if (Number(r.pk) !== s[3]) {
      return table + '.' + r.name + ' 主键定义不符（条目身份语义不可保持）';
    }
  }
  return null;
}

// ============================================================================
// P1-T04：CapturedContent 信封共享构建器（与 app/src-tauri/src/content.rs 同口径）
//
// 定位：外部 writer（MCP/sync/扩展）生产结构化 content 时的**唯一**构造路径——
// 调用方只提交最小声明字段（request_id/format/original…），canonical/projection
// 等派生值由本模块集中计算，杜绝「契约多份手工实现」漂移。派生规则与不可用
// 原因字面值必须与 Rust 逐字一致：JS 构建的信封会被 Rust read_content 的
// 一致性重算校验消费（ rebuilt != raw 即拒），字面值漂移 = Rust 读不回。
// 交叉验证：tests/ingestion/envelope-goldens.test.mjs 用 tests/content 已验收的
// 20 个 golden 逐案对账（goldens 由 Rust 序列化产出且经 Rust round-trip 验收）。
// checkSchemaCompat 本体零改动（v0/v2 门控保持已验收行为）。
// ============================================================================

export const ENVELOPE_SCHEMA_VERSION = 1;
export const MAX_CONTENT_CHARS = 100000; // 与 Rust main.rs MAX_CONTENT_CHARS 一致（文本=codepoint，二进制=字节）

const ENVELOPE_FORMATS = ['plain', 'markdown', 'html'];
const ENVELOPE_PROVENANCES = ['declared', 'legacy_assumed_plain'];
const ENVELOPE_ACQUISITIONS = ['ax_selection', 'region_ocr', 'clipboard', 'extension_dom', 'mcp', 'manual', 'legacy_import'];

// 与 content.rs 派生串逐字一致（勿改——Rust 侧重算比对会拒收漂移值）
const CANON_UNAVAIL_BYTES = '二进制 original 无文本 canonical（需按声明的 charset 语义另行解码，本批不猜测）';
const PROJ_UNAVAIL_BYTES = '二进制 original 无文本投影';
const PROJ_UNAVAIL_HTML = 'html sanitizer 未实现：结构化 plain projection 不可用（本批契约显式拒绝伪投影）';

/// S03 同口径规范化：CRLF→LF、独立 CR→LF，其余原样。
export function canonicalizeText(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/// well-formed UTF-16 校验（P1-B04 深检补）：孤代理（lone surrogate）在 Rust String
/// 无法表示——serde_json 拒收 \uD800 转义、node:sqlite 绑定会把 TEXT 静默替换成
/// U+FFFD（实测）。接受即等于「入库后 Rust 读不回 + 正文被静默改变」，故显式拒绝。
/// 检测法：TextEncoder 把孤代理编码为 U+FFFD——encode→decode 与原文不等即不合法。
const _TE = new TextEncoder();
const _TD = new TextDecoder('utf-8', { fatal: false });
export function isWellFormedText(s) {
  return _TD.decode(_TE.encode(s)) === s;
}

/// codepoint 计数（JS length 是 UTF-16 码元数，emoji 会翻倍——与 Rust chars() 对齐须用此口径）。
export function codepointCount(s) {
  let n = 0;
  for (const _ of String(s)) n++;
  return n;
}

/// 最小声明输入 → 完整信封。输入键白名单严格（未知键拒绝，防字段名笔误静默丢内容）；
/// 非法输入返回 { ok:false, reason }，绝不部分构造。默认值：format_provenance='declared'、
/// acquisition=defaults.acquisition（按调用方通道注入，MCP→'mcp'、sync→'extension_dom'）。
export function buildContentEnvelope(input, defaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'content 必须是对象' };
  }
  const allowedKeys = ['schema_version', 'request_id', 'format', 'format_provenance', 'acquisition', 'original', 'fidelity'];
  for (const k of Object.keys(input)) {
    if (!allowedKeys.includes(k)) {
      return { ok: false, reason: 'content 含未知字段 ' + k + '（允许：' + allowedKeys.join('/') + '）——拒绝，防字段名笔误静默丢内容' };
    }
  }
  const sv = input.schema_version === undefined ? ENVELOPE_SCHEMA_VERSION : input.schema_version;
  if (sv !== ENVELOPE_SCHEMA_VERSION) {
    return { ok: false, reason: '未知 schema_version ' + sv + '（支持 ' + ENVELOPE_SCHEMA_VERSION + '）——拒绝，不做静默升级' };
  }
  const request_id = typeof input.request_id === 'string' ? input.request_id : '';
  if (!request_id.trim()) return { ok: false, reason: 'request_id 不能为空' };
  const format = input.format;
  if (!ENVELOPE_FORMATS.includes(format)) {
    return { ok: false, reason: '未知 format：' + JSON.stringify(format) + '（允许：' + ENVELOPE_FORMATS.join('/') + '）' };
  }
  const provenance = input.format_provenance === undefined ? 'declared' : input.format_provenance;
  if (!ENVELOPE_PROVENANCES.includes(provenance)) {
    return { ok: false, reason: '未知 format_provenance：' + JSON.stringify(provenance) };
  }
  if (provenance === 'legacy_assumed_plain' && format !== 'plain') {
    return { ok: false, reason: '矛盾组合：format_provenance=legacy_assumed_plain 只允许 format=plain（legacy 永不自动重释为 ' + format + '）' };
  }
  const acquisition = input.acquisition === undefined ? (defaults.acquisition || 'manual') : input.acquisition;
  if (!ENVELOPE_ACQUISITIONS.includes(acquisition)) {
    return { ok: false, reason: '未知 acquisition：' + JSON.stringify(acquisition) + '（允许：' + ENVELOPE_ACQUISITIONS.join('/') + '）' };
  }
  if (input.fidelity !== undefined) {
    if (typeof input.fidelity !== 'object' || input.fidelity === null || Array.isArray(input.fidelity) ||
        Object.keys(input.fidelity).some(k => k !== 'truncated')) {
      return { ok: false, reason: 'fidelity 仅允许 { truncated: boolean }' };
    }
    if (input.fidelity.truncated !== undefined && typeof input.fidelity.truncated !== 'boolean') {
      return { ok: false, reason: 'fidelity.truncated 必须是布尔值' };
    }
  }
  const truncated = !!(input.fidelity && input.fidelity.truncated);
  // original → 派生 canonical / plain_projection（与 content.rs 构造器同分支同字面值）
  let original, canonical, canonical_unavailable_reason, plain_projection, size;
  const orig = input.original;
  if (!orig || typeof orig !== 'object' || Array.isArray(orig)) {
    return { ok: false, reason: 'original 必填且必须是对象' };
  }
  const origKeys = Object.keys(orig);
  if (orig.kind === 'text') {
    if (!origKeys.every(k => k === 'kind' || k === 'text')) {
      return { ok: false, reason: 'original(kind=text) 仅允许 kind/text 字段' };
    }
    if (typeof orig.text !== 'string') return { ok: false, reason: 'original.text 必须是字符串' };
    if (!isWellFormedText(orig.text)) {
      return { ok: false, reason: 'original.text 含未配对代理（lone surrogate）——Rust String 无法表示（入库即 Rust 读不回、且 SQLite 绑定会静默替换成 U+FFFD），显式拒绝' };
    }
    original = { kind: 'text', text: orig.text };
    const c = canonicalizeText(orig.text);
    canonical = c;
    canonical_unavailable_reason = null;
    plain_projection = format === 'html'
      ? { status: 'unavailable', reason: PROJ_UNAVAIL_HTML }
      : { status: 'available', text: c };
    size = codepointCount(orig.text);
  } else if (orig.kind === 'bytes') {
    if (!origKeys.every(k => k === 'kind' || k === 'bytes' || k === 'charset_hint')) {
      return { ok: false, reason: 'original(kind=bytes) 仅允许 kind/bytes/charset_hint 字段' };
    }
    if (!Array.isArray(orig.bytes) || orig.bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
      return { ok: false, reason: 'original.bytes 必须是 0–255 的整数字节数组' };
    }
    if (orig.charset_hint !== undefined && orig.charset_hint !== null && typeof orig.charset_hint !== 'string') {
      return { ok: false, reason: 'charset_hint 必须是字符串' };
    }
    // Rust Option<String> 序列化恒带字段（null 表示缺省）——保持同形
    original = { kind: 'bytes', bytes: orig.bytes, charset_hint: orig.charset_hint === undefined ? null : orig.charset_hint };
    canonical = null;
    canonical_unavailable_reason = CANON_UNAVAIL_BYTES;
    plain_projection = { status: 'unavailable', reason: PROJ_UNAVAIL_BYTES };
    size = orig.bytes.length;
  } else {
    return { ok: false, reason: 'original.kind 必须是 text 或 bytes（得到 ' + JSON.stringify(orig.kind) + '）' };
  }
  return {
    ok: true,
    envelope: {
      schema_version: ENVELOPE_SCHEMA_VERSION,
      request_id,
      format,
      format_provenance: provenance,
      acquisition,
      original,
      fidelity: { truncated },
      canonical,
      canonical_unavailable_reason,
      plain_projection,
    },
    size,
    quote: plain_projection.status === 'available' ? plain_projection.text : '', // 兼容视图：与 migrations::write_content 同口径
  };
}

/// 幂等查重 SQL 片段（与 Rust create_with_content 同查询；依赖 SQLite JSON1，node:sqlite 内建）。
export const IDEMPOTENCY_SQL = "SELECT id FROM suggestions WHERE content_envelope IS NOT NULL \
AND json_valid(content_envelope) AND json_extract(content_envelope, '$.request_id') = ? LIMIT 1";

/// 只读 schema 兼容门控：任何持久写入/服务就绪之前调用。
export function checkSchemaCompat(db, uv) {
  if (uv !== 0 && uv !== 2 && uv !== 3 && uv !== 4) {
    return { ok: false, reason: '主库 schema 版本 ' + uv + ' 与本服务不兼容（支持 0/legacy、2、3 与 4）——请先启动纳言 App（Rust 权威迁移）或升级 App。' };
  }
  if (!tableExists(db, 'suggestions')) {
    return { ok: false, reason: '主库无 suggestions 表——请先启动纳言 App 初始化（本服务不建表）。' };
  }
  // 未知表（与 Rust known_tables_only 同口径）
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  const known = uv >= 3 ? V3_TABLES : KNOWN_TABLES;
  for (const t of tables) {
    if (!known.includes(t)) {
      return { ok: false, reason: '存在不认识的表 ' + t + '——拒绝（不猜测修库）。' };
    }
  }
  const sug = tableInfo(db, 'suggestions');
  const sugNames = sug.map(r => r.name);
  let sugSpec, stepsSpec;
  if (uv >= 3) {
    for (const t of V3_TABLES) {
      if (!tableExists(db, t)) return { ok: false, reason: '缺表 ' + t + '（user_version=' + uv + ' 形态校验失败）' };
    }
    sugSpec = uv === 4 ? SUG_V4 : SUG_V3;
    stepsSpec = STEPS_V2;
  } else if (uv === 2) {
    sugSpec = SUG_V2;
    stepsSpec = STEPS_V2;
  } else {
    // legacy 历史链（与 fixtures/Rust validate_legacy_v0 的规格选择完全一致）：
    // v0-4（核心）→ v0-5（+user_msg）→ v1（+window_id，仍未版本化的现行生产形态）。
    // v0 出现 content_envelope 才是版本号矛盾（Rust 同口径拒绝）。
    if (sugNames.includes('content_envelope')) {
      return { ok: false, reason: 'user_version=0 却已含 content_envelope——形态无法解释，拒绝。' };
    }
    const SUG_V1 = [...SUG_CORE, USER_MSG, WINDOW_ID];
    sugSpec = sugNames.includes('window_id') ? SUG_V1
      : sugNames.includes('user_msg') ? SUG_V0_5
      : SUG_V0_4;
    // v0-4 的 steps 允许无 result
    stepsSpec = tableExists(db, 'steps') && tableInfo(db, 'steps').some(c => c.name === 'result') ? STEPS_V2 : STEPS_CORE;
  }
  // 未知列（与 Rust no_unknown_columns 同口径：以 v2 全集为允许上限）
  const allowed = (uv === 4 ? SUG_V4 : uv === 3 ? SUG_V3 : SUG_V2).map(s => s[0]);
  for (const n of sugNames) {
    if (!allowed.includes(n)) {
      return { ok: false, reason: 'suggestions 存在未知列 ' + n + '——拒绝（不猜测修库）。' };
    }
  }
  const err = checkTable(db, 'suggestions', sugSpec)
    || (tableExists(db, 'steps') ? checkTable(db, 'steps', stepsSpec) : null)
    || (tableExists(db, 'attachments') ? checkTable(db, 'attachments', ATTACHMENTS) : null)
    || (tableExists(db, 'session_aliases') ? checkTable(db, 'session_aliases', SESSION_ALIASES) : null)
    || (uv >= 3 ? (checkTable(db, 'lists', LISTS) || checkTable(db, 'compare_groups', COMPARE_GROUPS) || checkTable(db, 'compare_points', COMPARE_POINTS)) : null);
  if (err) {
    return { ok: false, reason: err + (uv >= 2 ? '（user_version=' + uv + ' 形态校验失败）' : '（历史形态校验失败——请先启动纳言 App 完成权威迁移）') };
  }
  if (uv === 4) {
    const index = db.prepare('PRAGMA index_list(suggestions)').all().find(i => i.name === 'idx_suggestions_deleted_at');
    const cols = db.prepare('PRAGMA index_info(idx_suggestions_deleted_at)').all().map(i => i.name);
    if (!index || index.unique !== 0 || index.partial !== 0 || cols.join(',') !== 'deleted_at') {
      return { ok: false, reason: 'malformed v4：deleted_at 的非唯一完整索引缺失或列不符' };
    }
  }
  return { ok: true };
}
