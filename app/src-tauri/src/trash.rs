//! 最近删除：逐条永久清理共用同一个事务路径。普通附件仅移除引用。
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub fn purge(conn: &mut Connection, cap_dir: &Path, id: i64) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n: i64 = tx.query_row("SELECT COUNT(*) FROM suggestions WHERE id=?1 AND deleted_at IS NOT NULL", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if n == 0 { return Err("条目不在最近删除中".into()); }
    let images: Vec<PathBuf> = {
        let mut stmt = tx.prepare("SELECT path FROM attachments WHERE suggestion_id=?1 AND name='选区原图.png'").map_err(|e| e.to_string())?;
        let paths = stmt.query_map([id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            .into_iter().map(PathBuf::from).filter(|p| p.parent() == Some(cap_dir)).collect();
        paths
    };
    for table in ["steps", "attachments", "compare_points"] {
        tx.execute(&format!("DELETE FROM {} WHERE suggestion_id=?1", table), [id]).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM suggestions WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    // 有其他条目引用的原图不能删；共享路径只在最后一个引用消失时清理。
    let mut unreferenced = vec![];
    for p in images {
        let refs: i64 = tx.query_row("SELECT COUNT(*) FROM attachments WHERE path=?1", [p.to_string_lossy()], |r| r.get(0)).map_err(|e| e.to_string())?;
        if refs == 0 { unreferenced.push(p); }
    }
    tx.commit().map_err(|e| e.to_string())?;
    let mut removed = 0;
    // captures/ 本身不能是符号链接；不沿链接删除目录外的原文件。
    let owned_dir = std::fs::symlink_metadata(cap_dir).map(|m| m.is_dir() && !m.file_type().is_symlink()).unwrap_or(false);
    if owned_dir {
        for p in unreferenced {
            match std::fs::symlink_metadata(&p) {
                Ok(m) if m.is_file() && !m.file_type().is_symlink() => match std::fs::remove_file(&p) {
                    Ok(()) => removed += 1,
                    Err(e) => crate::log_line(&format!("[最近删除] #{} 已清理，原图清理失败：{}（{}）", id, e, p.display())),
                },
                _ => {}
            }
        }
    }
    crate::log_line(&format!("[最近删除] 彻底删除 #{}，清理 {} 张自有原图", id, removed));
    Ok(removed)
}

pub fn empty(conn: &mut Connection, cap_dir: &Path) -> Result<usize, String> {
    let ids = collect_ids(conn, "SELECT id FROM suggestions WHERE deleted_at IS NOT NULL ORDER BY id", None)?;
    purge_ids(conn, cap_dir, ids)
}

/// now 接受 SQLite 日期或 "now"，生产用 UTC；测试注入固定时刻。满 30 天边界仍可恢复。
pub fn purge_expired(conn: &mut Connection, cap_dir: &Path, now: &str) -> Result<usize, String> {
    let ids = collect_ids(conn, "SELECT id FROM suggestions WHERE deleted_at IS NOT NULL AND datetime(deleted_at) < datetime(?1, '-30 days') ORDER BY id", Some(now))?;
    let n = purge_ids(conn, cap_dir, ids)?;
    crate::log_line(&format!("[最近删除] 30 天自动清理：{} 条", n));
    Ok(n)
}

fn collect_ids(conn: &Connection, sql: &str, now: Option<&str>) -> Result<Vec<i64>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params_from_iter(now), |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn purge_ids(conn: &mut Connection, cap_dir: &Path, ids: Vec<i64>) -> Result<usize, String> {
    let mut count = 0;
    for id in ids {
        purge(conn, cap_dir, id).map_err(|e| format!("已清理 {} 条；#{} 清理失败：{}", count, id, e))?;
        count += 1;
    }
    Ok(count)
}
