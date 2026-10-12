//! 剪贴板被动通道
//! 用户在任何 App 里正常 ⌘C 复制 → 纳言检测到新内容 → 右下角弹玻璃 HUD：
//! 「⏎ 直接入箱 / E 编辑 / Esc 忽略」。零操作成本的第二采集入口。
//! 设计要点：
//! - 2s 轮询 changeCount（不读内容，不触发系统粘贴授权）
//! - 自捕获抑制：⌥S 的 ⌘C 兜底会改剪贴板，抑制窗口期内忽略
//! - 首次读取内容时 macOS 会弹一次「允许粘贴」系统提示（SCK 同款行为），允许一次即可

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::ax_capture::CLIP_SUPPRESS_UNTIL;

pub static CLIP_WATCH_ON: AtomicBool = AtomicBool::new(true);
pub static CLIP_SCOPE_ALL: AtomicBool = AtomicBool::new(false); // false=仅关注 App（默认）
pub static CLIP_APPS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static LAST_SEEN: AtomicI64 = AtomicI64::new(-1);
static DRAFT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static HUD_DRAFT: Mutex<Option<HudDraft>> = Mutex::new(None);
struct NativeTestBinding { source: String, started: Instant }
static NATIVE_TEST_BINDING: OnceLock<NativeTestBinding> = OnceLock::new();
static TRACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn source_allowed(test: bool, fixed: Option<&str>, front: &str, all: bool, apps: &[String]) -> bool {
    if test { return fixed.map(|s| s.eq_ignore_ascii_case(front)).unwrap_or(false); }
    all || apps.iter().any(|s| s.eq_ignore_ascii_case(front))
}

/// 仅显式 owned 验证使用；来源绑定不受 /api/settings 的 scope/apps 修改影响。
pub fn start_native_test(app: AppHandle, source: &str) -> Result<(), String> {
    if !crate::test_profile::test_mode() { return Err("原生测试来源只允许隔离模式".into()); }
    NATIVE_TEST_BINDING.set(NativeTestBinding { source: source.into(), started: Instant::now() })
        .map_err(|_| "原生测试来源已绑定，不允许替换")?;
    CLIP_WATCH_ON.store(true, Ordering::Relaxed);
    start(app);
    Ok(())
}

fn test_trace(phase: &str, detail: serde_json::Value) {
    if !crate::test_profile::test_mode() { return; }
    let Some(binding) = NATIVE_TEST_BINDING.get() else { return };
    let seq = TRACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    if seq >= 360 { return; }
    println!("[native-clip-trace] {}", serde_json::json!({
        "seq":seq,"utc_ms":crate::ax_capture::now_ms(),
        "elapsed_ms":binding.started.elapsed().as_millis(),
        "source":binding.source,"phase":phase,"detail":detail,
    }));
}

#[derive(Clone, Debug)]
pub struct HudDraft {
    pub request_id: String,
    pub snapshot: crate::ax_capture::ClipboardSnapshot,
}

fn matching_draft(draft: Option<&HudDraft>, request_id: &str, text: &str) -> Result<HudDraft, String> {
    draft.filter(|d| d.request_id == request_id && d.snapshot.text == text)
        .cloned().ok_or_else(|| "这份剪贴板稿已被替换，请使用当前稿".into())
}

pub fn resolve_draft(request_id: &str, text: &str) -> Result<HudDraft, String> {
    matching_draft(HUD_DRAFT.lock().map_err(|_| "剪贴板稿不可用")?.as_ref(), request_id, text)
}

pub(crate) fn test_draft_snapshot() -> Option<HudDraft> {
    if !crate::test_profile::test_mode() { return None; }
    HUD_DRAFT.lock().ok()?.clone()
}

/// 旧操作完成时不能清掉刚到达的新稿。
pub fn complete_draft(request_id: &str) -> bool {
    let Ok(mut draft) = HUD_DRAFT.lock() else { return false };
    if draft.as_ref().map(|d| d.request_id.as_str()) == Some(request_id) {
        test_trace("draft-completed", serde_json::json!({"request_id":request_id}));
        *draft = None; true
    } else { false }
}

const PSEUDO_SOURCES: &[&str] = &["hotkey","clipboard","webbox","web","other","mcp","剪贴板"];

static LAST_PASTE_MS: AtomicU64 = AtomicU64::new(0);

/// HID 层检测到 ⌘V 粘贴时调用（输入法搬运：写剪贴板→立刻粘贴）
pub fn note_paste() {
    let n = crate::ax_capture::now_ms();
    LAST_PASTE_MS.store(n, std::sync::atomic::Ordering::Relaxed);
    CLIP_SUPPRESS_UNTIL.store(n + 1500, std::sync::atomic::Ordering::Relaxed);
}

