//! 版本化迁移与结构化内容存储（P1-T02；P1-B02-REPAIR-01 按 R1-F01–F04 返修）
//!
//! F01 支持形态实际验证：v2 快速路径必须核验真实 schema（四表+全部 v1 列+content_envelope），
//! 不再只看 user_version；v0 历史形态只接受「有依据的明确形态」（初始公开版核心列齐全），
//! suggestions(id) 一类的残库显式拒绝。版本/schema 预检之前不设置 journal_mode 等持久状态。
//! MCP/sync 门控口径一致（见两文件的形态核验）。
//!
//! F02 恢复安全：restore_with_protection 只以只读+必须存在方式打开备份；完整消费
//! integrity_check 与 foreign_key_check 结果；候选文件验证通过后原子替换目标；活跃 WAL
//! 副文件（-wal/-shm）存在时拒绝恢复（无法证明 writer 已停止）；保护名冲突加后缀不覆盖；
//! 任一步失败原目标仍可用。
//!
//! F03 事务闭环：migrate/write_content 的 COMMIT 失败同样走 ROLLBACK（回滚失败如实双报错，
//! 不假称恢复完成）；错误返回后同连接回到 autocommit，无悬挂事务。
//!
//! F04 迁移接备份门控：open_and_migrate 对「已有库升级」先取 WAL-safe 快照（VACUUM INTO，
//! 含 WAL 已提交数据）+ 快照校验 + manifest（各表行数与逐 quote SHA-256，经系统 shasum 真实
//! 算法）后才执行 DDL；快照失败/校验失败/manifest 失败 → 不迁移。全新库与已验证当前库
//! 幂等打开不制造无意义快照。恢复策略与旧二进制边界见模块文档与批次报告。
//!
//! 两个版本概念不同：DB `user_version`（本模块）与 envelope `schema_version`（content 契约）。

use crate::content::CapturedContent;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION_V1: u32 = 1;
pub const SCHEMA_VERSION_V2: u32 = 2;
/// v3（2026-10-11，界面第四版 R4）：用户自建「我的清单」+ 到日期提醒 + 同题逐条对比。
/// 只加表、加可空/有默认值的列；旧写入路径（显式列 INSERT）在 v3 库上照常可写。
pub const SCHEMA_VERSION_V3: u32 = 3;
/// v4：软删除；时间为 UTC，保留原条目与所有关联内容。
pub const SCHEMA_VERSION_V4: u32 = 4;
/// v5（2026-10-13，R12）：阅读页「AI 整理」的结果另存一列 ai_extras（JSON：要点 / 整理后的正文 / 改标题前的旧标题），原文列从不改写。
pub const SCHEMA_VERSION_V5: u32 = 5;
pub const SCHEMA_VERSION_CURRENT: u32 = SCHEMA_VERSION_V5;

const V1_SUGGESTIONS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    quote TEXT DEFAULT '',
    my_note TEXT DEFAULT '',
    source_tool TEXT DEFAULT 'other',
    workspace TEXT DEFAULT '',
    session_ref TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    status TEXT DEFAULT 'inbox',
    kind TEXT DEFAULT 'suggestion',
    priority INTEGER DEFAULT 2,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    user_msg TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_cmd INTEGER DEFAULT 0,
    done INTEGER DEFAULT 0,
    ord INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    result TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS session_aliases (
    app TEXT NOT NULL,
    session_ref TEXT NOT NULL,
    window_id INTEGER NOT NULL DEFAULT 0,
    alias TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (app, session_ref, window_id)
);
"#;

/// v3 新增：清单 / 同题对比分组 / 对比要点。mode ∈ none|daily|date、verdict ∈ ''|up|down 由 API 校验。
const V3_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'none',
    color TEXT NOT NULL DEFAULT '',
    ord INTEGER NOT NULL DEFAULT 0,
    last_reviewed_on TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS compare_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    resolved INTEGER NOT NULL DEFAULT 0,
    result_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS compare_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    consensus_key TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL DEFAULT ''
);
"#;
/// 首次进入 v3 时预置的三个清单（用户可改名、改提醒方式、删除）
const V3_PRESET_LISTS: &[(&str, &str, &str)] = &[
    ("后期", "date", "#c08a3a"),
    ("资料", "none", "#7d8a6a"),
    ("每天回顾", "daily", "#6f6aa8"),
];

/// 历史核心列（初始公开版 63e47cb 起就存在的列——legacy 形态必须齐备才可识别）
const SUG_CORE: &[&str] = &[
    "id", "title", "quote", "my_note", "source_tool", "workspace", "session_ref",
    "tags", "status", "kind", "priority", "created_at", "updated_at",
];
/// v2 当前形态的 suggestions 列（核心 + user_msg/window_id/content_envelope）
const SUG_V2: &[&str] = &[
    "id", "title", "quote", "my_note", "source_tool", "workspace", "session_ref",
    "tags", "status", "kind", "priority", "created_at", "updated_at", "user_msg",
    "window_id", "content_envelope",
];
/// v3：v2 + 清单/提醒/对比四列
const SUG_V3: &[&str] = &[
    "id", "title", "quote", "my_note", "source_tool", "workspace", "session_ref",
    "tags", "status", "kind", "priority", "created_at", "updated_at", "user_msg",
    "window_id", "content_envelope", "list_id", "wait_note", "remind_on", "compare_group_id",
];
const STEPS_CORE: &[&str] = &["id", "suggestion_id", "content", "is_cmd", "done", "ord", "created_at"];
const STEPS_V2: &[&str] = &["id", "suggestion_id", "content", "is_cmd", "done", "ord", "created_at", "result"];
/// v2 及更早只认这四张表；v3 另加三张。快照/恢复对账按「存在即计」遍历全集。
const V2_TABLES: &[&str] = &["suggestions", "steps", "attachments", "session_aliases"];
const KNOWN_TABLES: &[&str] = &["suggestions", "steps", "attachments", "session_aliases", "lists", "compare_groups", "compare_points"];

// ---------- 基础探测 ----------

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}

fn column_exists(conn: &Connection, table: &str, col: &str) -> Result<bool, String> {
    Ok(columns(conn, table)?.iter().any(|n| n == col))
}

fn has_all(cols: &[String], required: &[&str]) -> Option<String> {
    for r in required {
        if !cols.iter().any(|c| c == r) {
            return Some(r.to_string());
        }
    }
    None
}

fn user_version(conn: &Connection) -> Result<u32, String> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn any_user_table(conn: &Connection) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// 已知表之外不允许任何未知表（内部 sqlite_% 除外）；v2 及更早只认四表
fn known_tables_only(conn: &Connection) -> Result<(), String> {
    known_tables_in(conn, V2_TABLES)
}
fn known_tables_in(conn: &Connection, known: &[&str]) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for n in names {
        if !known.contains(&n.as_str()) {
            return Err(format!("Unknown schema：存在不认识的表 {}——拒绝（不猜测修库）", n));
        }
    }
    Ok(())
}

/// suggestions/steps 不得携带已知后补列之外的未知列
fn no_unknown_columns(conn: &Connection) -> Result<(), String> {
    no_unknown_columns_in(conn, SUG_V2)
}
fn no_unknown_columns_in(conn: &Connection, sug: &[&str]) -> Result<(), String> {
    let sug_allowed: Vec<&str> = sug.to_vec();
    let steps_allowed: Vec<&str> = STEPS_V2.to_vec();
    for (table, allowed) in [("suggestions", sug_allowed), ("steps", steps_allowed)] {
        if !table_exists(conn, table)? {
            continue;
        }
        for c in columns(conn, table)? {
            if !allowed.contains(&c.as_str()) {
                return Err(format!("Unknown schema：{} 存在未知列 {}——拒绝（不猜测修库）", table, c));
            }
        }
    }
    Ok(())
}

/// 结构化列描述：(列名, 声明类型[大小写不敏感], NOT NULL, 主键序号[0=非主键])
/// 依据本仓库 DDL（V1_SUGGESTIONS_DDL）与 fixtures 出处，非字符串特判。
type ColSpec = (&'static str, &'static str, bool, i32);

const SUG_V2_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("title", "TEXT", true, 0),
    ("quote", "TEXT", false, 0),
    ("my_note", "TEXT", false, 0),
    ("source_tool", "TEXT", false, 0),
    ("workspace", "TEXT", false, 0),
    ("session_ref", "TEXT", false, 0),
    ("tags", "TEXT", false, 0),
    ("status", "TEXT", false, 0),
    ("kind", "TEXT", false, 0),
    ("priority", "INTEGER", false, 0),
    ("created_at", "TEXT", false, 0),
    ("updated_at", "TEXT", false, 0),
    ("user_msg", "TEXT", false, 0),
    ("window_id", "INTEGER", false, 0),
    ("content_envelope", "TEXT", false, 0),
];
const SUG_V3_EXTRA_SPECS: &[ColSpec] = &[
    ("list_id", "INTEGER", false, 0),
    ("wait_note", "TEXT", false, 0),
    ("remind_on", "TEXT", false, 0),
    ("compare_group_id", "INTEGER", false, 0),
];
const LISTS_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("name", "TEXT", true, 0),
    ("mode", "TEXT", true, 0),
    ("color", "TEXT", true, 0),
    ("ord", "INTEGER", true, 0),
    ("last_reviewed_on", "TEXT", false, 0),
    ("created_at", "TEXT", false, 0),
];
const COMPARE_GROUPS_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("question", "TEXT", true, 0),
    ("note", "TEXT", true, 0),
    ("resolved", "INTEGER", true, 0),
    ("result_id", "INTEGER", false, 0),
    ("created_at", "TEXT", false, 0),
];
const COMPARE_POINTS_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("suggestion_id", "INTEGER", true, 0),
    ("ord", "INTEGER", true, 0),
    ("text", "TEXT", true, 0),
    ("source", "TEXT", true, 0),
    ("consensus_key", "TEXT", true, 0),
    ("verdict", "TEXT", true, 0),
];
/// legacy（v0）核心结构：同上但无 user_msg/window_id/content_envelope（fixtures 出处）
const SUG_LEGACY_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("title", "TEXT", true, 0),
    ("quote", "TEXT", false, 0),
    ("my_note", "TEXT", false, 0),
    ("source_tool", "TEXT", false, 0),
    ("workspace", "TEXT", false, 0),
    ("session_ref", "TEXT", false, 0),
    ("tags", "TEXT", false, 0),
    ("status", "TEXT", false, 0),
    ("kind", "TEXT", false, 0),
    ("priority", "INTEGER", false, 0),
    ("created_at", "TEXT", false, 0),
    ("updated_at", "TEXT", false, 0),
];
const STEPS_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("suggestion_id", "INTEGER", true, 0),
    ("content", "TEXT", true, 0),
    ("is_cmd", "INTEGER", false, 0),
    ("done", "INTEGER", false, 0),
    ("ord", "INTEGER", false, 0),
    ("created_at", "TEXT", false, 0),
];
/// v0-4 起的 steps 含 result；v0 最早期形态（63e47cb 提取）已含 result——fixtures 均含
const STEPS_V2_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("suggestion_id", "INTEGER", true, 0),
    ("content", "TEXT", true, 0),
    ("is_cmd", "INTEGER", false, 0),
    ("done", "INTEGER", false, 0),
    ("ord", "INTEGER", false, 0),
    ("created_at", "TEXT", false, 0),
    ("result", "TEXT", false, 0),
];
const ATTACHMENTS_SPECS: &[ColSpec] = &[
    ("id", "INTEGER", false, 1),
    ("suggestion_id", "INTEGER", true, 0),
    ("path", "TEXT", true, 0),
    ("name", "TEXT", true, 0),
    ("created_at", "TEXT", false, 0),
];
const SESSION_ALIASES_SPECS: &[ColSpec] = &[
    ("app", "TEXT", true, 1),
    ("session_ref", "TEXT", true, 2),
    ("window_id", "INTEGER", true, 3),
    ("alias", "TEXT", true, 0),
    ("updated_at", "TEXT", false, 0),
];

