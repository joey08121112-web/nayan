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
use tauri::AppHandle;

use crate::ax_capture::CLIP_SUPPRESS_UNTIL;

pub static CLIP_WATCH_ON: AtomicBool = AtomicBool::new(true);
static LAST_SEEN: AtomicI64 = AtomicI64::new(-1);
static LAST_TEXT: Mutex<String> = Mutex::new(String::new());

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
    let Ok(text) = clip_text() else { return };
    let text = text.trim().to_string();
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
        "[剪贴板] 检测到新复制 {} 字符 → 弹快速收录",
        text.chars().count()
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
    if let Ok(mon) = app.primary_monitor() {
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
