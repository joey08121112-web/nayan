//! 桌面端内置浏览器扩展与快捷指令 HTTP 接收服务（127.0.0.1:8787）
//!
//! 让用户无需手动在终端运行 `node sync-server.js`，打开纳言桌面端即可直接接收
//! Chrome 浏览器扩展（`extension/`）与 macOS 快捷指令写入的建议，并在入库后实时刷新主界面。
//!
//! 安全边界：
//! 1. 仅绑定本机回环地址 `127.0.0.1:8787`，绝不暴露局域网。
//! 2. 严格校验 `Origin` 请求头：仅放行浏览器扩展来源（`chrome-extension://`、`moz-extension://`、
//!    `safari-web-extension://`）或无 `Origin` 的本机工具（快捷指令、`curl`、MV3 Service Worker）；
//!    任何来自普通网页（`http://` / `https://`）的跨站请求一律以 `403 Forbidden` 拒绝。
//! 3. 可在「设置 › 捕获」中随时一键关闭（`EXT_SERVER_ON`）。

use crate::content::{
    AcquisitionKind, CapturedContent, DeclaredFormat, FormatProvenance, Original, SCHEMA_VERSION,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const EXT_PORT: u16 = 8787;
pub static EXT_SERVER_ON: AtomicBool = AtomicBool::new(true);

const WRITABLE: [&str; 8] = [
    "title",
    "quote",
    "my_note",
    "source_tool",
    "workspace",
    "session_ref",
    "tags",
    "user_msg",
];

/// 判断请求 Origin 是否允许访问本机 8787 扩展接口：
/// - 无 Origin（本机快捷指令 / curl / 拥有 host_permissions 的 MV3 后台）→ 允许
/// - 浏览器扩展 Origin（chrome-extension:// 等）→ 允许
/// - 普通网页 Origin（http:// 或 https://）→ 拒绝，防本机端口跨站伪造写入（CSRF）
pub fn is_allowed_origin(origin: Option<&str>) -> bool {
    match origin.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some(o) => {
            o.starts_with("chrome-extension://")
                || o.starts_with("moz-extension://")
                || o.starts_with("safari-web-extension://")
        }
    }
}

fn is_extension_origin(origin: Option<&str>) -> bool {
    matches!(
        origin.map(str::trim),
        Some(o)
            if o.starts_with("chrome-extension://")
                || o.starts_with("moz-extension://")
                || o.starts_with("safari-web-extension://")
    )
}

