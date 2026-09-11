#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 纳言（NaYan）· 建议收件箱桌面版 v0.1
// 菜单栏常驻 + 全局快捷键捕获（AX 直读划词，⌘C 兜底）+ 对话式捕获小窗 + 本地 SQLite + AI 拆步

mod ax_capture;
mod carbon_hotkeys;
mod clipboard_watch;
mod ocr;

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder},
    AppHandle, Emitter, LogicalPosition, Manager, State,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;

const STATUSES: [&str; 5] = ["inbox", "todo", "doing", "done", "dropped"];
const KINDS: [&str; 2] = ["suggestion", "idle"];
const SUG_COLS: &str =
    "id, title, quote, my_note, source_tool, workspace, session_ref, tags, status, kind, priority, created_at, updated_at, user_msg";

// ---------- 配置 ----------
#[derive(Deserialize, Clone, serde::Serialize)]
struct Config {
    #[serde(default = "d_provider")]
    provider: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    api_key: String,
    #[serde(default = "d_hotkey")]
    hotkey: String,
    #[serde(default = "d_hotkey_box")]
    hotkey_box: String,
    #[serde(default = "d_clip_watch")]
    clipboard_watch: bool,
    #[serde(default)]
    db_path: Option<String>,
}
fn d_provider() -> String {
    "glm".into()
}
fn d_hotkey() -> String {
    "alt+shift+s".into()
}
fn d_hotkey_box() -> String {
    "alt+shift+x".into()
}
fn d_clip_watch() -> bool {
    true
}

fn preset_for(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        "glm" => Some(("https://open.bigmodel.cn/api/paas/v4", "glm-4.6")),
        "deepseek" => Some(("https://api.deepseek.com", "deepseek-chat")),
        "openai" => Some(("https://api.openai.com/v1", "gpt-4o-mini")),
        _ => None,
    }
}

fn load_config(path: &PathBuf) -> Config {
    let mut cfg = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Config>(&s).ok())
        .unwrap_or_else(|| Config {
            provider: d_provider(),
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
            hotkey: d_hotkey(),
            hotkey_box: d_hotkey_box(),
            clipboard_watch: d_clip_watch(),
            db_path: None,
        });
    if cfg.base_url.is_empty() || cfg.model.is_empty() {
        if let Some((_, b, m)) = match cfg.provider.as_str() {
            "glm" => Some((0, "https://open.bigmodel.cn/api/paas/v4", "glm-4.6")),
            "deepseek" => Some((1, "https://api.deepseek.com", "deepseek-chat")),
            "openai" => Some((2, "https://api.openai.com/v1", "gpt-4o-mini")),
            _ => None,
        } {
            if cfg.base_url.is_empty() {
                cfg.base_url = b.to_string();
            }
            if cfg.model.is_empty() {
                cfg.model = m.to_string();
            }
        }
    }
    cfg
}

struct AppState {
    db: Mutex<Connection>,
    cfg: Mutex<(Config, PathBuf)>,
}

fn legacy_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home).join("Documents/deepseek harness/项目/记录软件");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

// ---------- 数据库 ----------
fn open_db(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(Duration::from_secs(3));
    let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS suggestions (
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
        );",
    )
    .map_err(|e| e.to_string())?;
    // 旧库补列（v0.4：user_msg=我的话；steps.result=执行结果），已存在则忽略报错
    let _ = conn.execute_batch("ALTER TABLE suggestions ADD COLUMN user_msg TEXT DEFAULT '';");
    let _ = conn.execute_batch("ALTER TABLE steps ADD COLUMN result TEXT DEFAULT '';");
    Ok(conn)
}

fn sug_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "title": r.get::<_, String>(1)?,
        "quote": r.get::<_, String>(2)?,
        "my_note": r.get::<_, String>(3)?,
        "source_tool": r.get::<_, String>(4)?,
        "workspace": r.get::<_, String>(5)?,
        "session_ref": r.get::<_, String>(6)?,
        "tags": r.get::<_, String>(7)?,
        "status": r.get::<_, String>(8)?,
        "kind": r.get::<_, String>(9)?,
        "priority": r.get::<_, i64>(10)?,
        "created_at": r.get::<_, String>(11)?,
        "updated_at": r.get::<_, String>(12)?,
        "user_msg": r.get::<_, String>(13)?,
    }))
}

fn attach_steps(conn: &Connection, rows: &mut [Value]) {
    for row in rows.iter_mut() {
        let id = row["id"].as_i64().unwrap_or(0);
        let steps: Vec<Value> = match conn.prepare(
            "SELECT id, content, is_cmd, done, ord, created_at, result FROM steps WHERE suggestion_id = ?1 ORDER BY ord, id",
        ) {
            Ok(mut stmt) => stmt
                .query_map([id], |s| {
                    Ok(json!({
                        "id": s.get::<_, i64>(0)?,
                        "content": s.get::<_, String>(1)?,
                        "is_cmd": s.get::<_, i64>(2)? != 0,
                        "done": s.get::<_, i64>(3)? != 0,
                        "ord": s.get::<_, i64>(4)?,
                        "created_at": s.get::<_, String>(5)?,
                        "result": s.get::<_, String>(6)?,
                    }))
                })
                .and_then(|m| m.collect::<Result<Vec<_>, _>>())
                .unwrap_or_default(),
            Err(_) => vec![],
        };
        row["steps"] = json!(steps);
    }
}

fn get_one(conn: &Connection, id: i64) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM suggestions WHERE id=?1", SUG_COLS))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([id], sug_from_row)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(r) => {
            let mut v = r.map_err(|e| e.to_string())?;
            attach_steps(conn, std::slice::from_mut(&mut v));
            Ok(Some(v))
        }
        None => Ok(None),
    }
}

