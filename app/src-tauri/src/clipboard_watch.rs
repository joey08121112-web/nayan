//! 剪贴板被动通道
//! 用户在任何 App 里正常 ⌘C 复制 → 纳言检测到新内容 → 右下角弹玻璃 HUD：
//! 「⏎ 直接入箱 / E 编辑 / Esc 忽略」。零操作成本的第二采集入口。
//! 设计要点：
//! - 2s 轮询 changeCount（不读内容，不触发系统粘贴授权）
//! - 自捕获抑制：⌥S 的 ⌘C 兜底会改剪贴板，抑制窗口期内忽略
//! - 首次读取内容时 macOS 会弹一次「允许粘贴」系统提示（SCK 同款行为），允许一次即可

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::ax_capture::CLIP_SUPPRESS_UNTIL;

pub static CLIP_WATCH_ON: AtomicBool = AtomicBool::new(true);
pub static CLIP_SCOPE_ALL: AtomicBool = AtomicBool::new(false); // false=仅关注 App（默认）
pub static CLIP_APPS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static LAST_SEEN: AtomicI64 = AtomicI64::new(-1);
static LAST_TEXT: Mutex<String> = Mutex::new(String::new());

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

fn clip_text() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

pub fn start(app: AppHandle) {
    // 初始化基线：启动时剪贴板里已有的内容不触发
    LAST_SEEN.store(change_count(), Ordering::Relaxed);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        let _ = poll_once(&app);
    });
}

fn poll_once(app: &AppHandle) {
    if !CLIP_WATCH_ON.load(Ordering::Relaxed) {
        return;
    }
    // ⌥S 的 ⌘C 兜底刚改过剪贴板：忽略并同步基线
    if crate::ax_capture::now_ms() < CLIP_SUPPRESS_UNTIL.load(Ordering::Relaxed) {
        LAST_SEEN.store(change_count(), Ordering::Relaxed);
        return;
    }
    let now = change_count();
    let prev = LAST_SEEN.swap(now, Ordering::Relaxed);
    if now == prev || prev < 0 {
        return;
    }
    // 来源过滤（被动通道只盯目标 App；微信/网页等日常复制静默跳过）
    if !CLIP_SCOPE_ALL.load(Ordering::Relaxed) {
        let front = crate::ax_capture::front_app_name();
        let inlist = CLIP_APPS
            .lock()
            .map(|l| l.iter().any(|a| a.eq_ignore_ascii_case(&front)))
            .unwrap_or(false);
        if !inlist {
            return;
        }
        LAST_SEEN.store(now, Ordering::Relaxed);
    }
    let Ok(text) = clip_text() else { return };
    let text = text.trim().to_string();
    // 截图/照片路径不是可收录文本（macOS 粘贴板历史会把截图路径以文本形式塞进剪贴板）
    let looks_like_image_path = text.starts_with('/')
        && (text.ends_with(".png") || text.ends_with(".jpg") || text.ends_with(".jpeg")
            || text.ends_with(".heic") || text.ends_with(".tiff") || text.contains("PasteboardHistory"));
    if looks_like_image_path {
        return;
    }
    // 输入法搬运判定：粘贴动作发生在剪贴板变化后 2.5s 内 → 是语音/工具在搬运文字，非性收录
    let last_paste = LAST_PASTE_MS.load(std::sync::atomic::Ordering::Relaxed);
    if last_paste > 0 && crate::ax_capture::now_ms().saturating_sub(last_paste) < 2500 {
        return;
    }
    if text.chars().count() < MIN_LEN {
        return;
    }
    let mut last = LAST_TEXT.lock().unwrap();
    if text == *last {
        return; // 同一内容不重复打扰
    }
    *last = text.clone();
    drop(last);
    crate::log_line(&format!(
        "[剪贴板] 检测到新复制 {} 字符（来自 {}）→ 弹快速收录",
        text.chars().count(),
        crate::ax_capture::front_app_name()
    ));
    show_hud(app, &text);
}

fn show_hud(app: &AppHandle, text: &str) {
    let Some(w) = app.get_webview_window("cliphud") else {
        crate::log_line("[剪贴板] cliphud 窗口未初始化");
        return;
    };
    let payload = serde_json::json!({ "text": text }).to_string();
    let _ = w.eval(&format!("window.__clip({});", payload));
    // 右下角，位于捕获小窗上方
    if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let logical = mon.size().to_logical::<f64>(scale);
        let _ = w.set_position(tauri::LogicalPosition::new(
            (logical.width - 420.0).max(0.0),
            (logical.height - 260.0).max(0.0),
        ));
    }
    let _ = w.show();
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