/// 结构校验（R2-F01）：列集合精确相等 + 每列类型亲和/NOT NULL/主键序号与已知 DDL 一致。
/// CTAS 重建（列名相同但丢主键/NOT NULL）与缺主键残库在此被拒——不是字符串特判。
fn validate_table_structure(conn: &Connection, table: &str, specs: &[ColSpec]) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| format!("{} 结构读取失败：{}", table, e))?;
    let rows: Vec<(String, String, bool, i32)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)? != 0, r.get::<_, i64>(5)? as i32)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("{} 结构行读取失败：{}", table, e))?; // 读取错误传播
    let expect: Vec<(String, String, bool, i32)> = specs
        .iter()
        .map(|(n, t, nn, pk)| (n.to_string(), t.to_string(), *nn, *pk))
        .collect();
    let got_names: Vec<&String> = rows.iter().map(|r| &r.0).collect();
    let exp_names: Vec<&String> = expect.iter().map(|r| &r.0).collect();
    if got_names != exp_names {
        return Err(format!(
            "{} 列集合与已知 DDL 不符：got {:?} ≠ expect {:?}——拒绝（不猜测修库）",
            table, got_names, exp_names
        ));
    }
    for (g, e) in rows.iter().zip(expect.iter()) {
        if !g.1.eq_ignore_ascii_case(&e.1) {
            return Err(format!("{} 列 {} 类型不符：{} ≠ {}——拒绝", table, g.0, g.1, e.1));
        }
        if g.2 != e.2 {
            return Err(format!(
                "{} 列 {} NOT NULL 语义不符（got {} expect {}）——拒绝",
                table, g.0, g.2, e.2
            ));
        }
        if g.3 != e.3 {
            return Err(format!(
                "{} 主键定义不符：列 {} 主键序号 got {} expect {}——拒绝（条目身份语义不可保持）",
                table, g.0, g.3, e.3
            ));
        }
    }
    Ok(())
}

/// v2 当前形态实际校验（F01）：四表齐全、suggestions 全 v2 列、steps 全 v2 列、无未知列/表。
pub fn validate_current_v2(conn: &Connection) -> Result<(), String> {
    for t in V2_TABLES {
        if !table_exists(conn, t)? {
            return Err(format!("malformed v2：缺表 {}", t));
        }
    }
    known_tables_only(conn)?;
    no_unknown_columns(conn)?;
    // R2-F01：四表全结构校验（类型/NOT NULL/主键序号）——CTAS 重建丢主键、attachments(id) 残库在此被拒
    validate_table_structure(conn, "suggestions", SUG_V2_SPECS)?;
    validate_table_structure(conn, "steps", STEPS_V2_SPECS)?;
    validate_table_structure(conn, "attachments", ATTACHMENTS_SPECS)?;
    validate_table_structure(conn, "session_aliases", SESSION_ALIASES_SPECS)?;
    Ok(())
}

/// v3 当前形态实际校验：七表齐全、suggestions 为 v2 列 + 四个 v3 列、三张新表结构精确。
pub fn validate_current_v3(conn: &Connection) -> Result<(), String> {
    validate_list_schema(conn, false, false)
}

pub fn validate_current_v4(conn: &Connection) -> Result<(), String> {
    validate_list_schema(conn, true, false)?;
    validate_trash_index(conn)
}

/// v5 = v4 + suggestions.ai_extras TEXT（可空）
pub fn validate_current_v5(conn: &Connection) -> Result<(), String> {
    validate_list_schema(conn, true, true)?;
    validate_trash_index(conn)
}

fn validate_trash_index(conn: &Connection) -> Result<(), String> {
    let indexes: Vec<(String, i64, i64)> = conn.prepare("PRAGMA index_list(suggestions)")
        .map_err(|e| e.to_string())?.query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(4)?)))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if !indexes.iter().any(|i| i.0 == "idx_suggestions_deleted_at" && i.1 == 0 && i.2 == 0) {
        return Err("malformed v4：缺少 deleted_at 的非唯一完整索引".into());
    }
    let cols: Vec<String> = conn.prepare("PRAGMA index_info(idx_suggestions_deleted_at)")
        .map_err(|e| e.to_string())?.query_map([], |r| r.get(2))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if cols != ["deleted_at"] {
        return Err("malformed v4：deleted_at 索引列不符".into());
    }
    Ok(())
}

fn validate_list_schema(conn: &Connection, trash: bool, ai: bool) -> Result<(), String> {
    for t in KNOWN_TABLES {
        if !table_exists(conn, t)? {
            return Err(format!("malformed v3：缺表 {}", t));
        }
    }
    known_tables_in(conn, KNOWN_TABLES)?;
    let mut names = SUG_V3.to_vec();
    let mut sug: Vec<ColSpec> = SUG_V2_SPECS.iter().chain(SUG_V3_EXTRA_SPECS.iter()).copied().collect();
    if trash {
        names.push("deleted_at");
        sug.push(("deleted_at", "TEXT", false, 0));
    }
    if ai {
        names.push("ai_extras");
        sug.push(("ai_extras", "TEXT", false, 0));
    }
    no_unknown_columns_in(conn, &names)?;
    validate_table_structure(conn, "suggestions", &sug)?;
    validate_table_structure(conn, "steps", STEPS_V2_SPECS)?;
    validate_table_structure(conn, "attachments", ATTACHMENTS_SPECS)?;
    validate_table_structure(conn, "session_aliases", SESSION_ALIASES_SPECS)?;
    validate_table_structure(conn, "lists", LISTS_SPECS)?;
    validate_table_structure(conn, "compare_groups", COMPARE_GROUPS_SPECS)?;
    validate_table_structure(conn, "compare_points", COMPARE_POINTS_SPECS)?;
    Ok(())
}

fn apply_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("ALTER TABLE suggestions ADD COLUMN ai_extras TEXT;")
        .map_err(|e| format!("加 suggestions.ai_extras 失败：{}", e))
}

fn apply_v4(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("ALTER TABLE suggestions ADD COLUMN deleted_at TEXT; CREATE INDEX idx_suggestions_deleted_at ON suggestions(deleted_at);")
        .map_err(|e| format!("建 v4 回收站失败：{}", e))
}

/// v2 → v3 增量（事务内调用；幂等守卫）：加四列、建三表、首次建 lists 时预置三个清单。
fn apply_v3(conn: &Connection) -> Result<(), String> {
    for (col, ddl) in [
        ("list_id", "ALTER TABLE suggestions ADD COLUMN list_id INTEGER;"),
        ("wait_note", "ALTER TABLE suggestions ADD COLUMN wait_note TEXT DEFAULT '';"),
        ("remind_on", "ALTER TABLE suggestions ADD COLUMN remind_on TEXT;"),
        ("compare_group_id", "ALTER TABLE suggestions ADD COLUMN compare_group_id INTEGER;"),
    ] {
        if !column_exists(conn, "suggestions", col)? {
            conn.execute_batch(ddl).map_err(|e| format!("加 suggestions.{} 失败：{}", col, e))?;
        }
    }
    let had_lists = table_exists(conn, "lists")?;
    conn.execute_batch(V3_DDL).map_err(|e| format!("建 v3 表失败：{}", e))?;
    if !had_lists {
        for (i, (name, mode, color)) in V3_PRESET_LISTS.iter().enumerate() {
            conn.execute(
                "INSERT INTO lists (name, mode, color, ord) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![name, mode, color, i as i64],
            )
            .map_err(|e| format!("预置清单失败：{}", e))?;
        }
    }
    Ok(())
}

/// v0 历史形态实际校验（F01）：只接受有依据的明确形态——初始公开版核心列必须齐备。
/// suggestions(id) 一类残库、缺 title/quote 等核心列 → 拒绝，不自动补成假 v2。
pub fn validate_legacy_v0(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "suggestions")? {
        return Err("Unknown schema：有表但无 suggestions——拒绝".into());
    }
    known_tables_only(conn)?;
    no_unknown_columns(conn)?;
    if let Some(m) = has_all(&columns(conn, "suggestions")?, SUG_CORE) {
        return Err(format!(
            "Unknown schema：suggestions 缺历史核心列 {}——不是已知历史形态，拒绝（不猜测修库）",
            m
        ));
    }
    // R2-F01：legacy 结构同样按已知 DDL 核对（缺主键/类型漂移拒绝）
    let sug_cols = columns(conn, "suggestions")?;
    // 历史形态链（fixtures 出处）：无 user_msg（v0-4）→ +user_msg（v0-5）→ +window_id（v1）
    let sug_specs: Vec<ColSpec> = if sug_cols.iter().any(|c| c == "window_id") {
        SUG_V2_SPECS.iter().filter(|(n, _, _, _)| n != &"content_envelope").copied().collect()
    } else if sug_cols.iter().any(|c| c == "user_msg") {
        // v0-5：核心 + user_msg（window_id 尚未引入）
        let mut v = SUG_LEGACY_SPECS.to_vec();
        v.push(("user_msg", "TEXT", false, 0));
        v
    } else {
        SUG_LEGACY_SPECS.to_vec() // v0-4：核心（无 user_msg/window_id）
    };
    validate_table_structure(conn, "suggestions", &sug_specs)?;
    if table_exists(conn, "steps")? {
        let steps_cols = columns(conn, "steps")?;
        let steps_specs: Vec<ColSpec> = if steps_cols.iter().any(|c| c == "result") {
            STEPS_V2_SPECS.to_vec()
        } else {
            STEPS_SPECS.to_vec()
        };
        validate_table_structure(conn, "steps", &steps_specs)?;
    }
    if table_exists(conn, "attachments")? {
        validate_table_structure(conn, "attachments", ATTACHMENTS_SPECS)?;
    }
    if table_exists(conn, "session_aliases")? {
        validate_table_structure(conn, "session_aliases", SESSION_ALIASES_SPECS)?;
    }
    Ok(())
}

// ---------- F03：事务提交/回滚闭环 ----------

/// COMMIT 失败也必须回滚；回滚失败如实双报错。返回 (commit结果, 是否无悬挂事务)
fn commit_or_rollback(conn: &Connection) -> Result<(), String> {
    match conn.execute_batch("COMMIT") {
        Ok(()) => Ok(()),
        Err(e) => match conn.execute_batch("ROLLBACK") {
            Ok(()) => Err(format!("COMMIT 失败（已回滚，无悬挂事务）：{}", e)),
            Err(re) => Err(format!(
                "COMMIT 失败且回滚亦失败——本连接不可再使用，请丢弃：{} / {}",
                e, re
            )),
        },
    }
}

fn rollback_quietly(conn: &Connection) {
    let _ = conn.execute_batch("ROLLBACK");
}

// ---------- 迁移 ----------

/// 已版本化的旧库（v2/v3/v4）各自的形态校验
fn validator_for(v: u32) -> fn(&Connection) -> Result<(), String> {
    match v {
        SCHEMA_VERSION_V2 => validate_current_v2,
        SCHEMA_VERSION_V3 => validate_current_v3,
        _ => validate_current_v4,
    }
}