/// 将扩展客户端传来的最小 `content` 声明构造为权威 `CapturedContent` 信封（与 `schema-gate.mjs` 同口径）
pub fn build_ext_envelope(input: &Value) -> Result<(CapturedContent, usize), (u16, String)> {
    let obj = input
        .as_object()
        .ok_or_else(|| (400, "content 信封非法（零写入）：content 必须是对象".into()))?;
    let allowed = [
        "schema_version",
        "request_id",
        "format",
        "format_provenance",
        "acquisition",
        "original",
        "fidelity",
    ];
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err((
                400,
                format!(
                    "content 信封非法（零写入）：content 含未知字段 {}（允许：{}）",
                    k,
                    allowed.join("/")
                ),
            ));
        }
    }
    let sv = match obj.get("schema_version") {
        None => SCHEMA_VERSION,
        Some(v) => v
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0),
    };
    if sv != SCHEMA_VERSION {
        return Err((
            400,
            format!(
                "content 信封非法（零写入）：未知 schema_version {}（支持 {}）",
                sv, SCHEMA_VERSION
            ),
        ));
    }
    let request_id = obj
        .get("request_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if request_id.trim().is_empty() {
        return Err((400, "content 信封非法（零写入）：request_id 不能为空".into()));
    }
    let format: DeclaredFormat = obj
        .get("format")
        .cloned()
        .ok_or_else(|| (400, "content 信封非法（零写入）：缺少 format".into()))
        .and_then(|v| {
            serde_json::from_value(v)
                .map_err(|_| (400, "content 信封非法（零写入）：未知 format".into()))
        })?;
    let provenance: FormatProvenance = match obj.get("format_provenance") {
        None => FormatProvenance::Declared,
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|_| (400, "content 信封非法（零写入）：未知 format_provenance".into()))?,
    };
    let acquisition: AcquisitionKind = match obj.get("acquisition") {
        None => AcquisitionKind::ExtensionDom,
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|_| (400, "content 信封非法（零写入）：未知 acquisition".into()))?,
    };
    let mut truncated = false;
    if let Some(fid) = obj.get("fidelity") {
        let fobj = fid
            .as_object()
            .ok_or_else(|| (400, "content 信封非法（零写入）：fidelity 仅允许 { truncated: boolean }".into()))?;
        if fobj.keys().any(|k| k != "truncated") {
            return Err((
                400,
                "content 信封非法（零写入）：fidelity 仅允许 { truncated: boolean }".into(),
            ));
        }
        if let Some(t) = fobj.get("truncated") {
            truncated = t
                .as_bool()
                .ok_or_else(|| (400, "content 信封非法（零写入）：fidelity.truncated 必须是布尔值".into()))?;
        }
    }
    let orig_val = obj
        .get("original")
        .ok_or_else(|| (400, "content 信封非法（零写入）：original 必填且必须是对象".into()))?;
    let orig_obj = orig_val
        .as_object()
        .ok_or_else(|| (400, "content 信封非法（零写入）：original 必填且必须是对象".into()))?;
    let kind = orig_obj
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let original = match kind {
        "text" => {
            if orig_obj.keys().any(|k| k != "kind" && k != "text") {
                return Err((
                    400,
                    "content 信封非法（零写入）：original(kind=text) 仅允许 kind/text 字段".into(),
                ));
            }
            let text = orig_obj
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or_else(|| (400, "content 信封非法（零写入）：original.text 必须是字符串".into()))?;
            Original::Text {
                text: text.to_string(),
            }
        }
        "bytes" => {
            if orig_obj
                .keys()
                .any(|k| k != "kind" && k != "bytes" && k != "charset_hint")
            {
                return Err((
                    400,
                    "content 信封非法（零写入）：original(kind=bytes) 仅允许 kind/bytes/charset_hint 字段".into(),
                ));
            }
            let arr = orig_obj
                .get("bytes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| (400, "content 信封非法（零写入）：original.bytes 必须是字节数组".into()))?;
            let mut bytes = Vec::with_capacity(arr.len());
            for item in arr {
                let b = item
                    .as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or_else(|| (400, "content 信封非法（零写入）：original.bytes 元素必须是 0..255 整数".into()))?;
                bytes.push(b);
            }
            let charset_hint = match orig_obj.get("charset_hint") {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    v.as_str()
                        .ok_or_else(|| (400, "content 信封非法（零写入）：charset_hint 必须是字符串或 null".into()))?
                        .to_string(),
                ),
            };
            Original::Bytes {
                bytes,
                charset_hint,
            }
        }
        _ => {
            return Err((
                400,
                format!("content 信封非法（零写入）：未知 original.kind {:?}", kind),
            ))
        }
    };
    let env = CapturedContent::new(request_id, format, provenance, acquisition, original, truncated)
        .map_err(|e| (400, format!("content 信封非法（零写入）：{}", e)))?;
    let size = crate::content_size(&env);
    if size > crate::MAX_CONTENT_CHARS {
        let is_text = matches!(env.original(), Original::Text { .. });
        let unit = if is_text { "字符" } else { "字节" };
        return Err((
            413,
            format!(
                "内容超限：{} {}，上限 {} {}——已整笔拒绝（未截断）。原文仍在客户端，可缩小后原样重试",
                size,
                unit,
                crate::MAX_CONTENT_CHARS,
                unit
            ),
        ));
    }
    Ok((env, size))
}