fn replace_steps(conn: &Connection, sid: i64, items: &[(String, bool)]) -> Result<(), String> {
    conn.execute("DELETE FROM steps WHERE suggestion_id=?1", [sid])
        .map_err(|e| e.to_string())?;
    for (i, (c, cmd)) in items.iter().enumerate() {
        conn.execute(
            "INSERT INTO steps (suggestion_id, content, is_cmd, done, ord) VALUES (?1,?2,?3,0,?4)",
            rusqlite::params![sid, c, *cmd as i64, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "UPDATE suggestions SET updated_at=datetime('now','localtime') WHERE id=?1",
        [sid],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn str_field(cur: &Value, body: &Value, key: &str) -> String {
    body[key]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| cur[key].as_str().unwrap_or("").to_string())
}

// ---------- 同步 API 路由（与 server.js 保持同一套接口） ----------
fn handle_api(state: &AppState, method: &str, path: &str, body: &Value) -> Result<Value, String> {
    let (path, query) = match path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path, ""),
    };
    let segs: Vec<&str> = path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    let conn = state.db.lock().map_err(|_| "数据库被占用")?;

    match (method, segs.as_slice()) {
        ("GET", ["api", "suggestions"]) => {
            let mut wherec: Vec<String> = vec![];
            let mut params: Vec<String> = vec![];
            for pair in query.split('&').filter(|s| !s.is_empty()) {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                match k {
                    "status" => {
                        if STATUSES.contains(&v) {
                            wherec.push("status = ?".into());
                            params.push(v.to_string());
                        }
                    }
                    "tool" => {
                        wherec.push("source_tool = ?".into());
                        params.push(v.to_string());
                    }
                    "kind" => {
                        if KINDS.contains(&v) {
                            wherec.push("kind = ?".into());
                            params.push(v.to_string());
                        }
                    }
                    "q" => {
                        let like = format!("%{}%", v);
                        wherec.push("(title LIKE ? OR quote LIKE ? OR my_note LIKE ?)".into());
                        params.push(like.clone());
                        params.push(like.clone());
                        params.push(like);
                    }
                    _ => {}
                }
            }
            let mut sql = format!("SELECT {} FROM suggestions", SUG_COLS);
            if !wherec.is_empty() {
                sql += " WHERE ";
                sql += &wherec.join(" AND ");
            }
            sql += " ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'inbox' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, id DESC";
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let mut rows: Vec<Value> = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), sug_from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            attach_steps(&conn, &mut rows);
            Ok(json!(rows))
        }
        ("GET", ["api", "projects"]) => {
            let mut stmt = conn
                .prepare("SELECT workspace, COUNT(*) FROM suggestions GROUP BY workspace ORDER BY COUNT(*) DESC, workspace")
                .map_err(|e| e.to_string())?;
            let rows: Vec<Value> = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "name": r.get::<_, String>(0)?,
                        "count": r.get::<_, i64>(1)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(json!(rows))
        }
        ("POST", ["api", "suggestions"]) => {
            let title = body["title"].as_str().unwrap_or("").trim();
            if title.is_empty() {
                return Err("title 必填".into());
            }
            let kind_in = body["kind"].as_str().unwrap_or("");
            let kind = if KINDS.contains(&kind_in) { kind_in } else { "suggestion" };
            conn.execute(
                "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags, kind, user_msg) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    title,
                    body["quote"].as_str().unwrap_or(""),
                    body["my_note"].as_str().unwrap_or(""),
                    body["source_tool"].as_str().unwrap_or("other"),
                    body["workspace"].as_str().unwrap_or(""),
                    body["session_ref"].as_str().unwrap_or(""),
                    body["tags"].as_str().unwrap_or(""),
                    kind,
                    body["user_msg"].as_str().unwrap_or("")
                ],
            )
            .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            get_one(&conn, id)?.ok_or_else(|| "not found".to_string())
        }
        ("POST", ["api", "suggestions", "batch"]) => {
            let items = body["items"].as_array().ok_or("items 必须是非空数组")?;
            let mut out: Vec<Value> = vec![];
            for it in items {
                let title = it["title"].as_str().unwrap_or("").trim();
                if title.is_empty() {
                    continue;
                }
                let kind_in = it["kind"].as_str().unwrap_or("");
                let kind = if KINDS.contains(&kind_in) { kind_in } else { "suggestion" };
                conn.execute(
                    "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags, kind, user_msg) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    rusqlite::params![
                        title,
                        it["quote"].as_str().unwrap_or(""),
                        it["my_note"].as_str().unwrap_or(""),
                        it["source_tool"].as_str().unwrap_or("other"),
                        it["workspace"].as_str().unwrap_or(""),
                        it["session_ref"].as_str().unwrap_or(""),
                        it["tags"].as_str().unwrap_or(""),
                        kind,
                        it["user_msg"].as_str().unwrap_or("")
                    ],
                )
                .map_err(|e| e.to_string())?;
                let id = conn.last_insert_rowid();
                if let Some(v) = get_one(&conn, id)? {
                    out.push(v);
                }
            }
            if out.is_empty() {
                return Err("items 里没有有效的 title".into());
            }
            Ok(json!(out))
        }
        ("PATCH", ["api", "suggestions", x]) => {
            let id: i64 = x.parse().map_err(|_| "非法 id")?;
            if get_one(&conn, id)?.is_none() {
                return Err("not found".into());
            }
            if let Some(status) = body["status"].as_str() {
                if !STATUSES.contains(&status) {
                    return Err("非法 status".into());
                }
                if status == "doing" {
                    conn.execute(
                        "UPDATE suggestions SET status='todo', updated_at=datetime('now','localtime') WHERE status='doing' AND id != ?1",
                        [id],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            let cur = get_one(&conn, id)?.ok_or("not found")?;
            let priority = body["priority"].as_i64().unwrap_or(cur["priority"].as_i64().unwrap_or(2));
            conn.execute(
                "UPDATE suggestions SET title=?1, quote=?2, my_note=?3, source_tool=?4, workspace=?5, session_ref=?6, tags=?7, kind=?8, status=?9, priority=?10, user_msg=?11, updated_at=datetime('now','localtime') WHERE id=?12",
                rusqlite::params![
                    str_field(&cur, body, "title"),
                    str_field(&cur, body, "quote"),
                    str_field(&cur, body, "my_note"),
                    str_field(&cur, body, "source_tool"),
                    str_field(&cur, body, "workspace"),
                    str_field(&cur, body, "session_ref"),
                    str_field(&cur, body, "tags"),
                    str_field(&cur, body, "kind"),
                    str_field(&cur, body, "status"),
                    priority,
                    str_field(&cur, body, "user_msg"),
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
            get_one(&conn, id)?.ok_or_else(|| "not found".to_string())
        }
        ("DELETE", ["api", "suggestions", x]) => {
            let id: i64 = x.parse().map_err(|_| "非法 id")?;
            conn.execute("DELETE FROM steps WHERE suggestion_id=?1", [id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM suggestions WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        ("POST", ["api", "suggestions", x, "steps"]) => {
            let sid: i64 = x.parse().map_err(|_| "非法 id")?;
            if get_one(&conn, sid)?.is_none() {
                return Err("not found".into());
            }
            let mode = body["mode"].as_str().unwrap_or("replace");
            let mut steps: Vec<(String, bool, bool)> = vec![];
            if let Some(items) = body["steps"].as_array() {
                for s in items {
                    let content = match s {
                        Value::String(st) => st.trim().to_string(),
                        v => v["content"].as_str().unwrap_or("").trim().to_string(),
                    };
                    if content.is_empty() {
                        continue;
                    }
                    steps.push((
                        content,
                        s["is_cmd"].as_bool().unwrap_or(false),
                        s["done"].as_bool().unwrap_or(false),
                    ));
                }
            }
            if steps.is_empty() {
                return Err("steps 不能为空".into());
            }
            if mode == "append" {
                let mut stmt = conn
                    .prepare("SELECT content, is_cmd, done FROM steps WHERE suggestion_id=?1 ORDER BY ord, id")
                    .map_err(|e| e.to_string())?;
                let cur: Vec<(String, bool, bool)> = stmt
                    .query_map([sid], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)? != 0,
                            r.get::<_, i64>(2)? != 0,
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                steps = cur.into_iter().chain(steps.into_iter()).collect();
            }
            conn.execute("DELETE FROM steps WHERE suggestion_id=?1", [sid])
                .map_err(|e| e.to_string())?;
            for (i, (c, cmd, done)) in steps.iter().enumerate() {
                conn.execute(
                    "INSERT INTO steps (suggestion_id, content, is_cmd, done, ord) VALUES (?1,?2,?3,?4,?5)",
                    rusqlite::params![sid, c, *cmd as i64, *done as i64, i as i64],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute(
                "UPDATE suggestions SET updated_at=datetime('now','localtime') WHERE id=?1",
                [sid],
            )
            .map_err(|e| e.to_string())?;
            get_one(&conn, sid)?.ok_or_else(|| "not found".to_string())
        }
        ("PATCH", ["api", "steps", x]) => {
            let id: i64 = x.parse().map_err(|_| "非法 id")?;
            let cur: (String, i64, i64, String) = {
                let mut stmt = conn
                    .prepare("SELECT content, is_cmd, done, result FROM steps WHERE id=?1")
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt
                    .query_map([id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;
                match rows.next() {
                    Some(r) => r.map_err(|e| e.to_string())?,
                    None => return Err("not found".into()),
                }
            };
            let content = body["content"].as_str().map(|s| s.to_string()).unwrap_or(cur.0);
            let is_cmd = body["is_cmd"].as_bool().map(|b| b as i64).unwrap_or(cur.1);
            let done = body["done"].as_bool().map(|b| b as i64).unwrap_or(cur.2);
            let result = body["result"].as_str().map(|s| s.to_string()).unwrap_or(cur.3);
            conn.execute(
                "UPDATE steps SET content=?1, is_cmd=?2, done=?3, result=?4 WHERE id=?5",
                rusqlite::params![content, is_cmd, done, result, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({"id": id, "content": content, "is_cmd": is_cmd != 0, "done": done != 0, "result": result}))
        }
        ("DELETE", ["api", "steps", x]) => {
            let id: i64 = x.parse().map_err(|_| "非法 id")?;
            conn.execute("DELETE FROM steps WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        ("GET", ["api", "settings"]) => {
            let g = state.cfg.lock().map_err(|_| "配置被占用")?;
            Ok(json!({
                "provider": g.0.provider,
                "base_url": g.0.base_url,
                "model": g.0.model,
                "has_key": !g.0.api_key.is_empty(),
                "hotkey": g.0.hotkey,
                "hotkey_box": g.0.hotkey_box,
                "clipboard_watch": g.0.clipboard_watch
            }))
        }
        ("POST", ["api", "settings"]) => {
            let mut g = state.cfg.lock().map_err(|_| "配置被占用")?;
            let (cfg, cfg_path) = &mut *g;
            let provider_in = body["provider"].as_str().unwrap_or("custom");
            let provider = if preset_for(provider_in).is_some() {
                provider_in.to_string()
            } else {
                "custom".to_string()
            };
            cfg.provider = provider.clone();
            let preset = preset_for(&provider);
            let base = body["base_url"].as_str().map(|s| s.trim().to_string()).unwrap_or_default();
            cfg.base_url = if !base.is_empty() {
                base.trim_end_matches('/').to_string()
            } else {
                preset.map(|(b, _)| b.to_string()).unwrap_or_default()
            };
            let model = body["model"].as_str().map(|s| s.trim().to_string()).unwrap_or_default();
            cfg.model = if !model.is_empty() {
                model
            } else {
                preset.map(|(_, m)| m.to_string()).unwrap_or_default()
            };
            match body.get("api_key") {
                Some(Value::Null) => cfg.api_key = String::new(),
                Some(Value::String(s)) if !s.trim().is_empty() => cfg.api_key = s.trim().to_string(),
                _ => {}
            }
            if let Some(v) = body.get("clipboard_watch") {
                let on = v.as_bool().unwrap_or(true);
                cfg.clipboard_watch = on;
                clipboard_watch::CLIP_WATCH_ON.store(on, std::sync::atomic::Ordering::Relaxed);
                log_line(&format!("[设置] 剪贴板监听 = {}", on));
            }
            let _ = fs::write(cfg_path, serde_json::to_string_pretty(cfg).unwrap_or_default());
            Ok(json!({
                "ok": true,
                "provider": cfg.provider,
                "base_url": cfg.base_url,
                "model": cfg.model,
                "has_key": !cfg.api_key.is_empty(),
                "clipboard_watch": cfg.clipboard_watch
            }))
        }
        _ => Err("not found".into()),
    }
}

// ---------- AI 拆步 ----------
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| reqwest::Client::new())
}

async fn ai_chat(cfg: &Config, messages: &[(&str, String)]) -> Result<String, String> {
    let base = cfg.base_url.trim_end_matches('/').to_string();
    if cfg.api_key.is_empty() || base.is_empty() {
        return Err("请先在侧栏 ⚙️ AI 拆步设置里配置 API Key".into());
    }
    let msgs: Vec<Value> = messages
        .iter()
        .map(|(r, c)| json!({"role": r, "content": c}))
        .collect();
    let resp = http()
        .post(format!("{}/chat/completions", base))
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .json(&json!({"model": cfg.model, "messages": msgs, "temperature": 0.2}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let m = v["error"]["message"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("HTTP {}", status));
        return Err(m);
    }
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("AI 返回为空")?;
    Ok(content.to_string())
}

fn parse_step_json(text: &str) -> Vec<(String, bool)> {
    let t = text.trim();
    let t = t.trim_start_matches("```json").trim_start_matches("```").trim();
    let start = match t.find('[') {
        Some(i) => i,
        None => return vec![],
    };
    let end = match t.rfind(']') {
        Some(i) => i,
        None => return vec![],
    };
    if end <= start {
        return vec![];
    }
    let arr: Value = match serde_json::from_str(&t[start..=end]) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let mut out: Vec<(String, bool)> = vec![];
    if let Some(list) = arr.as_array() {
        for s in list {
            let (content, is_cmd) = match s {
                Value::String(st) => (st.trim().to_string(), false),
                v => (
                    v["content"]
                        .as_str()
                        .or(v["step"].as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string(),
                    v["is_cmd"].as_bool().or(v["isCmd"].as_bool()).unwrap_or(false),
                ),
            };
            if !content.is_empty() {
                out.push((content, is_cmd));
            }
        }
    }
    out
}

// ---------- Tauri 命令 ----------
#[tauri::command]
async fn api(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let p = path.split('?').next().unwrap_or("").trim_matches('/').to_string();
    let segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();

    // 异步路由：AI 相关（要发 HTTP 请求）
    if method == "POST" && segs.len() == 3 && segs[0] == "api" && segs[1] == "settings" && segs[2] == "test" {
        let cfg = {
            let g = state.cfg.lock().map_err(|_| "配置被占用")?;
            g.0.clone()
        };
        let reply = ai_chat(&cfg, &[("user", "只回复两个字：正常".to_string())]).await?;
        return Ok(json!({"ok": true, "reply": reply.chars().take(40).collect::<String>()}));
    }
    if method == "POST" && segs.len() == 4 && segs[0] == "api" && segs[1] == "ai" && segs[2] == "split" {
        let id: i64 = segs[3].parse().map_err(|_| "非法 id")?;
        let (card, cfg) = {
            let conn = state.db.lock().map_err(|_| "数据库被占用")?;
            let card = get_one(&conn, id)?.ok_or("not found")?;
            let g = state.cfg.lock().map_err(|_| "配置被占用")?;
            (card, g.0.clone())
        };
        let title = card["title"].as_str().unwrap_or("").to_string();
        let quote = card["quote"].as_str().unwrap_or("").to_string();
        let content = if quote.is_empty() { title.clone() } else { quote };
        let sys = "你是任务拆解助手。把用户给出的内容（一段 AI 建议、操作指引或含命令的终端输出）整理成有序执行步骤。\
                   只输出 JSON 数组，形如 [{\"content\":\"步骤描述\",\"is_cmd\":true}]，is_cmd=true 表示该步骤是一条可直接复制到终端执行的命令。\
                   最多 12 步；命令必须保持原文原样，不要改写；合并重复内容；不要输出数组以外的任何文字。"
            .to_string();
        let reply = ai_chat(
            &cfg,
            &[("system", sys), ("user", format!("标题：{}\n\n内容：\n{}", title, content))],
        )
        .await?;
        let steps = parse_step_json(&reply);
        if steps.is_empty() {
            return Err(format!(
                "AI 没有返回有效步骤，原文开头：{}",
                reply.chars().take(80).collect::<String>()
            ));
        }
        {
            let conn = state.db.lock().map_err(|_| "数据库被占用")?;
            replace_steps(&conn, id, &steps)?;
        }
        let conn = state.db.lock().map_err(|_| "数据库被占用")?;
        return get_one(&conn, id)?.ok_or_else(|| "not found".to_string());
    }

    // 同步路由
    handle_api(&state, &method, &path, &body)
}

#[tauri::command]
fn close_capture(app: AppHandle) {
    // 隐藏而非销毁：销毁后第二次 ⌥S 会"capture 窗口未初始化"
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn clip_save(app: AppHandle, state: State<'_, AppState>, text: String) {
    let clean = text.trim().to_string();
    if clean.is_empty() {
        return;
    }
    let title: String = clean.lines().next().unwrap_or("").trim().chars().take(60).collect();
    let title = if title.is_empty() { "剪贴板内容".to_string() } else { title };
    let conn = state.db.lock().unwrap();
    let ins = conn.execute(
        "INSERT INTO suggestions (title, quote, my_note, source_tool, workspace, session_ref, tags, kind, user_msg) VALUES (?1,?2,'','clipboard','','剪贴板','','suggestion','')",
        rusqlite::params![title, clean],
    );
    let id = conn.last_insert_rowid();
    drop(conn);
    match ins {
        Ok(_) => {
            log_line(&format!("[剪贴板] 直接入箱 #{}：{}", id, title));
            clipboard_watch::hide_hud(&app);
            notify(&app, "✓ 已收进收件箱", &format!("#{} {}", id, title));
        }
        Err(e) => notify(&app, "入箱失败", &e.to_string()),
    }
}

#[tauri::command]
fn clip_edit(app: AppHandle, text: String) {
    clipboard_watch::hide_hud(&app);
    let _ = open_capture_window(&app, &text, "剪贴板", "", "剪贴板", "clip");
}

#[tauri::command]
fn clip_dismiss(app: AppHandle) {
    clipboard_watch::hide_hud(&app);
}

#[tauri::command]
fn open_ax_settings() {
    ax_capture::open_ax_settings();
}

// ---------- 框选捕获（第 2 步） ----------
// overlay 打开时 NaYan 会成为前台 App，所以目标 App 的信息必须在 start 时存下
static BOX_FRONT: Mutex<Option<(i32, String, String)>> = Mutex::new(None);

#[tauri::command]
fn box_select_start(app: AppHandle) {
    log_line("框选捕获开始");
    // 幂等：overlay 已开着就忽略
    if app.get_webview_window("boxselect").is_some() {
        return;
    }
    // 目标信息先抓（overlay 一旦激活，前台就是纳言自己了）
    let front = ax_capture::front_app_info();
    let (pid, name, title) = match &front {
        Some(f) => (f.pid, f.name.clone(), f.title.clone()),
        None => {
            notify(&app, "框选失败", "拿不到前台应用");
            return;
        }
    };
    {
        let mut g = BOX_FRONT.lock().unwrap();
        *g = Some((pid, name.clone(), title.clone()));
    }

    // 光标所在的屏（多屏 v1：框哪块屏由鼠标位置决定）
    let cursor = app.cursor_position().ok();
    let monitors = match app.available_monitors() {
        Ok(m) => m,
        Err(e) => {
            notify(&app, "框选失败", &e.to_string());
            return;
        }
    };
    let mon = monitors
        .iter()
        .find(|m| {
            cursor
                .map(|c| {
                    c.x >= m.position().x as f64
                        && c.x < (m.position().x as f64 + m.size().width as f64)
                        && c.y >= m.position().y as f64
                        && c.y < (m.position().y as f64 + m.size().height as f64)
                })
                .unwrap_or(false)
        })
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let mon = match mon {
        Some(m) => m,
        None => {
            notify(&app, "框选失败", "找不到可用显示器");
            return;
        }
    };
    let scale = mon.scale_factor();
    // AX 坐标是"点"，窗口逻辑坐标也是"点"，物理像素 = 点 × scale
    let ox = mon.position().x as f64 / scale;
    let oy = mon.position().y as f64 / scale;
    let sw = mon.size().width as f64 / scale;
    let sh = mon.size().height as f64 / scale;

    let win = tauri::webview::WebviewWindowBuilder::new(
        &app,
        "boxselect",
        tauri::WebviewUrl::App("boxselect.html".into()),
    )
    .title("框选捕获")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    .focused(true)
    .position(ox, oy)
    .inner_size(sw, sh)
    .build();
    let win = match win {
        Ok(w) => w,
        Err(e) => {
            notify(&app, "框选窗口创建失败", &e.to_string());
            return;
        }
    };
    let _ = win.show();
    let _ = win.set_focus();
    // 提到菜单栏之上（kCGScreenSaverWindowLevel），整屏进入框选态
    if let Ok(ns) = win.ns_window() {
        let ns_addr = ns as usize; // 裸指针不 Send，转地址跨线程
        app.run_on_main_thread(move || unsafe {
            use cocoa::base::id;
            use objc::{msg_send, sel, sel_impl};
            let nsw: id = ns_addr as *mut std::os::raw::c_void as id;
            let _: () = msg_send![nsw, setLevel: 1000_i64];
        })
        .ok();
    }

    // 后台 AX 走查（大页面 1~3s；期间 overlay 显示"正在读取"）
    let h = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let blocks = ax_capture::harvest_text_blocks(pid);
        let local: Vec<ax_capture::TextBlock> = blocks
            .into_iter()
            .map(|mut b| {
                b.x -= ox;
                b.y -= oy;
                b
            })
            .collect();
        log_line(&format!(
            "[框选] AX 就绪：{} 块，{}ms，目标={}（{}）",
            local.len(),
            t0.elapsed().as_millis(),
            name,
            title
        ));
        // 直接注入页面（emit_to 事件在本机 webview 上不可靠，会整包丢失）
        let payload = json!({
            "blocks": local, "count": local.len(),
            "ox": ox, "oy": oy
        })
        .to_string();
        if let Some(w) = h.get_webview_window("boxselect") {
            let _ = w.eval(&format!(
                "window.__setCandidates && window.__setCandidates({});",
                payload
            ));
        } else {
            log_line("[框选] overlay 窗口已不在，丢弃候选");
        }
    });
}

#[tauri::command]
async fn box_select_finish(app: AppHandle, blocks: Vec<Value>, rect: Option<Value>) {
    let ocr_mode = blocks.is_empty() && rect.is_some();
    log_line(&format!(
        "[框选] finish：收到 {} 块，模式={}",
        blocks.len(),
        if ocr_mode { "像素识别" } else { "AX" }
    ));

    // 像素识别模式：先隐藏 overlay（避免截到自己的暗化层），取窗口号用于截图排除
    let mut exclude_win: u32 = 0;
    if ocr_mode {
        if let Some(w) = app.get_webview_window("boxselect") {
            if let Ok(ns) = w.ns_window() {
                unsafe {
                    use objc::{msg_send, sel, sel_impl};
                    let n: i64 = msg_send![ns as *mut objc::runtime::Object, windowNumber];
                    exclude_win = n.max(0) as u32;
                }
            }
            let _ = w.hide(); // 等合成器收掉再截图
        }
    } else if let Some(w) = app.get_webview_window("boxselect") {
        let _ = w.close();
    }

    let front = BOX_FRONT.lock().unwrap().take();
    let (name, title) = match &front {
        Some((_, n, t)) => (n.clone(), t.clone()),
        None => ("hotkey".into(), String::new()),
    };

    // 重活全部放后台线程（绝不卡主线程）
    let rect_bg = rect.clone();
    let title_bg = title.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        if ocr_mode {
            let r = rect_bg.as_ref().and_then(|r| {
                Some((
                    r["x"].as_f64()?,
                    r["y"].as_f64()?,
                    r["w"].as_f64()?,
                    r["h"].as_f64()?,
                ))
            });
            let Some((rx, ry, rw, rh)) = r else {
                return Err("像素识别缺少框选区域".to_string());
            };
            if rw < 14.0 || rh < 10.0 {
                return Err("拖动范围太小".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(280)); // 等 overlay 淡出
            let text = ocr::ocr_region(rx, ry, rw, rh, exclude_win)?;
            let ws = ax_capture::resolve_workspace(&title_bg);
            return Ok((text, ws));
        }
        let parsed: Vec<ax_capture::TextBlock> = blocks
            .iter()
            .filter_map(|b| {
                Some(ax_capture::TextBlock {
                    x: b["x"].as_f64()?,
                    y: b["y"].as_f64()?,
                    w: b["w"].as_f64()?,
                    h: b["h"].as_f64()?,
                    text: b["text"].as_str()?.to_string(),
                })
            })
            .collect();
        let text = ax_capture::compose_text(parsed);
        let ws = ax_capture::resolve_workspace(&title_bg);
        Ok((text, ws))
    })
    .await;
    let (text, ws) = match joined {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            log_line(&format!("[框选] 失败：{}", e));
            notify(&app, "框选失败", &e);
            if let Some(w) = app.get_webview_window("boxselect") {
                let _ = w.close();
            }
            return;
        }
        Err(e) => {
            log_line(&format!("[框选] 后台任务失败：{}", e));
            notify(&app, "框选处理失败", &e.to_string());
            return;
        }
    };
    // OCR 模式下 overlay 只是隐藏，处理完彻底关闭
    if let Some(w) = app.get_webview_window("boxselect") {
        let _ = w.close();
    }
    if text.trim().is_empty() {
        log_line("[框选] 重组后无文字");
        notify(&app, "这块没框到文字", "试着从正文段落上拖过");
        return;
    }
    let sr = if title.is_empty() {
        String::new()
    } else {
        format!("窗口：{}", title)
    };
    log_line(&format!("[框选] 入小窗：{} 字", text.chars().count()));
    if let Err(e) = open_capture_window(&app, &text, &name, &ws, &sr, "box") {
        log_line(&format!("[框选] 捕获小窗打开失败：{}", e));
        notify(&app, "捕获小窗打开失败", &e);
    }
}

#[tauri::command]
fn box_select_cancel(app: AppHandle) {
    BOX_FRONT.lock().unwrap().take();
    if let Some(w) = app.get_webview_window("boxselect") {
        let _ = w.close();
    }
}

// ---------- 原生捕获 ----------
fn front_app_name() -> String {
    let asn = Command::new("lsappinfo")
        .arg("front")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if asn.is_empty() {
        return "hotkey".into();
    }
    let out = Command::new("lsappinfo")
        .args(["info", "-only", "name", &asn])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    if let Some(i) = out.find("\"=\"") {
        let name = out[i + 3..].trim().trim_matches('"').to_string();
        if !name.is_empty() {
            return name;
        }
    }
    "hotkey".into()
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------- 捕获日志（文件） ----------
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn log_line(msg: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(f, "[{}] {}", chrono_now(), msg);
    }
    println!("{}", msg);
}

fn chrono_now() -> String {
    // 免依赖：用 date 命令取本地时间（每次捕获才写一行，开销可忽略）
    Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn open_capture_window(
    app: &AppHandle,
    text: &str,
    app_name: &str,
    ws: &str,
    sr: &str,
    channel: &str,
) -> Result<(), String> {
    let win = app
        .get_webview_window("capture")
        .ok_or("capture 窗口未初始化")?;
    let (x, y) = {
        let mon = app
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("没有主显示器")?;
        let scale = mon.scale_factor();
        let logical = mon.size().to_logical::<f64>(scale);
        ((logical.width - 428.0).max(0.0), (logical.height - 440.0).max(0.0))
    };
    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    // 直接往页面注入数据（不用事件：小窗加载早期 emit 会被竞态吞掉，曾导致小窗空白）
    let payload = json!({"text": text, "app": app_name, "ws": ws, "sr": sr, "channel": channel}).to_string();
    win.eval(&format!("window.applyCapture && window.applyCapture({});", payload))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    // 关键：macOS 不允许后台 App 默认抢键盘焦点，必须主动激活自己（忽略其他 App）
    let h = app.clone();
    app.run_on_main_thread(move || {
        activate_app();
        if let Some(w) = h.get_webview_window("capture") {
            let _ = w.set_focus();
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn activate_app() {
    use cocoa::appkit::NSApplication;
    use cocoa::base::{nil, YES};
    use objc::{msg_send, sel, sel_impl};
    unsafe {
        let ns = NSApplication::sharedApplication(nil);
        let _: () = msg_send![ns, activateIgnoringOtherApps: YES];
    }
}

#[cfg(not(target_os = "macos"))]
fn activate_app() {}

/// 捕获来源（三级降级链的产出）
struct CaptureSource {
    text: String,
    app_name: String,
    ws: String,
    sr: String,
    channel: &'static str,
}

/// 阻塞式采集：AX 直读 → ⌘C 兜底（恢复剪贴板）。放在 spawn_blocking 里跑。
fn gather_capture() -> Result<CaptureSource, String> {
    let (pid, app_name, title) = match ax_capture::front_app_info() {
        Some(f) => (
            Some(f.pid),
            if f.name.trim().is_empty() {
                front_app_name()
            } else {
                f.name.clone()
            },
            f.title,
        ),
        None => (None, front_app_name(), String::new()),
    };

    // 通道 1：AX 直读选中文字（干净、快、不污染剪贴板）
    if let Some(pid) = pid {
        if ax_capture::ax_trusted() {
            match ax_capture::read_selected_text(pid) {
                Ok(t) if !t.trim().is_empty() => {
                    log_line(&format!("[划词] AX 命中 {} 字符", t.chars().count()));
                    return Ok(build_source(t, app_name, title, "ax"));
                }
                Ok(_) => log_line("[划词] AX 可用但无选区 → ⌘C 兜底"),
                Err(e) => log_line(&format!("[划词] AX 通道失败：{} → ⌘C 兜底", e)),
            }
        } else {
            log_line("[划词] 辅助功能未授权 → ⌘C 兜底");
        }
    }

    // 通道 2：模拟 ⌘C + 剪贴板（读完恢复原内容）
    match ax_capture::simulate_copy_text() {
        Ok(t) => {
            log_line(&format!("[划词] ⌘C 兜底拿到 {} 字符", t.chars().count()));
            Ok(build_source(t, app_name, title, "cmdc"))
        }
        Err(e) => {
            log_line(&format!("[划词] ⌘C 兜底也失败：{}", e));
            Err(e)
        }
    }
}

fn build_source(text: String, app_name: String, title: String, channel: &'static str) -> CaptureSource {
    let ws = ax_capture::resolve_workspace(&title);
    let sr = if title.is_empty() {
        String::new()
    } else {
        format!("窗口：{}", title)
    };
    log_line(&format!(
        "[捕获] 通道={} app={} 字符={} ws={}",
        channel,
        app_name,
        text.chars().count(),
        if ws.is_empty() { "无" } else { &ws }
    ));
    CaptureSource {
        text,
        app_name,
        ws,
        sr,
        channel,
    }
}

fn start_capture(app: AppHandle) {
    log_line("划词捕获开始");
    tauri::async_runtime::spawn(async move {
        let joined = tauri::async_runtime::spawn_blocking(gather_capture);
        match joined.await {
            Ok(Ok(src)) => {
                if let Err(e) =
                    open_capture_window(&app, &src.text, &src.app_name, &src.ws, &src.sr, &src.channel)
                {
                    log_line(&format!("[划词] 捕获小窗打开失败：{}", e));
                    notify(&app, "捕获小窗打开失败", &e);
                }
            }
            Ok(Err(e)) => {
                log_line(&format!("[划词] 采集失败：{}", e));
                notify(
                    &app,
                    "没抓到文字",
                    &format!("{}（先选中文字再按快捷键；AX 划词需要辅助功能授权）", e),
                );
            }
            Err(e) => notify(&app, "捕获任务失败", &e.to_string()),
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let _ = fs::create_dir_all(&app_data);
            let _ = LOG_PATH.set(app_data.join("nayan.log"));
            let cfg_path = app_data.join("config.json");
            let cfg = load_config(&cfg_path);
            log_line(&format!("纳言启动，热键 {} / {}", cfg.hotkey, cfg.hotkey_box));
            // 主库固定放 App 自己的数据目录（本地、不依赖同步盘）；旧项目库由后台线程迁移，绝不阻塞启动
            let db_path = cfg
                .db_path
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| app_data.join("inbox.db"));
            let conn = open_db(&db_path)?;
            println!("纳言数据库：{}", db_path.display());
            app.manage(AppState {
                db: Mutex::new(conn),
                cfg: Mutex::new((cfg.clone(), cfg_path)),
            });

            // 后台迁移旧版数据（项目 data/inbox.db）→ App 主库（只在主库为空时执行）
            {
                let db_for_import = db_path.clone();
                std::thread::spawn(move || {
                    let legacy = match legacy_dir().map(|d| d.join("data/inbox.db")) {
                        Some(p) if p.exists() => p,
                        _ => return,
                    };
                    let conn = match open_db(&db_for_import) {
                        Ok(c) => c,
                        Err(e) => {
                            println!("迁移失败（打不开主库）：{}", e);
                            return;
                        }
                    };
                    let n: i64 = conn
                        .query_row("SELECT COUNT(*) FROM suggestions", [], |r| r.get(0))
                        .unwrap_or(1);
                    if n > 0 {
                        println!("主库已有 {} 条数据，跳过迁移", n);
                        return;
                    }
                    let legacy_sql = legacy.display().to_string().replace('\'', "''");
                    let before: i64 = conn
                        .query_row("PRAGMA total_changes", [], |r| r.get(0))
                        .unwrap_or(0);
                    let result = conn.execute_batch(&format!(
                        "ATTACH DATABASE '{p}' AS legacy; \
                         INSERT OR IGNORE INTO main.suggestions (id,title,quote,my_note,source_tool,workspace,session_ref,tags,status,kind,priority,created_at,updated_at) \
                         SELECT id,title,quote,my_note,source_tool,workspace,session_ref,tags,status,kind,priority,created_at,updated_at FROM legacy.suggestions; \
                         INSERT OR IGNORE INTO main.steps (id,suggestion_id,content,is_cmd,done,ord,created_at) \
                         SELECT id,suggestion_id,content,is_cmd,done,ord,created_at FROM legacy.steps; \
                         DETACH DATABASE legacy;",
                        p = legacy_sql
                    ));
                    match result {
                        Ok(_) => {
                            let after: i64 = conn
                                .query_row("PRAGMA total_changes", [], |r| r.get(0))
                                .unwrap_or(0);
                            println!("已从旧库导入 {} 行（{}）", after - before, legacy.display());
                        }
                        Err(e) => println!("迁移失败：{}（{}）", e, legacy.display()),
                    }
                });
            }

            // 全局快捷键：HID 层 CGEventTap（Carbon 注册在本机会被遗留僵尸记录拦截；
            // HID 层在键盘信号第一站，物理上无法被截胡）。失败时提示授权，不阻塞启动。
            let app_handle = app.handle().clone();
            if let Err(e) = carbon_hotkeys::install(
                app_handle.clone(),
                vec![
                    (cfg.hotkey.clone(), 1),
                    (cfg.hotkey_box.clone(), 2),
                ],
            ) {
                log_line(&format!("热键安装失败：{}", e));
                notify(&app_handle, "纳言热键安装失败", &e);
            }

            // 托盘
            let open = MenuItem::with_id(app, "open", "打开收件箱", true, None::<&str>)?;
            let capture = MenuItem::with_id(app, "capture", "立即捕获", true, None::<&str>)?;
            let autostart_enabled = {
                use tauri_plugin_autostart::ManagerExt;
                app.autolaunch().is_enabled().unwrap_or(false)
            };
            let autostart =
                CheckMenuItem::with_id(app, "autostart", "开机自启", true, autostart_enabled, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出纳言", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &capture, &autostart, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("纳言 · 建议收件箱")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "capture" => start_capture(app.app_handle().clone()),
                    "autostart" => {
                        use tauri_plugin_autostart::ManagerExt;
                        let al = app.autolaunch();
                        if al.is_enabled().unwrap_or(false) {
                            let _ = al.disable();
                        } else {
                            let _ = al.enable();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 双保险：确保主窗口显示
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }

            // 第 0 步：辅助功能授权引导（AX 直读与 ⌘C 模拟都依赖它；未授权时捕获必然失败）
            if !ax_capture::ax_trusted() {
                notify(
                    app.app_handle(),
                    "纳言需要辅助功能权限",
                    "系统设置 → 隐私与安全性 → 辅助功能 → 勾选纳言，然后重试 ⌥⇧S",
                );
            }

            // 第 3 步：剪贴板被动通道（2s 轮询 changeCount，检测到新复制弹快速收录 HUD）
            clipboard_watch::CLIP_WATCH_ON.store(cfg.clipboard_watch, std::sync::atomic::Ordering::Relaxed);
            clipboard_watch::start(app.handle().clone());
            log_line(&format!(
                "[剪贴板] 监听已启动（{}）",
                if cfg.clipboard_watch { "开" } else { "关" }
            ));
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口点关闭 = 隐藏到菜单栏；捕获小窗正常关闭
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // 菜单栏 App 默认拿不到"激活"状态，红绿灯会一直是失活灰色；
            // 主窗口拿到焦点时主动激活，让红黄绿灯恢复原色
            if let tauri::WindowEvent::Focused(true) = event {
                if window.label() == "main" {
                    activate_app();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            api,
            close_capture,
            open_ax_settings,
            box_select_start,
            box_select_finish,
            box_select_cancel,
            clip_save,
            clip_edit,
            clip_dismiss
        ])
        .run(tauri::generate_context!())
        .expect("纳言启动失败");
}