/// 事务内迁移：全部步骤成功才 COMMIT 并写 user_version；任一步失败（含 COMMIT 失败）
/// 整体回滚，不留悬挂事务。
pub fn migrate(conn: &Connection) -> Result<u32, String> {
    let v = user_version(conn)?;
    if v == SCHEMA_VERSION_CURRENT {
        // F01：幂等路径也必须实际校验形态——畸形 v3 不放行
        return validate_current_v5(conn).map(|_| v).map_err(|e| {
            format!("{}：user_version=5 但形态校验失败——拒绝（不猜测修库）", e)
        });
    }
    if v == SCHEMA_VERSION_V2 || v == SCHEMA_VERSION_V3 || v == SCHEMA_VERSION_V4 {
        let validate = validator_for(v);
        validate(conn).map_err(|e| {
            format!("{}：user_version={} 但形态校验失败——拒绝（不猜测修库）", e, v)
        })?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let r = (|| -> Result<u32, String> {
            if v == SCHEMA_VERSION_V2 { apply_v3(conn)?; }
            if v < SCHEMA_VERSION_V4 { apply_v4(conn)?; }
            apply_v5(conn)?;
            conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION_CURRENT))
                .map_err(|e| format!("写 user_version 失败：{}", e))?;
            validate_current_v5(conn)?;
            Ok(SCHEMA_VERSION_CURRENT)
        })();
        return match r {
            Ok(v3) => commit_or_rollback(conn).map(|_| v3),
            Err(e) => {
                rollback_quietly(conn);
                Err(e)
            }
        };
    }
    if v > SCHEMA_VERSION_CURRENT {
        return Err(format!(
            "数据库 schema 版本 {} 高于本程序支持的 {}（未来版本）——拒绝打开，请升级 App",
            v, SCHEMA_VERSION_CURRENT
        ));
    }
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let result = (|| -> Result<u32, String> {
        if !any_user_table(conn)? {
            conn.execute_batch(V1_SUGGESTIONS_DDL).map_err(|e| format!("建表失败：{}", e))?;
        } else {
            // v0 历史库：严格识别（核心列必须齐备），残库在此被拒
            validate_legacy_v0(conn)?;
            if column_exists(conn, "suggestions", "content_envelope")? {
                return Err("Unknown schema：user_version=0 却已含 content_envelope——形态无法解释，拒绝".into());
            }
        }
        // 表/列补齐（fresh 与历史共用；幂等守卫，失败即错）
        if !table_exists(conn, "steps")? {
            conn.execute_batch(V1_SUGGESTIONS_DDL).map_err(|e| format!("补建 steps 失败：{}", e))?;
        } else if !column_exists(conn, "steps", "result")? {
            conn.execute_batch("ALTER TABLE steps ADD COLUMN result TEXT DEFAULT '';")
                .map_err(|e| format!("补 steps.result 失败：{}", e))?;
        }
        if !table_exists(conn, "attachments")? {
            conn.execute_batch(V1_SUGGESTIONS_DDL).map_err(|e| format!("补建 attachments 失败：{}", e))?;
        }
        if !table_exists(conn, "session_aliases")? {
            conn.execute_batch(V1_SUGGESTIONS_DDL).map_err(|e| format!("补建 session_aliases 失败：{}", e))?;
        }
        if !column_exists(conn, "suggestions", "user_msg")? {
            conn.execute_batch("ALTER TABLE suggestions ADD COLUMN user_msg TEXT DEFAULT '';")
                .map_err(|e| format!("补 suggestions.user_msg 失败：{}", e))?;
        }
        if !column_exists(conn, "suggestions", "window_id")? {
            conn.execute_batch("ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0;")
                .map_err(|e| format!("补 suggestions.window_id 失败：{}", e))?;
        }
        if !column_exists(conn, "suggestions", "content_envelope")? {
            conn.execute_batch("ALTER TABLE suggestions ADD COLUMN content_envelope TEXT;")
                .map_err(|e| format!("加 content_envelope 失败：{}", e))?;
        }
        // 先到 v2 形态（中间校验），再同一事务内补 v3 增量
        validate_current_v2(conn)?;
        apply_v3(conn)?;
        apply_v4(conn)?;
        apply_v5(conn)?;
        conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION_CURRENT))
            .map_err(|e| format!("写 user_version 失败：{}", e))?;
        // 提交前完整校验目标形态，杜绝「成功标记的畸形 schema」
        validate_current_v5(conn)?;
        Ok(SCHEMA_VERSION_CURRENT)
    })();
    match result {
        Ok(v2) => match commit_or_rollback(conn) {
            Ok(()) => Ok(v2),
            Err(e) => Err(e),
        },
        Err(e) => {
            rollback_quietly(conn);
            Err(e)
        }
    }
}

// ---------- F04：快照门控 + 权威打开 ----------

/// 打开 + 权威迁移。顺序（F01/F04）：
/// 1) 只读预检版本/形态（此前不设任何持久 pragma）；
/// 2) 已验证 v2 → 设 WAL 放行（幂等，不制造快照）；
/// 3) 全新库 → 直接迁移（无历史可快照）；
/// 4) 历史库升级 → 先取 WAL-safe 快照 + 快照校验 + manifest，失败不执行任何 DDL；
/// 5) 迁移成功后才设 WAL。
pub fn open_and_migrate(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    let v = user_version(&conn)?;
    if v == SCHEMA_VERSION_CURRENT {
        validate_current_v5(&conn).map_err(|e| {
            format!("{}：user_version=5 但形态校验失败——拒绝打开（不猜测修库）", e)
        })?;
        let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
        return Ok(conn);
    }
    if v > SCHEMA_VERSION_CURRENT {
        return Err(format!("数据库 schema 版本 {} 高于本程序支持的 {}（未来版本）——拒绝打开，请升级 App", v, SCHEMA_VERSION_CURRENT));
    }
    if v == SCHEMA_VERSION_V2 || v == SCHEMA_VERSION_V3 || v == SCHEMA_VERSION_V4 {
        // v2/v3/v4 → 当前版本的升级同样先过快照门控（快照+校验+manifest 失败则不执行任何 DDL）
        let validate = validator_for(v);
        validate(&conn).map_err(|e| {
            format!("{}：user_version={} 但形态校验失败——拒绝打开（不猜测修库）", e, v)
        })?;
        snapshot_gate_before_upgrade(&conn, path, v)?;
        migrate(&conn)?;
        let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
        return Ok(conn);
    }
    // v==0
    if !any_user_table(&conn)? {
        // 全新库：无历史可快照，直接迁移
        migrate(&conn)?;
        let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
        return Ok(conn);
    }
    // 历史库升级：先严格识别，再快照门控，最后 DDL
    validate_legacy_v0(&conn)?;
    snapshot_gate_before_upgrade(&conn, path, v)?;
    migrate(&conn)?;
    let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
    Ok(conn)
}

/// 唯一时间戳部件（毫秒 + pid + 计数），避免秒级碰撞与固定名覆盖
fn unique_suffix(tag: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{}-{}-{}", tag, ms, std::process::id(), CTR.fetch_add(1, Ordering::Relaxed))
}

/// F04+R2-F03 快照门控：WAL-safe 快照（VACUUM INTO，含 WAL 内已提交数据）→ 只读校验 →
/// manifest（行数 + 逐条 quote 对账：NULL 显式标记、读取错误传播、主键覆盖=行数）。
/// 任一失败 → Err，调用方不执行 DDL。manifest 记录**快照时点状态**；快照之后新增内容
/// 不在其中——恢复必须走保护副本/导出流程（见 restore_with_protection 与批次报告）。
fn snapshot_gate_before_upgrade(conn: &Connection, db_path: &Path, source_version: u32) -> Result<PathBuf, String> {
    let snap = db_path.with_file_name(format!(
        "{}.premigrate-{}.snapshot",
        db_path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        unique_suffix("v")
    ));
    if snap.exists() {
        return Err(format!("快照路径已存在（不覆盖）：{}", snap.display()));
    }
    backup_into(conn, &snap)?;
    let check = open_readonly(&snap)?;
    verify_integrity_and_fk(&check)?;
    let mut counts = std::collections::BTreeMap::new();
    for t in KNOWN_TABLES {
        if table_exists(&check, t)? {
            let n: i64 = check
                .query_row(&format!("SELECT COUNT(*) FROM {}", t), [], |r| r.get(0))
                .map_err(|e| format!("快照行数对账失败（{}）：{}", t, e))?;
            counts.insert(t.to_string(), n);
        }
    }
    // 逐条 quote 对账（R2-F03）：
    //  * quote NULL（DDL 允许值）→ sha256=null + quote_null=true，与空串显式区分，不改旧 quote；
    //  * 行读取错误一律传播并阻止 DDL（绝不 filter_map 丢错生成不完整 manifest）；
    //  * 主键覆盖数 == 表行数，不符即失败。
    let mut quote_records: Vec<serde_json::Value> = Vec::new();
    if table_exists(&check, "suggestions")? {
        let mut stmt = check
            .prepare("SELECT id, quote FROM suggestions ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("quote 行读取失败（阻止 DDL，不生成不完整 manifest）：{}", e))?;
        let total: i64 = check
            .query_row("SELECT COUNT(*) FROM suggestions", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if rows.len() as i64 != total {
            return Err(format!(
                "quote 主键覆盖不完整：读到 {} 条 ≠ 表行数 {}——拒绝（不生成不完整 manifest）",
                rows.len(), total
            ));
        }
        for (id, q) in rows {
            let rec = match q {
                Some(text) => {
                    let h = sha256_system(&text).map_err(|e| format!("quote 哈希失败（#{}）：{}", id, e))?;
                    serde_json::json!({"id": id, "sha256": h, "quote_null": false})
                }
                None => serde_json::json!({"id": id, "sha256": null, "quote_null": true}),
            };
            quote_records.push(rec);
        }
    }
    let pk_covered = quote_records.len() as i64;
    let manifest_path = db_path.with_file_name(format!(
        "{}.premigrate-manifest-{}.json",
        db_path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        unique_suffix("m")
    ));
    let manifest = serde_json::json!({
        "source_db": db_path.display().to_string(),
        "source_user_version": source_version,
        "snapshot": snap.display().to_string(),
        "snapshot_row_counts": counts,
        "quote_records": quote_records,
        "quote_pk_covered": pk_covered,
        "gate": "manifest 记录快照时点状态（对账凭据）；快照之后新增内容不在其中，恢复须走保护副本/导出流程",
    });
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("manifest 写入失败（不执行 DDL）：{}", e))?;
    crate::log_line(&format!("[数据库] v{} → v{} 升级前快照：{}；manifest：{}", source_version, SCHEMA_VERSION_CURRENT, snap.display(), manifest_path.display()));
    Ok(snap)
}


// ---------- S03：结构化内容读写 ----------

pub fn write_content(conn: &Connection, sid: i64, content: &CapturedContent) -> Result<(), String> {
    let envelope = serde_json::to_string(content).map_err(|e| e.to_string())?;
    let projection = match content.plain_projection() {
        crate::content::PlainProjection::Available { text } => text.clone(),
        crate::content::PlainProjection::Unavailable { .. } => String::new(),
    };
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let r = (|| -> Result<(), String> {
        let n = conn
            .execute(
                "UPDATE suggestions SET content_envelope=?1, quote=?2, updated_at=datetime('now','localtime') WHERE id=?3",
                rusqlite::params![envelope, projection, sid],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("条目 #{} 不存在", sid));
        }
        Ok(())
    })();
    match r {
        Ok(()) => match commit_or_rollback(conn) {
            Ok(()) => Ok(()),
            Err(e) => Err(e),
        },
        Err(e) => {
            rollback_quietly(conn);
            Err(e)
        }
    }
}

pub fn read_content(conn: &Connection, sid: i64) -> Result<CapturedContent, String> {
    let row: Option<(Option<String>, String)> = conn
        .query_row("SELECT content_envelope, quote FROM suggestions WHERE id=?1", [sid], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })?;
    let (envelope, quote) = row.ok_or_else(|| format!("条目 #{} 不存在", sid))?;
    match envelope {
        Some(json) => serde_json::from_str::<CapturedContent>(&json)
            .map_err(|e| format!("条目 #{} 的 content_envelope 非法：{}", sid, e)),
        None => CapturedContent::from_legacy_quote(&quote, format!("legacy-sid-{}", sid)),
    }
}

/// quote 更新守卫：structured 行（envelope 非空）拒绝 quote 更新；legacy 行允许。
pub fn quote_update_allowed(conn: &Connection, sid: i64) -> Result<(), String> {
    let structured: Option<bool> = conn
        .query_row("SELECT content_envelope IS NOT NULL FROM suggestions WHERE id=?1", [sid], |r| {
            r.get(0)
        })
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })?;
    match structured {
        None => Err(format!("条目 #{} 不存在", sid)),
        Some(false) => Ok(()),
        Some(true) => Err(format!(
            "条目 #{} 已含结构化内容（content_envelope）：拒绝 quote 更新以免静默破坏结构化正文；如需修改正文请走结构化内容接口",
            sid
        )),
    }
}
// ---------- S04/F02/R2：备份与恢复 ----------

fn open_readonly(path: &Path) -> Result<Connection, String> {
    if !path.exists() {
        return Err(format!("备份不存在：{}（不会创建空备份）", path.display()));
    }
    let uri = format!("file:{}?mode=ro", path.display().to_string().replace('?', "%3f").replace('#', "%23"));
    Connection::open_with_flags(&uri, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI)
        .map_err(|e| format!("备份无法只读打开（{}）：{}", path.display(), e))
}