/// 纯函数路由处理器（供 TCP 监听与单元测试直接调用）
pub fn handle_request(
    state: &crate::AppState,
    method: &str,
    raw_path: &str,
    origin: Option<&str>,
    body_bytes: &[u8],
) -> (u16, &'static str, Value) {
    let enabled = state.cfg.lock().map(|g| g.0.ext_server).unwrap_or(true);
    if !enabled {
        return (
            503,
            "503 Service Unavailable",
            json!({"error": "已在纳言「设置 › 捕获」中关闭浏览器扩展与快捷指令接收"}),
        );
    }
    if !is_allowed_origin(origin) {
        return (
            403,
            "403 Forbidden",
            json!({"error": "拒绝来自普通网页的跨域访问（仅允许浏览器扩展与本机快捷指令）"}),
        );
    }
    let (path_only, query) = raw_path.split_once('?').unwrap_or((raw_path, ""));
    match (method, path_only) {
        ("GET", "/api/health") => {
            let db_path = state
                .cfg
                .lock()
                .ok()
                .and_then(|g| {
                    g.0.db_path
                        .clone()
                        .or_else(|| g.1.parent().map(|p| p.join("inbox.db").display().to_string()))
                })
                .unwrap_or_default();
            (
                200,
                "200 OK",
                json!({"ok": true, "db": db_path, "server": "nayan-app"}),
            )
        }
        ("GET", "/api/projects") => match crate::handle_api(state, "GET", "/api/projects", &Value::Null) {
            Ok(v) => (200, "200 OK", v),
            Err(e) => (500, "500 Internal Server Error", json!({"error": e})),
        },
        ("GET", "/api/suggestions") => {
            let mut status_filter: Option<String> = None;
            let mut limit: i64 = 50;
            for pair in query.split('&').filter(|s| !s.is_empty()) {
                if let Some((k, v)) = pair.split_once('=') {
                    if k == "status" && !v.is_empty() {
                        status_filter = Some(v.to_string());
                    } else if k == "limit" {
                        if let Ok(n) = v.parse::<i64>() {
                            limit = n.clamp(1, 200);
                        }
                    }
                }
            }
            let Ok(conn) = state.db.lock() else {
                return (500, "500 Internal Server Error", json!({"error": "数据库被占用"}));
            };
            let rows_res: Result<Vec<Value>, String> = (|| {
                let mut rows: Vec<Value> = if let Some(st) = status_filter {
                    let sql = format!(
                        "SELECT {} FROM suggestions WHERE deleted_at IS NULL AND status = ?1 ORDER BY id DESC LIMIT ?2",
                        crate::SUG_COLS
                    );
                    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                    let mapped = stmt
                        .query_map(rusqlite::params![st, limit], crate::sug_from_row)
                        .map_err(|e| e.to_string())?;
                    mapped
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?
                } else {
                    let sql = format!(
                        "SELECT {} FROM suggestions WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?1",
                        crate::SUG_COLS
                    );
                    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                    let mapped = stmt
                        .query_map([limit], crate::sug_from_row)
                        .map_err(|e| e.to_string())?;
                    mapped
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?
                };
                crate::attach_steps(&conn, &mut rows);
                Ok(rows)
            })();
            match rows_res {
                Ok(rows) => (200, "200 OK", json!(rows)),
                Err(e) => (500, "500 Internal Server Error", json!({"error": e})),
            }
        }
        ("POST", "/api/suggestions") => {
            let text = match std::str::from_utf8(body_bytes) {
                Ok(s) if !s.trim().is_empty() => s,
                Ok(_) => "{}",
                Err(_) => {
                    return (
                        400,
                        "400 Bad Request",
                        json!({"error": "请求体包含非法 UTF-8 字节"}),
                    )
                }
            };
            let b: Value = match serde_json::from_str::<Value>(text) {
                Ok(v) if v.is_object() => v,
                _ => return (400, "400 Bad Request", json!({"error": "无效 JSON"})),
            };
            let title = b["title"].as_str().unwrap_or("").trim().to_string();
            if title.is_empty() {
                return (400, "400 Bad Request", json!({"error": "title 不能为空"}));
            }
            for k in WRITABLE {
                if let Some(s) = b.get(k).and_then(|v| v.as_str()) {
                    let len = s.chars().count();
                    if len > crate::MAX_CONTENT_CHARS {
                        return (
                            413,
                            "413 Payload Too Large",
                            json!({"error": format!("字段 {} 超限：{} 字符，上限 {}——已整笔拒绝（未截断）", k, len, crate::MAX_CONTENT_CHARS)}),
                        );
                    }
                }
            }
            if let Some(c) = b.get("content").filter(|v| !v.is_null()) {
                let (env, _) = match build_ext_envelope(c) {
                    Ok(x) => x,
                    Err((413, msg)) => return (413, "413 Payload Too Large", json!({"error": msg})),
                    Err((_, msg)) => return (400, "400 Bad Request", json!({"error": msg})),
                };
                let norm = json!({
                    "title": title,
                    "request_id": env.request_id(),
                    "content": serde_json::to_value(&env).unwrap_or(Value::Null),
                    "my_note": b["my_note"].as_str().unwrap_or(""),
                    "source_tool": b["source_tool"].as_str().unwrap_or("webbox"),
                    "workspace": b["workspace"].as_str().unwrap_or(""),
                    "session_ref": b["session_ref"].as_str().unwrap_or(""),
                    "tags": b["tags"].as_str().unwrap_or(""),
                    "user_msg": b["user_msg"].as_str().unwrap_or(""),
                });
                let Ok(conn) = state.db.lock() else {
                    return (500, "500 Internal Server Error", json!({"error": "数据库被占用"}));
                };
                match crate::create_with_content(&conn, &norm) {
                    Ok(row) => (200, "200 OK", row),
                    Err(e) => (400, "400 Bad Request", json!({"error": e})),
                }
            } else {
                let norm = json!({
                    "title": title,
                    "quote": b["quote"].as_str().unwrap_or(""),
                    "my_note": b["my_note"].as_str().unwrap_or(""),
                    "source_tool": b["source_tool"].as_str().filter(|s| !s.is_empty()).unwrap_or("web"),
                    "workspace": b["workspace"].as_str().unwrap_or(""),
                    "session_ref": b["session_ref"].as_str().unwrap_or(""),
                    "tags": b["tags"].as_str().unwrap_or(""),
                    "user_msg": b["user_msg"].as_str().unwrap_or(""),
                });
                match crate::handle_api(state, "POST", "/api/suggestions", &norm) {
                    Ok(row) => (200, "200 OK", row),
                    Err(e) => (400, "400 Bad Request", json!({"error": e})),
                }
            }
        }
        _ => (404, "404 Not Found", json!({"error": "not found"})),
    }
}