const MIN_LEN: usize = 10; // 少于 10 字符的复制不值得打扰
const POLL_MS: u64 = 2000;

fn change_count() -> i64 {
    unsafe {
        use cocoa::base::id;
        use objc::{msg_send, class, sel, sel_impl};
        let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
        let c: i64 = msg_send![pb, changeCount];
        c
    }
}

pub fn start(app: AppHandle) {
    // 默认隔离入口即使误调用 start 也不接触剪贴板。
    if crate::test_profile::test_mode() && NATIVE_TEST_BINDING.get().is_none() { return; }
    // 初始化基线：启动时剪贴板里已有的内容不触发
    LAST_SEEN.store(change_count(), Ordering::Relaxed);
    test_trace("watcher-start", serde_json::json!({"baseline":LAST_SEEN.load(Ordering::Relaxed)}));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        let _ = poll_once(&app);
    });
}

fn poll_once(app: &AppHandle) {
    let is_test = crate::test_profile::test_mode();
    if is_test && NATIVE_TEST_BINDING.get().map(|b| b.started.elapsed() >= Duration::from_secs(600)).unwrap_or(true) { return; }
    if !CLIP_WATCH_ON.load(Ordering::Relaxed) {
        test_trace("disabled", serde_json::json!({}));
        return;
    }
    // ⌥S 的 ⌘C 兜底刚改过剪贴板：忽略并同步基线
    if crate::ax_capture::now_ms() < CLIP_SUPPRESS_UNTIL.load(Ordering::Relaxed) {
        LAST_SEEN.store(change_count(), Ordering::Relaxed);
        test_trace("suppressed", serde_json::json!({"generation":LAST_SEEN.load(Ordering::Relaxed)}));
        return;
    }
    let now = change_count();
    let prev = LAST_SEEN.swap(now, Ordering::Relaxed);
    // 生产仍仅在剪贴板变化时查询前台；测试心跳另记录前台以定位触发窗口。
    let front = if is_test || (now != prev && prev >= 0) {
        crate::ax_capture::front_app_name()
    } else { String::new() };
    test_trace("poll", serde_json::json!({"generation":now,"previous":prev,"front":front}));
    if now == prev || prev < 0 {
        return;
    }
    // 来源过滤（被动通道只盯目标 App；微信/网页等日常复制静默跳过）
    let all = CLIP_SCOPE_ALL.load(Ordering::Relaxed);
    let apps = CLIP_APPS.lock().map(|l| l.clone()).unwrap_or_default();
    if !source_allowed(is_test, NATIVE_TEST_BINDING.get().map(|b| b.source.as_str()), &front, all, &apps) {
        test_trace("source-rejected", serde_json::json!({"front":front,"generation":now,"mutable_scope_all":all}));
        return;
    }
    test_trace("source-accepted", serde_json::json!({"front":front,"generation":now}));
    let snapshot = match crate::ax_capture::clipboard_snapshot_now() {
        Ok(s) => s,
        Err(e) => { test_trace("snapshot-rejected", serde_json::json!({"reason":e})); return; }
    };
    if snapshot.generation != now {
        test_trace("generation-rejected", serde_json::json!({"expected":now,"actual":snapshot.generation})); return;
    }
    test_trace("snapshot-stable", serde_json::json!({"generation":now,"text_chars":snapshot.text.chars().count(),"html_chars":snapshot.html.as_ref().map(|h|h.chars().count())}));
    let text = &snapshot.text;
    // 截图/照片路径不是可收录文本（macOS 粘贴板历史会把截图路径以文本形式塞进剪贴板）
    let looks_like_image_path = text.starts_with('/')
        && (text.ends_with(".png") || text.ends_with(".jpg") || text.ends_with(".jpeg")
            || text.ends_with(".heic") || text.ends_with(".tiff") || text.contains("PasteboardHistory"));
    if looks_like_image_path {
        test_trace("image-path-rejected", serde_json::json!({}));
        return;
    }
    // 输入法搬运判定：粘贴动作发生在剪贴板变化后 2.5s 内 → 是语音/工具在搬运文字，非性收录
    let last_paste = LAST_PASTE_MS.load(std::sync::atomic::Ordering::Relaxed);
    if last_paste > 0 && crate::ax_capture::now_ms().saturating_sub(last_paste) < 2500 {
        test_trace("paste-suppressed", serde_json::json!({}));
        return;
    }
    if text.chars().count() < MIN_LEN {
        test_trace("short-text-rejected", serde_json::json!({"chars":text.chars().count()}));
        return;
    }
    crate::log_line(&format!(
        "[剪贴板] 检测到新复制 {} 字符（来自 {}）→ 弹快速收录",
        text.chars().count(),
        crate::ax_capture::front_app_name()
    ));
    let draft = HudDraft {
        request_id: format!("clip-{}-{}", snapshot.generation, DRAFT_SEQUENCE.fetch_add(1, Ordering::Relaxed)),
        snapshot,
    };
    *HUD_DRAFT.lock().unwrap() = Some(draft.clone());
    test_trace("draft-created", serde_json::json!({"request_id":draft.request_id,"generation":draft.snapshot.generation}));
    show_hud(app, &draft);
}