/// 完整消费 integrity_check 与 foreign_key_check：任何违规都是失败（F02）；
/// 行读取错误传播，绝不静默丢弃（R2-F03 同型要求）。
pub fn verify_integrity_and_fk(conn: &Connection) -> Result<(), String> {
    let ic: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| format!("integrity_check 执行失败：{}", e))?;
    if ic != "ok" {
        return Err(format!("integrity_check 失败：{}", ic));
    }
    let mut stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| format!("foreign_key_check 执行失败：{}", e))?;
    let violations: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("foreign_key_check 读取失败：{}", e))?;
    if !violations.is_empty() {
        return Err(format!(
            "foreign_key_check 发现 {} 行违规（首条：{:?}）——拒绝",
            violations.len(),
            violations.first()
        ));
    }
    Ok(())
}

/// WAL-safe 备份：`VACUUM INTO`（含已提交仍在 WAL 的内容）。目标已存在 → 报错（不覆盖）。
pub fn backup_into(conn: &Connection, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("备份目标已存在（不覆盖）：{}", dest.display()));
    }
    let p = dest.display().to_string().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{}';", p))
        .map_err(|e| format!("备份失败：{}", e))
}

/// offline guard（R2-F02）：以真实 SQLite 锁持有目标库直到替换完成。
/// 副文件（-wal/-shm/-journal）存在 → 拒绝（热日志需回放，不能覆写）；
/// `BEGIN IMMEDIATE` Busy → 有活跃事务/writer（含 DELETE 模式 EXCLUSIVE）→ 拒绝；
/// 成功 → 检查→候选→替换→复验全程持写锁（串行窗口），完成后释放。
/// 边界（如实）：不检测无事务的闲置连接（恢复流程要求停止写入进程）；无全局锁服务。
struct DestWriteGuard {
    conn: Option<Connection>,
}
impl DestWriteGuard {
    fn acquire(dest: &Path) -> Result<Self, String> {
        for suffix in ["-wal", "-shm", "-journal"] {
            let side = dest.with_file_name(format!(
                "{}{}",
                dest.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                suffix
            ));
            if side.exists() {
                return Err(format!(
                    "目标存在 {} 副文件（活跃 WAL 或未回放回滚日志）。离线恢复流程：停止所有写入进程，确认副文件消失后重试。本入口拒绝静默处理。",
                    side.display()
                ));
            }
        }
        if !dest.exists() {
            return Ok(Self { conn: None });
        }
        let conn = Connection::open(dest).map_err(|e| format!("目标打开失败：{}", e))?;
        conn.busy_timeout(std::time::Duration::from_millis(200))
            .map_err(|e| e.to_string())?;
        match conn.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => Ok(Self { conn: Some(conn) }),
            Err(e) => Err(format!(
                "目标正被其他写入者锁定（BEGIN IMMEDIATE 失败：{}）——无法证明 offline，拒绝恢复。请停止所有写入进程后重试。",
                e
            )),
        }
    }
    fn release(mut self) {
        if let Some(c) = self.conn.take() {
            let _ = c.execute_batch("ROLLBACK");
        }
    }
}