struct HttpReq {
    method: String,
    path: String,
    origin: Option<String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpReq, (u16, &'static str, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let header_end;
    loop {
        let n = stream
            .read(&mut tmp)
            .map_err(|e| (400, "400 Bad Request", e.to_string()))?;
        if n == 0 {
            return Err((400, "400 Bad Request", "空请求".into()));
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = i;
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err((400, "400 Bad Request", "请求头过大".into()));
        }
    }
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let req_line = lines.next().unwrap_or("");
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    let mut origin = None;
    let mut content_type = None;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            } else if k.trim().eq_ignore_ascii_case("origin") {
                origin = Some(v.trim().to_string());
            } else if k.trim().eq_ignore_ascii_case("content-type") {
                content_type = Some(v.trim().to_ascii_lowercase());
            }
        }
    }
    if method == "POST" {
        if let Some(ct) = &content_type {
            if !ct.starts_with("application/json") {
                return Err((
                    415,
                    "415 Unsupported Media Type",
                    "仅接受 Content-Type: application/json（拦截表单简单请求 CSRF）".into(),
                ));
            }
        }
    }
    if content_length > 16 * 1024 * 1024 {
        return Err((413, "413 Payload Too Large", "请求体超过上限".into()));
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut tmp)
            .map_err(|e| (400, "400 Bad Request", e.to_string()))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);
    Ok(HttpReq {
        method,
        path,
        origin,
        body,
    })
}