fn show_hud(app: &AppHandle, draft: &HudDraft) {
    let Some(w) = app.get_webview_window("cliphud") else {
        test_trace("hud-missing", serde_json::json!({}));
        crate::log_line("[剪贴板] cliphud 窗口未初始化");
        return;
    };
    let payload = serde_json::json!({ "text": draft.snapshot.text, "request_id":draft.request_id, "generation":draft.snapshot.generation }).to_string();
    let delivered = w.eval(&format!("window.__clip({});", payload));
    test_trace("hud-eval", serde_json::json!({"ok":delivered.is_ok(),"error":delivered.err().map(|e|e.to_string())}));
    // 右下角，位于捕获小窗上方
    if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let logical = mon.size().to_logical::<f64>(scale);
        let _ = w.set_position(tauri::LogicalPosition::new(
            (logical.width - 420.0).max(0.0),
            (logical.height - 260.0).max(0.0),
        ));
    }
    let shown = w.show();
    test_trace("hud-show", serde_json::json!({"ok":shown.is_ok(),"error":shown.err().map(|e|e.to_string())}));
    let _ = w.set_focus();
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::activate_app();
        if let Some(w) = h.get_webview_window("cliphud") {
            let _ = w.set_focus();
        }
    });
}

pub fn hide_hud(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("cliphud") {
        let _ = w.hide();
    }
}

/// 自动学习：在某个 App 里主动捕获（⌥S/⌥Z）成功 → 该 App 加入关注列表
pub fn learn(app: &AppHandle, app_name: &str) {
    if app_name.is_empty() || PSEUDO_SOURCES.contains(&app_name) {
        return;
    }
    {
        let mut l = match CLIP_APPS.lock() {
            Ok(l) => l,
            Err(_) => return,
        };
        if l.iter().any(|x| x == app_name) {
            return;
        }
        l.push(app_name.to_string());
    }
    let _ = app;
    crate::log_line(&format!("[剪贴板] 已自动关注 {}", app_name));
}

pub fn set_apps(list: Vec<String>) {
    if let Ok(mut l) = CLIP_APPS.lock() {
        *l = list;
    }
}

pub fn get_apps() -> Vec<String> {
    CLIP_APPS.lock().map(|l| l.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_source_cannot_be_widened_by_product_settings() {
        for all in [false, true] {
            for apps in [vec![],vec!["Other App".to_string()],vec!["WorkBuddy".to_string(),"Other App".to_string()]] {
                assert!(source_allowed(true,Some("WorkBuddy"),"workbuddy",all,&apps));
                assert!(!source_allowed(true,Some("WorkBuddy"),"Other App",all,&apps));
                assert!(!source_allowed(true,None,"WorkBuddy",all,&apps));
            }
        }
        assert!(source_allowed(false,None,"Other App",true,&[]));
        assert!(source_allowed(false,None,"Other App",false,&["Other App".into()]));
        assert!(!source_allowed(false,None,"Other App",false,&[]));
    }
    #[test]
    fn hud_draft_identity_and_owned_bytes() {
        let make = |generation, html: &str| HudDraft {request_id: format!("clip-{generation}"), snapshot:crate::ax_capture::ClipboardSnapshot {generation,text:" same \r\n".into(),html:Some(html.into())}};
        let a=make(1,"<b>same</b>"); let b=make(2,"<i>same</i>");
        let saved=matching_draft(Some(&a),"clip-1"," same \r\n").unwrap();
        assert!(matching_draft(Some(&b),"clip-1"," same \r\n").is_err());
        assert!(matching_draft(Some(&a),"clip-1","same").is_err());
        assert!(matching_draft(None,"clip-1"," same \r\n").is_err());
        assert_eq!(saved.snapshot.html.as_deref(),Some("<b>same</b>"));
        assert_eq!(saved.snapshot.text," same \r\n");
    }
}