/// 受保护恢复（F02 + R2-F02）：备份只读+必须存在 → integrity/FK/形态校验（改目标前完成）
/// → 候选文件验证 → guard 真实锁窗口内 保护→替换→复验。失败原目标仍可用；保护名唯一
/// 不覆盖；快照后新增内容完整保留在保护副本（独立可读）。manifest 只记录快照时点状态。
pub fn restore_with_protection(backup: &Path, dest: &Path) -> Result<Option<PathBuf>, String> {
    // 1) 备份侧校验（目标未被触碰）
    let bak = open_readonly(backup)?;
    verify_integrity_and_fk(&bak)?;
    let bver = user_version(&bak)?;
    if bver != 0 && bver != SCHEMA_VERSION_V2 && bver != SCHEMA_VERSION_V3 && bver != SCHEMA_VERSION_V4 && bver != SCHEMA_VERSION_CURRENT {
        return Err(format!("备份 schema 版本 {} 不受支持——拒绝恢复", bver));
    }
    if bver == SCHEMA_VERSION_CURRENT {
        validate_current_v5(&bak)?;
    } else if bver == SCHEMA_VERSION_V4 {
        validate_current_v4(&bak)?;
    } else if bver == SCHEMA_VERSION_V3 {
        validate_current_v3(&bak)?;
    } else if bver == SCHEMA_VERSION_V2 {
        validate_current_v2(&bak)?;
    } else if any_user_table(&bak)? {
        validate_legacy_v0(&bak)?;
    }
    let mut expected_counts = std::collections::BTreeMap::new();
    for t in KNOWN_TABLES {
        if table_exists(&bak, t)? {
            let n: i64 = bak
                .query_row(&format!("SELECT COUNT(*) FROM {}", t), [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            expected_counts.insert(t.to_string(), n);
        }
    }
    // 2) 候选文件（唯一名，验证后才动目标）
    let candidate = dest.with_file_name(format!(
        "{}.restore-candidate-{}",
        dest.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        unique_suffix("c")
    ));
    if candidate.exists() {
        return Err(format!("候选路径已存在（不覆盖）：{}", candidate.display()));
    }
    backup_into(&bak, &candidate)?;
    {
        let cand = open_readonly(&candidate)?;
        verify_integrity_and_fk(&cand)?;
        for (t, n) in &expected_counts {
            let got: i64 = cand
                .query_row(&format!("SELECT COUNT(*) FROM {}", t), [], |r| r.get(0))
                .map_err(|e| format!("候选对账失败（{}）：{}", t, e))?;
            if got != *n {
                return Err(format!("候选行数不符（{}：{} ≠ 备份 {}）——放弃替换", t, got, n));
            }
        }
    }
    drop(bak);
    // 3) guard：真实锁窗口覆盖 副文件检查→保护→替换→复验
    let guard = DestWriteGuard::acquire(dest)?;
    let outcome = (|| -> Result<Option<PathBuf>, String> {
        let mut protected = None;
        if dest.exists() {
            let mut p = dest.with_file_name(format!(
                "{}.pre-restore-{}",
                dest.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                unique_suffix("p")
            ));
            let mut i = 0;
            while p.exists() {
                p = dest.with_file_name(format!(
                    "{}.pre-restore-{}-{}",
                    dest.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                    unique_suffix("p"),
                    i
                ));
                i += 1;
            }
            std::fs::rename(dest, &p).map_err(|e| format!("保护现有库失败（目标未被改动）：{}", e))?;
            protected = Some(p);
        }
        match std::fs::rename(&candidate, dest) {
            Ok(()) => {
                let post = open_readonly(dest).and_then(|c| verify_integrity_and_fk(&c).map(|_| c));
                match post {
                    Ok(_) => Ok(protected),
                    Err(e) => {
                        let swapped_back = match &protected {
                            Some(p) => std::fs::rename(p, dest).is_ok(),
                            None => {
                                let _ = std::fs::remove_file(dest);
                                true
                            }
                        };
                        Err(format!(
                            "恢复后校验失败：{}{}",
                            e,
                            if swapped_back { "（原目标已换回，仍可用）" } else { "（换回失败！保护文件在原保护路径）" }
                        ))
                    }
                }
            }
            Err(e) => {
                let restored = match &protected {
                    Some(p) => std::fs::rename(p, dest).is_ok(),
                    None => true,
                };
                let _ = std::fs::remove_file(&candidate);
                Err(format!(
                    "候选替换目标失败：{}{}",
                    e,
                    if restored { "（原目标已放回，仍可用）" } else { "（放回失败！原库在保护路径）" }
                ))
            }
        }
    })();
    guard.release();
    outcome
}

/// 经系统 `shasum -a 256` 计算真实 SHA-256（stdin 喂入原始字符串字节）
fn sha256_system(s: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("shasum")
        .arg("-a").arg("256")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("shasum 不可用：{}", e))?;
    child.stdin.as_mut().unwrap().write_all(s.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("shasum 非零退出".into());
    }
    let hex = String::from_utf8_lossy(&out.stdout);
    Ok(hex.split_whitespace().next().unwrap_or_default().to_string())
}

// 测试
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{AcquisitionKind, DeclaredFormat, FormatProvenance, Original};
    use std::path::PathBuf;

    const FIXDIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/migrations/fixtures");

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nayan-r1-{}-{}", tag, std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    fn apply_fixture(path: &Path, sql: &str) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(sql).unwrap();
        conn
    }

    /// env 驱动 driver：外部测试经此用真实 Rust 迁移建库（S05/MCP 初始化）。
    #[test]
    fn driver_init_db() {
        let Ok(path) = std::env::var("NAYAN_MIGRATION_INIT_DB") else { return };
        if path.trim().is_empty() {
            return;
        }
        let p = PathBuf::from(&path);
        let conn = open_and_migrate(&p).expect("driver 建库/迁移失败");
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION_CURRENT);
    }

    // ---------- R2-F01：结构校验（主键/类型/NOT NULL/四表） ----------

    #[test]
    fn r2f01_attachments_only_id_rejected() {
        let d = tmpdir("r2f1a");
        let p = d.join("att.db");
        let sql = std::fs::read_to_string(format!("{}/v1-full.sql", FIXDIR)).unwrap();
        {
            let c = apply_fixture(&p, &sql);
            c.execute_batch("DROP TABLE attachments; CREATE TABLE attachments (id INTEGER PRIMARY KEY);").unwrap();
        }
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("attachments") && (err.contains("列集合") || err.contains("缺列")), "attachments(id) 残库必须拒绝：{}", err);
        let c2 = Connection::open(&p).unwrap();
        assert_eq!(user_version(&c2).unwrap(), 0, "拒绝后版本不变");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn r2f01_suggestions_ctas_missing_pk_rejected() {
        let d = tmpdir("r2f1b");
        let p = d.join("ctas.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        {
            let c = apply_fixture(&p, &sql);
            // CTAS 重建：列名相同但丢主键/NOT NULL/默认值 → INSERT 会产生 NULL id
            c.execute_batch(
                "CREATE TABLE ctas_sug AS SELECT id, title, quote, my_note, source_tool, workspace, session_ref, tags, status, kind, priority, created_at, updated_at, user_msg FROM suggestions;
                 DROP TABLE suggestions;
                 ALTER TABLE ctas_sug RENAME TO suggestions;",
            ).unwrap();
        }
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("主键") || err.contains("NOT NULL") || err.contains("类型"), "CTAS 形态漂移（主键/NOT NULL/类型任一）必须拒绝：{}", err);
        // INSERT 产生 NULL id 的实证（总控反例）：该库直接插入确会得到 NULL——由拒绝迁移杜绝
        {
            let c2 = Connection::open(&p).unwrap();
            let _ = c2.execute("INSERT INTO suggestions (title) VALUES ('x')", []);
            let null_id: Option<i64> = c2
                .query_row("SELECT id FROM suggestions WHERE title='x'", [], |r| r.get(0))
                .unwrap();
            assert!(null_id.is_none(), "畸形库确实产生 NULL id——证明校验必要性");
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn r2f01_wrong_type_and_missing_insert_column_rejected() {
        let d = tmpdir("r2f1c");
        // 关键列类型错误（title INTEGER）
        let p1 = d.join("t1.db");
        {
            let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
            let c = apply_fixture(&p1, &sql);
            c.execute_batch("DROP TABLE suggestions;").unwrap();
            drop(c);
            let c2 = Connection::open(&p1).unwrap();
            c2.execute_batch("CREATE TABLE suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, title INTEGER NOT NULL, quote TEXT DEFAULT '', my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', session_ref TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT, updated_at TEXT, user_msg TEXT DEFAULT '');").unwrap();
        }
        let e1 = open_and_migrate(&p1).unwrap_err();
        assert!(e1.contains("类型不符"), "{}", e1);
        // 缺外部 writer 实际 INSERT 使用列（sync 用 session_ref；MCP 用 kind/tags）
        let p2 = d.join("t2.db");
        {
            let c = Connection::open(&p2).unwrap();
            c.execute_batch("CREATE TABLE suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, quote TEXT DEFAULT '', my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT, updated_at TEXT, user_msg TEXT DEFAULT '');").unwrap(); // 无 session_ref
        }
        let e2 = open_and_migrate(&p2).unwrap_err();
        assert!(e2.contains("session_ref"), "缺服务 INSERT 使用列必须拒绝：{}", e2);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn r2f01_v2_structural_malformed_rejected() {
        let d = tmpdir("r2f1d");
        let p = d.join("v2m.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch(V1_SUGGESTIONS_DDL).unwrap();
            c.execute_batch("ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0; ALTER TABLE suggestions ADD COLUMN content_envelope TEXT; PRAGMA user_version=2;").unwrap();
            // 破坏 steps：去掉 content 的 NOT NULL（重建成 CTAS 形态）
            c.execute_batch("CREATE TABLE steps2 AS SELECT * FROM steps; DROP TABLE steps; ALTER TABLE steps2 RENAME TO steps;").unwrap();
        }
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("steps") && (err.contains("主键") || err.contains("NOT NULL") || err.contains("类型") || err.contains("列集合")), "{}", err);
        let _ = std::fs::remove_dir_all(d);
    }

    // ---------- R2-F02：DELETE 模式活跃 writer ----------

    #[test]
    fn r2f02_delete_journal_exclusive_writer_rejected() {
        let d = tmpdir("r2f2a");
        // 目标：DELETE 模式 + writer BEGIN EXCLUSIVE 持未提交事务（无 -wal/-shm，总控反例形态）
        let dest = d.join("live-del.db");
        let sql = std::fs::read_to_string(format!("{}/v1-full.sql", FIXDIR)).unwrap();
        let writer = apply_fixture(&dest, &sql); // DELETE journal（未设 WAL）
        writer.execute_batch("BEGIN EXCLUSIVE; UPDATE suggestions SET title='未提交';").unwrap();
        // 备份：合法合成快照（delete 模式链）
        let sd = tmpdir("r2f2a-src");
        let src = sd.join("src.db");
        {
            let sc = apply_fixture(&src, &sql);
            let _ = sc.execute_batch("PRAGMA journal_mode=delete;");
            sc.execute("INSERT INTO suggestions (title, quote) VALUES ('s', 'snap')", []).unwrap();
        }
        let bak = sd.join("snap.db");
        {
            let sc = open_readonly(&src).unwrap();
            backup_into(&sc, &bak).unwrap();
        }
        // 恢复必须拒绝：无法证明 offline（writer 活跃、无副文件可查）
        let err = restore_with_protection(&bak, &dest).unwrap_err();
        assert!(err.contains("锁定") || err.contains("拒绝"), "DELETE 模式活跃 writer 必须拒绝：{}", err);
        // writer 事务仍可正常提交/回滚；目标未被替换
        writer.execute_batch("ROLLBACK;").unwrap();
        let t: Option<String> = writer.query_row("SELECT title FROM suggestions LIMIT 1", [], |r| r.get(0)).ok();
        assert_ne!(t.as_deref(), Some("未提交"), "回滚生效");
        drop(writer);
        // 停止 writer 后恢复成功（正例）
        restore_with_protection(&bak, &dest).unwrap();
        let c = open_readonly(&dest).unwrap();
        let q: String = c.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "snap", "停止 writer 后恢复成功");
        let _ = std::fs::remove_dir_all(d);
        let _ = std::fs::remove_dir_all(sd);
    }

    // ---------- R2-F03：manifest NULL/错误传播/全表对账 ----------

    #[test]
    fn r2f03_null_quote_manifest_explicit() {
        let d = tmpdir("r2f3a");
        let p = d.join("nullq.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        {
            let c = apply_fixture(&p, &sql);
            c.execute("INSERT INTO suggestions (title, quote) VALUES ('t', NULL)", []).unwrap(); // DDL 允许 NULL
        }
        let conn = open_and_migrate(&p).unwrap();
        let _ = conn;
        let manifest_path = {
            let mut m: Option<std::path::PathBuf> = None;
            for e in std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()) {
                if e.path().to_string_lossy().contains("manifest") { m = Some(e.path()); }
            }
            m.expect("manifest 未生成")
        };
        let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        // NULL 显式记录：quote_null=true、sha256=null（与空串的真实哈希显式区分）
        assert_eq!(m["quote_pk_covered"].as_i64(), Some(1), "NULL 行也计入主键覆盖");
        assert_eq!(m["quote_records"][0]["quote_null"].as_bool(), Some(true));
        assert!(m["quote_records"][0]["sha256"].is_null(), "NULL 不虚构哈希");
        // 原行 quote 仍为 NULL（不改旧数据）
        let c2 = Connection::open(&p).unwrap();
        let q: Option<String> = c2.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert!(q.is_none(), "NULL 语义保留");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn r2f03_unreadable_quote_blocks_ddl() {
        let d = tmpdir("r2f3b");
        let p = d.join("blob.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        {
            let c = apply_fixture(&p, &sql);
            // quote 存入非文本 BLOB（读取 String 失败——错误必须传播而非丢行）
            c.execute("INSERT INTO suggestions (title, quote) VALUES ('t', X'CAFE')", []).unwrap();
        }
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("读取失败") || err.contains("不完整"), "不可读行必须阻止 DDL：{}", err);
        let c2 = Connection::open(&p).unwrap();
        assert_eq!(user_version(&c2).unwrap(), 0, "未迁移");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn r2f03_full_table_reconciliation_across_upgrade() {
        let d = tmpdir("r2f3c");
        let p = d.join("full.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        // 四表全部写入数据（含主键与内容），记录升级前全表状态
        {
            let c = apply_fixture(&p, &sql);
            c.execute("INSERT INTO suggestions (title, quote, my_note, workspace, session_ref, tags, status) VALUES ('t1', 'q1·🐱', 'n1', '/w', 's1', 'g', 'todo')", []).unwrap();
            c.execute("INSERT INTO suggestions (title, quote) VALUES ('t2', NULL)", []).unwrap();
            c.execute("INSERT INTO steps (suggestion_id, content, is_cmd, ord, result) VALUES (1, 'step-1', 1, 0, 'out')", []).unwrap();
            // v0-5 fixture 无 attachments/session_aliases——按已知 DDL 补建后写入（该形态合法）
            c.execute_batch("CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime'))); CREATE TABLE IF NOT EXISTS session_aliases (app TEXT NOT NULL, session_ref TEXT NOT NULL, window_id INTEGER NOT NULL DEFAULT 0, alias TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY (app, session_ref, window_id));").unwrap();
            c.execute("INSERT INTO attachments (suggestion_id, path, name) VALUES (1, '/tmp/a.md', 'a.md')", []).unwrap();
            c.execute("INSERT INTO session_aliases (app, session_ref, window_id, alias) VALUES ('ZCode', 's1', 0, '别名')", []).unwrap();
        }
        let before = dump_all_tables(&p);
        let conn = open_and_migrate(&p).unwrap();
        let after = dump_all_tables(&p);
        // 对账口径：迁移新增的元数据列（window_id INTEGER 默认 0 / content_envelope NULL）单列预期；
        // 其余全部既有列逐值比较。
        let mut after_cmp = after.clone();
        // v3（2026-10-11）：另加四个清单/对比列（默认 NULL/空串），并预置三个清单——单列预期后剥离
        strip_added_columns(&mut after_cmp, &["window_id=Integer(0)", "content_envelope=Null",
            "list_id=Null", "wait_note=Text(\"\")", "remind_on=Null", "compare_group_id=Null", "deleted_at=Null", "ai_extras=Null"]);
        let preset: Vec<&str> = after_cmp.split('\n').filter(|l| l.starts_with("[lists]")).collect();
        assert_eq!(preset.len(), 3, "v3 预置三个清单");
        assert!(preset[0].contains("name=Text(\"后期\") mode=Text(\"date\")") && preset[1].contains("name=Text(\"资料\") mode=Text(\"none\")") && preset[2].contains("name=Text(\"每天回顾\") mode=Text(\"daily\")"), "预置清单名与提醒方式");
        let after_cmp: String = after_cmp.split('\n').filter(|l| !l.starts_with("[lists]")).collect::<Vec<_>>().join("\n");
        assert_eq!(before, after_cmp, "升级前后四表既有内容逐字节对账（含 NULL/主键）");
        // manifest 主键覆盖=行数（2 条含 1 NULL）
        let manifest = {
            let mut m: Option<std::path::PathBuf> = None;
            for e in std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()) {
                if e.path().to_string_lossy().contains("manifest") { m = Some(e.path()); }
            }
            m.unwrap()
        };
        let mv: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        assert_eq!(mv["quote_pk_covered"].as_i64(), Some(2));
        assert_eq!(mv["quote_records"].as_array().unwrap().len(), 2);
        let nulls: Vec<_> = mv["quote_records"].as_array().unwrap().iter().filter(|r| r["quote_null"] == true).collect();
        assert_eq!(nulls.len(), 1, "NULL 显式计数");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn r2f03_snapshot_ddl_window_post_snapshot_row_survives_and_protected() {
        // 快照→DDL 写入窗口（总控要求披露+演练）：真实函数序列 + 测试同步点
        let d = tmpdir("r2f3d");
        let p = d.join("win.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        {
            let c = apply_fixture(&p, &sql);
            c.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'pre-snapshot')", []).unwrap();
        }
        // 步骤 1：真实门控（快照+manifest）
        {
            let conn = Connection::open(&p).unwrap();
            conn.busy_timeout(std::time::Duration::from_secs(3)).unwrap();
            snapshot_gate_before_upgrade(&conn, &p, 0).unwrap();
            // 步骤 2（窗口）：快照后、DDL 前外部写入一行——模拟并发 writer
            conn.execute("INSERT INTO suggestions (title, quote) VALUES ('w', 'window-row')", []).unwrap();
            // 步骤 3：真实迁移（窗口行不被升级丢弃）
            migrate(&conn).unwrap();
            let q: String = conn.query_row("SELECT quote FROM suggestions WHERE id=2", [], |r| r.get(0)).unwrap();
            assert_eq!(q, "window-row", "快照后新增行在升级中存活");
        }
        // 步骤 4：恢复旧快照（保护副本独立可读地保留窗口行）
        let snap = {
            let mut s: Option<std::path::PathBuf> = None;
            for e in std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()) {
                let n = e.path().to_string_lossy().to_string();
                if n.contains(".snapshot") { s = Some(e.path()); }
            }
            s.unwrap()
        };
        // 现库含窗口行；恢复旧快照 → 保护副本必须含窗口行（完整可验证，独立读回）
        {
            // 离线化：无连接持有
        }
        let protected = restore_with_protection(&snap, &p).unwrap().expect("现有库必须生成保护文件");
        let pc = open_readonly(&protected).unwrap();
        verify_integrity_and_fk(&pc).unwrap();
        let q2: String = pc.query_row("SELECT quote FROM suggestions WHERE id=2", [], |r| r.get(0)).unwrap();
        assert_eq!(q2, "window-row", "快照后新增内容在保护副本中独立可读（非仅存在性）");
        let q1: String = pc.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q1, "pre-snapshot");
        drop(pc);
        // 恢复后的主库回到快照时点
        let rc = open_readonly(&p).unwrap();
        let n: i64 = rc.query_row("SELECT COUNT(*) FROM suggestions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(d);
    }

    /// 从 suggestions 行剥离「合法新增元数据列」的值段（升级新增列单列预期）：
    /// 每段先断言存在于 suggestions 行（证明新列默认值正确），再仅从这些行移除
    /// （session_aliases 的同名既有列 window_id 不受影响）。
    pub(super) fn strip_added_columns(dump: &mut String, added: &[&str]) {
        let lines: Vec<String> = dump.split('\n').map(|l| {
            if !l.starts_with("[suggestions]") {
                return l.to_string();
            }
            let mut l = l.to_string();
            for a in added {
                let seg = format!(" {}", a);
                assert!(l.contains(&seg), "suggestions 新增列默认值应为 {}（未见）", a);
                l = l.replace(&seg, "");
            }
            l
        }).collect();
        *dump = lines.join("\n");
    }

    pub(super) fn dump_all_tables(p: &Path) -> String {
        // 全表逐行转储（table: pk 列按序拼接），用于升级前后逐字节对账
        let c = open_readonly(p).unwrap();
        let mut out = String::new();
        for t in KNOWN_TABLES {
            if !table_exists(&c, t).unwrap() { continue; }
            let cols = columns(&c, t).unwrap();
            let mut stmt = c.prepare(&format!("SELECT * FROM {} ORDER BY 1", t)).unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Ok(Some(r)) = rows.next() {
                let mut line = format!("[{}]", t);
                for i in 0..cols.len() {
                    let v: rusqlite::types::Value = r.get(i).unwrap();
                    line.push_str(&format!(" {}={:?}", cols[i], v));
                }
                out.push_str(&line);
                out.push('\n');
            }
        }
        out
    }

    // ---------- F01：畸形形态拒绝 ----------

    #[test]
    fn f01_empty_db_marked_v2_rejected() {
        let d = tmpdir("f01a");
        let p = d.join("e.db");
        let c = Connection::open(&p).unwrap();
        c.execute_batch("PRAGMA user_version=2;").unwrap();
        drop(c);
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("malformed v2") || err.contains("缺表"), "{}", err);
        // 拒绝后无任何持久变化：无表、版本仍 2、journal 未被改（默认 delete）
        let c2 = Connection::open(&p).unwrap();
        let n: i64 = c2.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "拒绝后不得建表");
        assert_eq!(user_version(&c2).unwrap(), 2);
        let jm: String = c2.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(jm.to_lowercase(), "delete", "预检失败前不得改 journal_mode");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f01_v0_missing_core_columns_rejected() {
        let d = tmpdir("f01b");
        let p = d.join("r.db");
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE suggestions (id INTEGER PRIMARY KEY); PRAGMA user_version=0;").unwrap();
        drop(c);
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("历史核心列"), "{}", err);
        let c2 = Connection::open(&p).unwrap();
        assert_eq!(user_version(&c2).unwrap(), 0, "拒绝后版本不变");
        let cols = columns(&c2, "suggestions").unwrap();
        assert_eq!(cols, vec!["id".to_string()], "拒绝后不得补列");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f01_pseudo_v2_old_tables_rejected() {
        let d = tmpdir("f01c");
        let p = d.join("pseudo.db");
        let sql = std::fs::read_to_string(format!("{}/v1-full.sql", FIXDIR)).unwrap();
        let c = apply_fixture(&p, &sql);
        c.execute_batch("PRAGMA user_version=2;").unwrap();
        drop(c);
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("content_envelope"), "伪 v2（旧完整表缺 envelope）必须拒绝：{}", err);
        let c2 = Connection::open(&p).unwrap();
        assert!(!column_exists(&c2, "suggestions", "content_envelope").unwrap(), "拒绝后不得加列");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f01_future_version_keeps_journal_mode() {
        let d = tmpdir("f01d");
        let p = d.join("fut.db");
        let sql = std::fs::read_to_string(format!("{}/v1-full.sql", FIXDIR)).unwrap();
        let c = apply_fixture(&p, &sql);
        c.execute_batch("PRAGMA user_version=99;").unwrap();
        drop(c);
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("未来版本"), "{}", err);
        let c2 = Connection::open(&p).unwrap();
        let jm: String = c2.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(jm.to_lowercase(), "delete", "拒绝前不改 journal_mode（对照 sync 反例）");
        let _ = std::fs::remove_dir_all(d);
    }

    // ---------- F03：真实事务失败闭环（外部锁 → COMMIT busy） ----------

    /// 真实 migrate 的 COMMIT 失败：DELETE journal + 外部读锁 → COMMIT busy →
    /// 必须已回滚（同连接 autocommit）、数据/schema 不变；释放锁重开仍 prior；重试成功。
    #[test]
    fn f03_migrate_commit_failure_closes_transaction() {
        let d = tmpdir("f03a");
        let p = d.join("m.db");
        let sql = std::fs::read_to_string(format!("{}/v1-full.sql", FIXDIR)).unwrap();
        let conn = apply_fixture(&p, &sql); // DELETE journal（未设 WAL）
        conn.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'q-prior')", []).unwrap();
        // 外部读连接持共享锁（DELETE 模式下 COMMIT 需独占 → busy）
        let reader = Connection::open(&p).unwrap();
        reader.execute_batch("BEGIN; SELECT COUNT(*) FROM suggestions;").unwrap();
        let r = migrate(&conn);
        let err = r.expect_err("持读锁时 COMMIT 应失败");
        assert!(err.contains("COMMIT 失败"), "{}", err);
        // F03 核心：错误返回后同连接无悬挂事务（autocommit），且不能被后续偷偷提交
        assert!(conn.is_autocommit(), "失败后必须回到 autocommit，无悬挂事务");
        reader.execute_batch("COMMIT;").unwrap();
        drop(reader);
        // 释放锁后：重开检查 schema/版本/数据仍是 prior
        let check = Connection::open(&p).unwrap();
        assert_eq!(user_version(&check).unwrap(), 0);
        assert!(!column_exists(&check, "suggestions", "content_envelope").unwrap());
        let q: String = check.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "q-prior");
        drop(check);
        drop(conn);
        // 正常重试成功
        let ok = open_and_migrate(&p).unwrap();
        assert_eq!(user_version(&ok).unwrap(), SCHEMA_VERSION_CURRENT);
        let q2: String = ok.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q2, "q-prior", "升级不改动数据");
        let _ = std::fs::remove_dir_all(d);
    }

    /// write_content 的 COMMIT 失败同等闭环：envelope+quote 原子（都不落）。
    #[test]
    fn f03_write_content_commit_failure_atomic() {
        let d = tmpdir("f03b");
        let p = d.join("w.db");
        let sql = std::fs::read_to_string(format!("{}/v1-full.sql", FIXDIR)).unwrap();
        let conn = apply_fixture(&p, &sql);
        migrate(&conn).unwrap(); // 升到 v2（migrate 不设 journal —— 保持 DELETE 模式）
        conn.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'old')", []).unwrap();
        let reader = Connection::open(&p).unwrap();
        reader.execute_batch("BEGIN; SELECT COUNT(*) FROM suggestions;").unwrap();
        let content = CapturedContent::from_legacy_quote("new-structured", "req-f03").unwrap();
        let err = write_content(&conn, 1, &content).expect_err("持读锁时 COMMIT 应失败");
        assert!(err.contains("COMMIT 失败"), "{}", err);
        assert!(conn.is_autocommit(), "write_content 失败后无悬挂事务");
        reader.execute_batch("COMMIT;").unwrap();
        drop(reader);
        let q: Option<String> = conn
            .query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0))
            .ok();
        assert_eq!(q.as_deref(), Some("old"), "quote 未被半提交污染");
        let env: Option<Option<String>> = conn
            .query_row("SELECT content_envelope FROM suggestions WHERE id=1", [], |r| r.get(0))
            .ok();
        assert_eq!(env.flatten(), None, "envelope 未写入（原子）");
        let _ = std::fs::remove_dir_all(d);
    }

    /// SQLite 事务语义说明（保留为文档性测试，不作为真实迁移失败证据——见批次报告）
    #[test]
    fn sqlite_begin_rollback_semantics_documented() {
        let d = tmpdir("f03c");
        let p = d.join("s.db");
        let conn = apply_fixture(&p, V1_SUGGESTIONS_DDL);
        conn.execute_batch("BEGIN").unwrap();
        conn.execute_batch("ALTER TABLE suggestions ADD COLUMN x TEXT;").unwrap();
        conn.execute_batch("ROLLBACK").unwrap();
        assert!(!column_exists(&conn, "suggestions", "x").unwrap());
        let _ = std::fs::remove_dir_all(d);
    }

    // ---------- F02：恢复安全 ----------

    #[test]
    fn f02_missing_backup_refused_without_touching_dest() {
        let d = tmpdir("f02a");
        let dest = d.join("dest.db");
        let c = Connection::open(&dest).unwrap();
        c.execute("CREATE TABLE keep (id INTEGER)", []).unwrap();
        c.execute("INSERT INTO keep VALUES (1)", []).unwrap();
        drop(c);
        let err = restore_with_protection(&d.join("nope.db"), &dest).unwrap_err();
        assert!(err.contains("备份不存在"), "{}", err);
        let c2 = Connection::open(&dest).unwrap();
        let n: i64 = c2.query_row("SELECT COUNT(*) FROM keep", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "目标原样可用");
        assert!(!d.join("nope.db").exists(), "不得创建空备份");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f02_fk_violation_backup_refused() {
        let d = tmpdir("f02b");
        let bad = d.join("bad.db");
        let c = Connection::open(&bad).unwrap();
        c.execute_batch(
            "CREATE TABLE parent (id INTEGER PRIMARY KEY);
             CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
             PRAGMA foreign_keys=OFF; -- rusqlite 默认打开 FK；关掉以写入违规行，foreign_key_check 仍会检出
             INSERT INTO parent VALUES (1);
             INSERT INTO child VALUES (100, 999); -- 违规引用（默认 foreign_keys=OFF 放行写入，check 仍检出）
             PRAGMA user_version=0;
             CREATE TABLE suggestions (id INTEGER PRIMARY KEY, title TEXT NOT NULL, quote TEXT DEFAULT '', my_note TEXT DEFAULT '', source_tool TEXT DEFAULT 'other', workspace TEXT DEFAULT '', session_ref TEXT DEFAULT '', tags TEXT DEFAULT '', status TEXT DEFAULT 'inbox', kind TEXT DEFAULT 'suggestion', priority INTEGER DEFAULT 2, created_at TEXT, updated_at TEXT, user_msg TEXT DEFAULT '');",
        ).unwrap();
        drop(c);
        // FK 结果必须被完整消费：直接对坏库校验 → 报 FK 违规
        let ro = open_readonly(&bad).unwrap();
        let err = verify_integrity_and_fk(&ro).unwrap_err();
        assert!(err.contains("foreign_key_check") && err.contains("违规"), "{}", err);
        drop(ro);
        // 恢复层：任何原因（本例为 FK/未知表）都必须在改目标前拒绝
        let dest = d.join("dest.db");
        let cd = Connection::open(&dest).unwrap();
        cd.execute_batch("CREATE TABLE keep2 (id INTEGER); INSERT INTO keep2 VALUES (7);").unwrap();
        drop(cd);
        assert!(restore_with_protection(&bad, &dest).is_err(), "违规备份必须拒绝");
        let c2 = Connection::open(&dest).unwrap();
        let v: i64 = c2.query_row("SELECT id FROM keep2", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 7, "拒绝时目标未被触碰");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f02_live_wal_dest_refused() {
        let d = tmpdir("f02c");
        // 目标：带活跃 WAL 的库（writer 模拟：开连接写一行不关闭 → -wal 存在）
        let dest = d.join("live.db");
        let writer = open_and_migrate(&dest).unwrap(); // WAL 模式
        writer.execute("INSERT INTO suggestions (title, quote) VALUES ('w', 'in-wal')", []).unwrap();
        // 备份：合法合成快照
        let src_dir = tmpdir("f02c-src");
        let src = src_dir.join("src.db");
        let sc = open_and_migrate(&src).unwrap();
        sc.execute("INSERT INTO suggestions (title, quote) VALUES ('s', 'snap')", []).unwrap();
        let bak = src_dir.join("snap.db");
        backup_into(&sc, &bak).unwrap();
        drop(sc);
        let err = restore_with_protection(&bak, &dest).unwrap_err();
        assert!(err.contains("-wal") && err.contains("拒绝"), "活跃 WAL 必须拒绝：{}", err);
        // 目标未被触碰，数据仍可读
        let q: String = writer.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "in-wal");
        drop(writer);
        let _ = std::fs::remove_dir_all(d);
        let _ = std::fs::remove_dir_all(src_dir);
    }

    #[test]
    fn f02_protection_name_collision_never_overwrites() {
        let d = tmpdir("f02d");
        let src = d.join("src.db");
        let sc = open_and_migrate(&src).unwrap();
        sc.execute("INSERT INTO suggestions (title, quote) VALUES ('s', 'v1')", []).unwrap();
        let _ = sc.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=delete;");
        let bak = d.join("snap.db");
        backup_into(&sc, &bak).unwrap();
        drop(sc);
        let dest = d.join("dest.db");
        let cd = open_and_migrate(&dest).unwrap();
        cd.execute("INSERT INTO suggestions (title, quote) VALUES ('d', 'later-data')", []).unwrap();
        let _ = cd.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=delete;"); // 全链离线化（delete 模式）
        drop(cd);
        // 预占一个「保护名可能撞上的路径」——恢复仍成功且不覆盖既有文件：
        // 我们的实现用唯一名（ms+pid+计数），此处直接验证两次恢复产生的保护文件互不相同
        let p1 = restore_with_protection(&bak, &dest).unwrap().unwrap();
        let p1_before = std::fs::read(&p1).unwrap().len();
        // 快照后新增数据（写入已恢复的 dest），再做第二次恢复；
        // 写完显式离线化（checkpoint + 切回 delete 模式）模拟「writer 已停止」
        {
            let w = Connection::open(&dest).unwrap();
            w.execute("INSERT INTO suggestions (title, quote) VALUES ('d2', 'post1')", []).unwrap();
            let _ = w.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=delete;");
        }
        let bak2 = d.join("snap2.db");
        let sc2 = open_readonly(&bak).unwrap();
        backup_into(&sc2, &bak2).unwrap();
        drop(sc2);
        let p2 = restore_with_protection(&bak2, &dest).unwrap().unwrap();
        assert_ne!(p1, p2, "保护名必须唯一，不覆盖既有保护文件");
        assert_eq!(std::fs::read(&p1).unwrap().len(), p1_before, "第一次保护文件未被覆盖");
        // p2 是完整可读副本：含第一次恢复内容 + 快照后新增（post1），逐行对账
        let c2 = open_readonly(&p2).unwrap();
        verify_integrity_and_fk(&c2).unwrap();
        let n: i64 = c2.query_row("SELECT COUNT(*) FROM suggestions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "保护副本完整（v1 快照行 + post1）");
        let q: String = c2.query_row("SELECT quote FROM suggestions WHERE id=2", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "post1", "快照后新增数据在保护副本中完整可读");
        drop(c2);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f02_wal_safe_backup_and_offline_restore_roundtrip() {
        let d = tmpdir("f02e");
        let p = d.join("main.db");
        let writer = open_and_migrate(&p).unwrap();
        writer.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'committed-in-wal')", []).unwrap();
        let bak = d.join("snapshot.db");
        backup_into(&writer, &bak).unwrap(); // writer 保持打开、数据在 WAL
        // 独立目录恢复（offline：无副文件的目标）
        let d2 = tmpdir("f02e-r");
        let dest = d2.join("restored.db");
        restore_with_protection(&bak, &dest).unwrap();
        let rc = open_readonly(&dest).unwrap();
        let q: String = rc.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "committed-in-wal", "备份包含 WAL 内已提交内容");
        drop(rc);
        let _ = std::fs::remove_dir_all(d);
        let _ = std::fs::remove_dir_all(d2);
    }

    // ---------- F04：迁移入口的备份门控 ----------

    #[test]
    fn f04_upgrade_creates_verified_snapshot_and_manifest() {
        let d = tmpdir("f04a");
        let p = d.join("hist.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        {
            let c = apply_fixture(&p, &sql);
            c.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'hist-data')", []).unwrap();
        }
        let conn = open_and_migrate(&p).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION_CURRENT);
        // 快照 + manifest 已生成
        let mut snaps: Vec<_> = std::fs::read_dir(&d).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|pth| pth.to_string_lossy().contains(".premigrate-"))
            .collect();
        snaps.sort();
        let snapshot = snaps.iter().find(|pth| pth.to_string_lossy().contains(".snapshot")).expect("快照未生成");
        let manifest = snaps.iter().find(|pth| pth.to_string_lossy().contains("manifest")).expect("manifest 未生成");
        // 快照只读可验：含升级前数据 + 版本 0
        let sc = open_readonly(snapshot).unwrap();
        verify_integrity_and_fk(&sc).unwrap();
        let q: String = sc.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "hist-data");
        assert_eq!(user_version(&sc).unwrap(), 0, "快照是升级前状态");
        drop(sc);
        // manifest：行数 + 逐 quote SHA-256（真实算法）
        let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        assert_eq!(m["snapshot_row_counts"]["suggestions"].as_i64(), Some(1));
        assert_eq!(m["quote_pk_covered"].as_i64(), Some(1), "主键覆盖=行数");
        assert_eq!(m["quote_records"][0]["quote_null"].as_bool(), Some(false));
        let h = m["quote_records"][0]["sha256"].as_str().unwrap();
        let expect = sha256_system("hist-data").unwrap();
        assert_eq!(h, expect, "manifest quote 哈希 = 真实 SHA-256");
        assert_eq!(h.len(), 64);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f04_snapshot_includes_wal_committed_data() {
        let d = tmpdir("f04b");
        let p = d.join("w.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        apply_fixture(&p, &sql);
        // writer 在迁移前以 WAL 打开并提交一行（数据只进 WAL）
        {
            let w = Connection::open(&p).unwrap();
            w.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
            w.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'wal-before-upgrade')", []).unwrap();
            // 不做 checkpoint，保持打开
            let conn = open_and_migrate(&p).unwrap(); // 第二连接走升级+快照
            assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION_CURRENT);
        }
        let snaps: Vec<_> = std::fs::read_dir(&d).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|pth| pth.to_string_lossy().contains(".snapshot"))
            .collect();
        assert_eq!(snaps.len(), 1, "升级产生一个快照");
        let sc = open_readonly(&snaps[0]).unwrap();
        let q: String = sc.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "wal-before-upgrade", "快照必须含 WAL 内已提交数据");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f04_backup_failure_blocks_migration() {
        let d = tmpdir("f04c");
        let p = d.join("x.db");
        let sql = std::fs::read_to_string(format!("{}/v0-5-no-window.sql", FIXDIR)).unwrap();
        {
            let c = apply_fixture(&p, &sql);
            c.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'pre-fail')", []).unwrap();
        }
        // 快照目标目录不可写 → 备份失败（chmod 555）
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&d).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&d, perms).unwrap();
        let r = open_and_migrate(&p);
        let ok = r.is_err();
        // 恢复可写以便清理
        let mut perms2 = std::fs::metadata(&d).unwrap().permissions();
        perms2.set_mode(0o755);
        std::fs::set_permissions(&d, perms2).unwrap();
        assert!(ok, "快照失败必须阻止迁移");
        // 迁移被阻止：版本 0、无 content_envelope、数据原样
        let c2 = Connection::open(&p).unwrap();
        assert_eq!(user_version(&c2).unwrap(), 0);
        assert!(!column_exists(&c2, "suggestions", "content_envelope").unwrap());
        let q: String = c2.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "pre-fail");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn f04_snapshot_verification_rejects_corrupt() {
        let d = tmpdir("f04d");
        let p = d.join("c.db");
        let conn = open_and_migrate(&p).unwrap();
        let snap = d.join("s.db");
        backup_into(&conn, &snap).unwrap();
        drop(conn);
        // 破坏快照字节 → 完整性校验必须拒绝
        let mut bytes = std::fs::read(&snap).unwrap();
        let mid = bytes.len() / 2;
        for b in bytes.iter_mut().skip(mid).take(4096) {
            *b = 0xFF;
        }
        std::fs::write(&snap, bytes).unwrap();
        let ro = open_readonly(&snap);
        assert!(ro.is_ok(), "SQLite 可能仍能打开损坏文件");
        let err = verify_integrity_and_fk(&ro.unwrap()).unwrap_err();
        assert!(err.contains("integrity_check"), "{}", err);
        let _ = std::fs::remove_dir_all(d);
    }

    // ---------- 保留与加强的 S02/S03 既有回归 ----------

    #[test]
    fn v2_to_v3_upgrade_snapshot_rows_and_presets() {
        // 2026-10-11 R4：已验证的 v2 库 → 先快照+manifest，再事务内只加 v3 增量；既有行不变、预置三个清单
        let d = tmpdir("v2v3");
        let p = d.join("v2.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch(V1_SUGGESTIONS_DDL).unwrap();
            c.execute_batch("ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0; ALTER TABLE suggestions ADD COLUMN content_envelope TEXT; PRAGMA user_version=2;").unwrap();
            validate_current_v2(&c).unwrap();
            c.execute("INSERT INTO suggestions (title, quote, status) VALUES ('a', 'qa', 'inbox'), ('b', 'qb', 'todo')", []).unwrap();
        }
        let conn = open_and_migrate(&p).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION_CURRENT);
        validate_current_v5(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM suggestions WHERE list_id IS NULL AND wait_note='' AND remind_on IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "既有两行保留且新列为默认值");
        let names: Vec<String> = conn.prepare("SELECT name||':'||mode FROM lists ORDER BY ord").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(names, vec!["后期:date", "资料:none", "每天回顾:daily"]);
        let files: Vec<String> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(files.iter().any(|f| f.contains("premigrate-") && f.ends_with(".snapshot")), "v2→v3 先取快照：{:?}", files);
        assert!(files.iter().any(|f| f.contains("premigrate-manifest")), "v2→v3 写 manifest");
        drop(conn);
        // 再开：幂等、不重复预置、不再制造快照
        let snaps_before = files.iter().filter(|f| f.ends_with(".snapshot")).count();
        let conn2 = open_and_migrate(&p).unwrap();
        let lists: i64 = conn2.query_row("SELECT COUNT(*) FROM lists", [], |r| r.get(0)).unwrap();
        assert_eq!(lists, 3, "重开不重复预置");
        let snaps_after = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".snapshot")).count();
        assert_eq!(snaps_before, snaps_after, "已是 v3 不制造快照");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn malformed_v3_rejected() {
        // user_version=3 但缺 v3 表 / 列 → 拒绝打开，不猜测修库
        let d = tmpdir("badv3");
        let p = d.join("bad.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch(V1_SUGGESTIONS_DDL).unwrap();
            c.execute_batch("ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0; ALTER TABLE suggestions ADD COLUMN content_envelope TEXT; PRAGMA user_version=3;").unwrap();
        }
        let e = open_and_migrate(&p).err().expect("缺 v3 表必须拒绝");
        assert!(e.contains("user_version=3"), "{}", e);
        let c = Connection::open(&p).unwrap();
        assert!(!table_exists(&c, "lists").unwrap(), "拒绝时零改动");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn fresh_db_to_v2_and_idempotent() {
        let d = tmpdir("keep1");
        let p = d.join("fresh.db");
        {
            let conn = open_and_migrate(&p).unwrap();
            assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION_CURRENT);
        }
        {
            let conn2 = open_and_migrate(&p).unwrap();
            assert_eq!(user_version(&conn2).unwrap(), SCHEMA_VERSION_CURRENT);
            let n: i64 = conn2.query_row("SELECT COUNT(*) FROM suggestions", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0);
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn historical_fixtures_upgrade_preserving_rows() {
        for name in ["v1-full.sql", "v0-5-no-window.sql", "v0-4-pre-usermsg.sql"] {
            let d = tmpdir("keep2");
            let p = d.join(name.replace(".sql", ".db"));
            let sql = std::fs::read_to_string(format!("{}/{}", FIXDIR, name)).unwrap();
            {
                let conn = apply_fixture(&p, &sql);
                conn.execute(
                    "INSERT INTO suggestions (title, quote) VALUES ('t', ?1)",
                    ["旧\r\nquote 原文 · 🐱"],
                ).unwrap();
            }
            let conn = open_and_migrate(&p).unwrap();
            assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION_CURRENT, "{} 升级后版本", name);
            let q: String = conn.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
            assert_eq!(q, "旧\r\nquote 原文 · 🐱", "{} quote 逐字节不变", name);
            assert!(column_exists(&conn, "suggestions", "content_envelope").unwrap());
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn unknown_tables_rejected() {
        let d = tmpdir("keep3");
        let p = d.join("u.db");
        let sql = std::fs::read_to_string(format!("{}/unknown-extra.sql", FIXDIR)).unwrap();
        let conn = apply_fixture(&p, &sql);
        drop(conn);
        let err = open_and_migrate(&p).unwrap_err();
        assert!(err.contains("Unknown schema"), "{}", err);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn lock_contention_blocks_then_recovers() {
        let d = tmpdir("keep4");
        let p = d.join("l.db");
        let sql = std::fs::read_to_string(format!("{}/v1-full.sql", FIXDIR)).unwrap();
        let writer = apply_fixture(&p, &sql);
        writer.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'locked-row')", []).unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        assert!(open_and_migrate(&p).is_err(), "持锁期间应失败");
        writer.execute_batch("COMMIT;").unwrap();
        drop(writer);
        let conn = open_and_migrate(&p).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION_CURRENT);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn structured_roundtrip_and_legacy_null() {
        let d = tmpdir("keep5");
        let p = d.join("s3.db");
        let conn = open_and_migrate(&p).unwrap();
        conn.execute("INSERT INTO suggestions (title, quote) VALUES ('legacy', '旧\r\nplain')", []).unwrap();
        let c1 = read_content(&conn, 1).unwrap();
        assert_eq!(c1.format_provenance(), FormatProvenance::LegacyAssumedPlain);
        let bytes = vec![0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE];
        let content = CapturedContent::new(
            "req-s3", DeclaredFormat::Plain, FormatProvenance::Declared,
            AcquisitionKind::Clipboard,
            Original::Bytes { bytes: bytes.clone(), charset_hint: Some("bin".into()) }, false,
        ).unwrap();
        write_content(&conn, 1, &content).unwrap();
        let back = read_content(&conn, 1).unwrap();
        assert_eq!(back, content);
        let q: String = conn.query_row("SELECT quote FROM suggestions WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(q, "");
        conn.execute("INSERT INTO suggestions (title) VALUES ('t2')", []).unwrap();
        let text_c = CapturedContent::new("req-s3b", DeclaredFormat::Markdown, FormatProvenance::Declared,
            AcquisitionKind::Mcp, Original::Text { text: "# h\r\n- a".into() }, false).unwrap();
        write_content(&conn, 2, &text_c).unwrap();
        let q2: String = conn.query_row("SELECT quote FROM suggestions WHERE id=2", [], |r| r.get(0)).unwrap();
        assert_eq!(q2, "# h\n- a");
        let _ = std::fs::remove_dir_all(d);
    }

    /// F01 附加（Missing Evidence）：非法 envelope 的读取拒绝
    #[test]
    fn invalid_envelope_read_rejected() {
        let d = tmpdir("keep6");
        let p = d.join("i.db");
        let conn = open_and_migrate(&p).unwrap();
        conn.execute("INSERT INTO suggestions (title, quote) VALUES ('t', 'q')", []).unwrap();
        conn.execute("UPDATE suggestions SET content_envelope='{broken json' WHERE id=1", []).unwrap();
        let err = read_content(&conn, 1).unwrap_err();
        assert!(err.contains("非法"), "{}", err);
        let _ = std::fs::remove_dir_all(d);
    }

    /// Missing Evidence：真实 handle_api 的 PATCH——structured quote 拒绝 + 元数据更新可用
    #[test]
    fn patch_structured_quote_rejected_via_real_handle_api() {
        let d = tmpdir("keep7");
        let p = d.join("api.db");
        let conn = open_and_migrate(&p).unwrap();
        conn.execute("INSERT INTO suggestions (title, quote) VALUES ('a', 'qa')", []).unwrap();
        conn.execute("INSERT INTO suggestions (title, quote) VALUES ('b', 'qb')", []).unwrap();
        let c = CapturedContent::from_legacy_quote("structured", "req-p").unwrap();
        write_content(&conn, 2, &c).unwrap();
        let state = crate::test_app_state(conn);
        // structured 行 PATCH quote → 真实 API 拒绝
        let err = crate::handle_api(&state, "PATCH", "/api/suggestions/2", &serde_json::json!({"quote": "覆盖尝试"})).unwrap_err();
        assert!(err.contains("结构化内容"), "{}", err);
        // 同行元数据更新（无 quote）→ 成功
        let ok = crate::handle_api(&state, "PATCH", "/api/suggestions/2", &serde_json::json!({"status": "done"})).unwrap();
        assert_eq!(ok["status"], "done");
        // legacy 行 quote 更新 → 仍允许（兼容边界）
        let ok2 = crate::handle_api(&state, "PATCH", "/api/suggestions/1", &serde_json::json!({"quote": "新 legacy"})).unwrap();
        assert_eq!(ok2["quote"], "新 legacy");
        let _ = std::fs::remove_dir_all(d);
    }
}

#[cfg(test)]
mod v4_tests {
    use super::*;
    fn v3(path: &Path) {
        let c=Connection::open(path).unwrap();
        c.execute_batch(V1_SUGGESTIONS_DDL).unwrap();
        c.execute_batch("ALTER TABLE suggestions ADD COLUMN window_id INTEGER DEFAULT 0; ALTER TABLE suggestions ADD COLUMN content_envelope TEXT;").unwrap();
        apply_v3(&c).unwrap();c.execute_batch("PRAGMA user_version=3;").unwrap();validate_current_v3(&c).unwrap();
    }
    #[test]
    fn v3_to_v4_snapshot_manifest_and_full_row_reconciliation() {
        let keep=std::env::var("NAYAN_R9_MIGRATION_DEMO").ok();
        let d=keep.as_ref().map(PathBuf::from).unwrap_or_else(||std::env::temp_dir().join(format!("nayan-v3v4-{}-{}",std::process::id(),unique_suffix("test"))));
        std::fs::create_dir_all(&d).unwrap();let p=d.join("inbox.db");v3(&p);
        {let c=Connection::open(&p).unwrap();c.execute_batch("INSERT INTO suggestions(title,quote,list_id,wait_note,remind_on) VALUES ('迁移样本甲','原文 · 🐱',1,'等测试','2030-01-01'),('迁移样本乙','第二条',NULL,'',NULL); INSERT INTO steps(suggestion_id,content,result) VALUES (1,'步骤','结果'); INSERT INTO attachments(suggestion_id,path,name) VALUES (1,'/tmp/test-only.md','测试附件');").unwrap();}
        let before=tests::dump_all_tables(&p);
        let c=open_and_migrate(&p).unwrap();assert_eq!(user_version(&c).unwrap(),5);validate_current_v5(&c).unwrap();
        let after=tests::dump_all_tables(&p);let mut cmp=after.clone();tests::strip_added_columns(&mut cmp,&["deleted_at=Null","ai_extras=Null"]);assert_eq!(cmp,before);
        let files:Vec<_>=std::fs::read_dir(&d).unwrap().map(|e|e.unwrap().path()).collect();
        let snap=files.iter().find(|p|p.extension().is_some_and(|e|e=="snapshot")).unwrap();
        let manifest=files.iter().find(|p|p.to_string_lossy().contains("manifest")).unwrap();
        let m:serde_json::Value=serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        assert_eq!(m["source_user_version"],3);assert_eq!(m["snapshot_row_counts"]["suggestions"],2);assert_eq!(m["quote_pk_covered"],2);
        let backup=open_readonly(snap).unwrap();assert_eq!(user_version(&backup).unwrap(),3);validate_current_v3(&backup).unwrap();
        println!("R9 migration demo: snapshot={} manifest={} suggestions=2→2 steps=1→1 attachments=1→1",snap.display(),manifest.display());
        drop(c);let c=open_and_migrate(&p).unwrap();validate_current_v5(&c).unwrap();
        assert_eq!(std::fs::read_dir(&d).unwrap().filter(|e|e.as_ref().unwrap().path().extension().is_some_and(|x|x=="snapshot")).count(),1);
        if keep.is_none(){let _=std::fs::remove_dir_all(d);}
    }
    #[test]
    fn malformed_v4_rejected_without_persistent_change() {
        for bad in ["PRAGMA user_version=4;", "ALTER TABLE suggestions ADD COLUMN deleted_at INTEGER; CREATE INDEX idx_suggestions_deleted_at ON suggestions(deleted_at); PRAGMA user_version=4;", "ALTER TABLE suggestions ADD COLUMN deleted_at TEXT; PRAGMA user_version=4;", "ALTER TABLE suggestions ADD COLUMN deleted_at TEXT; CREATE INDEX idx_suggestions_deleted_at ON suggestions(title); PRAGMA user_version=4;"] {
            let d=std::env::temp_dir().join(unique_suffix("nayan-badv4"));std::fs::create_dir_all(&d).unwrap();let p=d.join("bad.db");v3(&p);
            {let c=Connection::open(&p).unwrap();c.execute_batch(bad).unwrap();}
            let before=std::fs::read(&p).unwrap();assert!(open_and_migrate(&p).unwrap_err().contains("user_version=4"));assert_eq!(std::fs::read(&p).unwrap(),before);
            assert!(!std::fs::read_dir(&d).unwrap().any(|e|e.unwrap().path().to_string_lossy().contains("premigrate")));let _=std::fs::remove_dir_all(d);
        }
    }
    #[test]
    fn v3_snapshot_failure_blocks_v4_ddl() {
        let d=std::env::temp_dir().join(unique_suffix("nayan-v4gate"));std::fs::create_dir_all(&d).unwrap();let p=d.join("bad.db");v3(&p);
        {let c=Connection::open(&p).unwrap();c.execute_batch("INSERT INTO suggestions(title,quote) VALUES ('读取失败',X'CAFE');").unwrap();}
        assert!(open_and_migrate(&p).is_err());let c=Connection::open(&p).unwrap();assert_eq!(user_version(&c).unwrap(),3);assert!(!column_exists(&c,"suggestions","deleted_at").unwrap());let _=std::fs::remove_dir_all(d);
    }
    fn v4(path: &Path) {
        v3(path);
        let c=Connection::open(path).unwrap();apply_v4(&c).unwrap();c.execute_batch("PRAGMA user_version=4;").unwrap();validate_current_v4(&c).unwrap();
    }
    #[test]
    fn v4_to_v5_snapshot_keeps_rows_and_adds_ai_extras() {
        let d=std::env::temp_dir().join(unique_suffix("nayan-v4v5"));std::fs::create_dir_all(&d).unwrap();let p=d.join("inbox.db");v4(&p);
        {let c=Connection::open(&p).unwrap();c.execute_batch("INSERT INTO suggestions(title,quote,deleted_at) VALUES ('留着','原文',NULL),('删过的','原文二','2030-01-01T00:00:00Z');").unwrap();}
        let before=tests::dump_all_tables(&p);
        let c=open_and_migrate(&p).unwrap();assert_eq!(user_version(&c).unwrap(),5);validate_current_v5(&c).unwrap();
        let after=tests::dump_all_tables(&p);let mut cmp=after.clone();tests::strip_added_columns(&mut cmp,&["ai_extras=Null"]);assert_eq!(cmp,before);
        let snaps=std::fs::read_dir(&d).unwrap().filter(|e|e.as_ref().unwrap().path().extension().is_some_and(|x|x=="snapshot")).count();
        assert_eq!(snaps,1,"v4 → v5 先留快照");
        let _=std::fs::remove_dir_all(d);
    }
    #[test]
    fn malformed_v5_rejected_without_persistent_change() {
        for bad in ["PRAGMA user_version=5;", "ALTER TABLE suggestions ADD COLUMN ai_extras INTEGER; PRAGMA user_version=5;"] {
            let d=std::env::temp_dir().join(unique_suffix("nayan-badv5"));std::fs::create_dir_all(&d).unwrap();let p=d.join("bad.db");v4(&p);
            {let c=Connection::open(&p).unwrap();c.execute_batch(bad).unwrap();}
            let before=std::fs::read(&p).unwrap();assert!(open_and_migrate(&p).unwrap_err().contains("user_version=5"));assert_eq!(std::fs::read(&p).unwrap(),before);
            let _=std::fs::remove_dir_all(d);
        }
    }
}