fn write_http_response(
    stream: &mut TcpStream,
    status_line: &str,
    origin: Option<&str>,
    body: Option<&Value>,
) {
    let cors = if is_extension_origin(origin) {
        format!(
            "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n",
            origin.unwrap_or("")
        )
    } else {
        String::new()
    };
    if let Some(v) = body {
        let bytes = v.to_string().into_bytes();
        let head = format!(
            "HTTP/1.1 {}\r\nContent-Type: application/json; charset=utf-8\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n",
            status_line,
            cors,
            bytes.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(&bytes);
    } else {
        let head = format!(
            "HTTP/1.1 {}\r\n{}Content-Length: 0\r\nConnection: close\r\n\r\n",
            status_line, cors
        );
        let _ = stream.write_all(head.as_bytes());
    }
    let _ = stream.flush();
}

/// 启动内置 127.0.0.1:8787 接收线程（端口暂被占用时后台轮询等待释放并自动接管，不阻塞启动）
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut logged_busy = false;
        let listener = loop {
            match TcpListener::bind(("127.0.0.1", EXT_PORT)) {
                Ok(l) => {
                    crate::log_line(&format!(
                        "[扩展服务] 已启动内置接收 127.0.0.1:{}（支持 Chrome 扩展与快捷指令直连）",
                        EXT_PORT
                    ));
                    break l;
                }
                Err(e) => {
                    if !logged_busy {
                        crate::log_line(&format!(
                            "[扩展服务] 127.0.0.1:{} 暂被占用（{}），将在端口释放后自动接管",
                            EXT_PORT, e
                        ));
                        logged_busy = true;
                    }
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        };
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || {
                let req = match read_http_request(&mut s) {
                    Ok(r) => r,
                    Err((_, line, msg)) => {
                        write_http_response(&mut s, line, None, Some(&json!({"error": msg})));
                        return;
                    }
                };
                if req.method == "OPTIONS" && is_extension_origin(req.origin.as_deref()) {
                    write_http_response(&mut s, "204 No Content", req.origin.as_deref(), None);
                    return;
                }
                let st = app.state::<crate::AppState>();
                let (code, line, payload) = handle_request(
                    &st,
                    &req.method,
                    &req.path,
                    req.origin.as_deref(),
                    &req.body,
                );
                write_http_response(&mut s, line, req.origin.as_deref(), Some(&payload));
                if req.method == "POST" && code == 200 {
                    let _ = app.emit("inbox-changed", ());
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static EXT_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn make_state() -> crate::AppState {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "nayan-ext-srv-{}-{}",
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&root).unwrap();
        let conn = crate::open_db(&root.join("inbox.db")).unwrap();
        let cfg_path = root.join("config.json");
        crate::AppState {
            db: Mutex::new(conn),
            cfg: Mutex::new((crate::load_config(&cfg_path), cfg_path)),
        }
    }

    #[test]
    fn origin_guard_allows_extension_and_blocks_websites() {
        assert!(is_allowed_origin(None));
        assert!(is_allowed_origin(Some("")));
        assert!(is_allowed_origin(Some("chrome-extension://abcdefghijklmnop")));
        assert!(is_allowed_origin(Some("moz-extension://1234-5678")));
        assert!(is_allowed_origin(Some("safari-web-extension://abcd")));
        assert!(!is_allowed_origin(Some("https://evil.example.com")));
        assert!(!is_allowed_origin(Some("http://localhost:3000")));
        assert!(!is_allowed_origin(Some("null")));
    }

    #[test]
    fn ext_server_routes_and_toggle_work() {
        let _g = EXT_TEST_LOCK.lock().unwrap();
        EXT_SERVER_ON.store(true, Ordering::Relaxed);
        let st = make_state();

        // 1. 普通网页 Origin 必须 403 拒绝
        let (code, _, _) = handle_request(
            &st,
            "POST",
            "/api/suggestions",
            Some("https://evil.example.com"),
            br#"{"title":"x"}"#,
        );
        assert_eq!(code, 403);

        // 2. 结构化信封写入（模拟 Chrome 扩展）+ 幂等去重
        let body = json!({
            "title": "扩展框选建议",
            "workspace": "demo-proj",
            "source_tool": "webbox",
            "content": {
                "request_id": "ext-req-1",
                "format": "markdown",
                "original": { "kind": "text", "text": "## 标题\n- 第一点\n- 第二点" }
            }
        });
        let (code, _, v1) = handle_request(
            &st,
            "POST",
            "/api/suggestions",
            Some("chrome-extension://abc"),
            body.to_string().as_bytes(),
        );
        assert_eq!(code, 200);
        assert_eq!(v1["duplicate"], json!(false));
        let id = v1["id"].as_i64().unwrap();

        let (code2, _, v2) = handle_request(
            &st,
            "POST",
            "/api/suggestions",
            Some("chrome-extension://abc"),
            body.to_string().as_bytes(),
        );
        assert_eq!(code2, 200);
        assert_eq!(v2["duplicate"], json!(true));
        assert_eq!(v2["id"].as_i64().unwrap(), id);

        // 3. 项目列表与建议列表
        let (pcode, _, projs) = handle_request(&st, "GET", "/api/projects", None, b"");
        assert_eq!(pcode, 200);
        assert_eq!(projs[0]["name"], json!("demo-proj"));

        let (scode, _, list) = handle_request(&st, "GET", "/api/suggestions?limit=10", None, b"");
        assert_eq!(scode, 200);
        assert_eq!(list.as_array().unwrap().len(), 1);

        // 4. 关闭开关后返回 503
        crate::handle_api(&st, "POST", "/api/settings", &json!({"ext_server": false})).unwrap();
        let (off_code, _, _) = handle_request(&st, "GET", "/api/health", None, b"");
        assert_eq!(off_code, 503);
        crate::handle_api(&st, "POST", "/api/settings", &json!({"ext_server": true})).unwrap();
    }
}
