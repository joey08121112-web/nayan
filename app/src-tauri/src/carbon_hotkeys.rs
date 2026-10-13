//! 全局热键 · HID 层 CGEventTap
//! - 匹配表动态可改（键码+修饰掩码 → 动作），改绑定无需重建 tap
//! - 录制模式：设置页点「更改」后，下一个按键组合被记为_NEW_并拦截
//! - 只支持带修饰键的组合（纯字母会和打字冲突）

use std::os::raw::c_void;
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const K_CG_EVENT_TAP_HID: u32 = 0;
const K_CG_HEAD_INSERT: u32 = 0;
const K_CG_TAP_DEFAULT: u32 = 0;
const K_CG_EVENT_KEY_DOWN: u32 = 10;
const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;

// CGEventFlags 修饰位
pub const F_CTRL: u64 = 0x0004_0000;
pub const F_SHIFT: u64 = 0x0002_0000;
pub const F_CMD: u64 = 0x0010_0000;
pub const F_ALT: u64 = 0x0008_0000;
const F_MODS_ALL: u64 = F_ALT | F_SHIFT | F_CTRL | F_CMD;

#[derive(Clone, Copy)]
pub struct Binding {
    pub keycode: u32,
    pub mask: u64,
    pub action: u32,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static TAP_READY: AtomicBool = AtomicBool::new(false);
static BINDINGS: Mutex<Vec<Binding>> = Mutex::new(Vec::new());
struct CaptureState { slot: Option<u32>, deadline: Option<Instant>, captured: Option<String> }
static CAPTURE_SLOT: Mutex<CaptureState> = Mutex::new(CaptureState { slot: None, deadline: None, captured: None });
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(8);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        event_mask: u64,
        callback: unsafe extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
        user_info: *mut c_void,
    ) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CGEventKeyboardGetUnicodeString(
        event: *mut c_void,
        max_len: usize,
        out_len: *mut usize,
        out_str: *mut u16,
    );
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    fn CFMachPortCreateRunLoopSource(alloc: *mut c_void, port: *mut c_void, order: i64) -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, src: *mut c_void, mode: *const c_void);
    fn CFRunLoopGetMain() -> *mut c_void;
}

// ---------- 键码表 ----------
pub fn keycode_name(kc: u32) -> Option<&'static str> {
    Some(match kc {
        0 => "a", 1 => "s", 2 => "d", 3 => "f", 4 => "h", 5 => "g", 6 => "z", 7 => "x",
        8 => "c", 9 => "v", 11 => "b", 12 => "q", 13 => "w", 14 => "e", 15 => "r",
        16 => "y", 17 => "t", 31 => "o", 32 => "u", 34 => "i", 35 => "p", 37 => "l",
        38 => "j", 40 => "k", 45 => "n", 46 => "m",
        29 => "0", 18 => "1", 19 => "2", 20 => "3", 21 => "4", 23 => "5",
        22 => "6", 26 => "7", 28 => "8", 25 => "9",
        96 => "f5", 97 => "f6", 98 => "f7", 99 => "f3", 100 => "f8", 101 => "f9",
        109 => "f10", 103 => "f11", 111 => "f12", 120 => "f2", 122 => "f1", 118 => "f4",
        _ => return None,
    })
}

fn is_modifier_kc(kc: u32) -> bool {
    matches!(kc, 54 | 55 | 56 | 57 | 58 | 59 | 60 | 61 | 62 | 63)
}

fn combo_string(kc: u32, flags: u64) -> Option<String> {
    let key = keycode_name(kc)?;
    let mut parts: Vec<&str> = vec![];
    if flags & F_CTRL != 0 { parts.push("ctrl"); }
    if flags & F_ALT != 0 { parts.push("alt"); }
    if flags & F_SHIFT != 0 { parts.push("shift"); }
    if flags & F_CMD != 0 { parts.push("cmd"); }
    if parts.is_empty() {
        return None; // 纯字母：拒绝
    }
    parts.push(key);
    Some(parts.join("+"))
}

/// "alt+s" → (键码, CG修饰掩码)
pub fn parse_shortcut(s: &str) -> Option<(u32, u64)> {
    let mut mask = 0u64;
    let mut key: Option<String> = None;
    for part in s.split('+') {
        match part.trim().to_lowercase().as_str() {
            "alt" | "option" => mask |= F_ALT,
            "shift" => mask |= F_SHIFT,
            "ctrl" | "control" => mask |= F_CTRL,
            "cmd" | "super" => mask |= F_CMD,
            k => key = Some(k.to_string()),
        }
    }
    let kc = parse_keycode(key.as_deref()?)?;
    Some((kc, mask))
}

pub fn parse_keycode(k: &str) -> Option<u32> {
    Some(match k {
        "a" => 0,  "s" => 1,  "d" => 2,  "f" => 3,  "h" => 4,  "g" => 5,
        "z" => 6,  "x" => 7,  "c" => 8,  "v" => 9,  "b" => 11, "q" => 12,
        "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17, "o" => 31,
        "u" => 32, "i" => 34, "p" => 35, "l" => 37, "j" => 38, "k" => 40,
        "n" => 45, "m" => 46,
        "0" => 29, "1" => 18, "2" => 19, "3" => 20, "4" => 21, "5" => 23,
        "6" => 22, "7" => 26, "8" => 28, "9" => 25,
        "f1" => 122, "f2" => 120, "f3" => 99, "f4" => 118, "f5" => 96,
        "f6" => 97, "f7" => 98, "f8" => 100, "f9" => 101, "f10" => 109,
        "f11" => 103, "f12" => 111,
        _ => return None,
    })
}

/// 只拦截单独 Command 的系统常用组合；附加修饰键仍由用户选择。
pub fn system_combo_name(kc: u32, mask: u64) -> Option<&'static str> {
    if mask != F_CMD { return None; }
    Some(match kc {
        8 => "复制", 9 => "粘贴", 7 => "剪切", 6 => "撤销", 0 => "全选",
        1 => "保存", 12 => "退出", 13 => "关窗", 4 => "隐藏", 46 => "最小化",
        3 => "查找", 35 => "打印", 17 => "新标签", 45 => "新建", 31 => "打开",
        _ => return None,
    })
}

// ---------- 安装 ----------
pub fn install(app: AppHandle, hotkeys: Vec<(String, u32)>) -> Result<(), String> {
    let _ = APP.set(app);
    {
        let mut b = BINDINGS.lock().map_err(|_| "BINDINGS 被占用")?;
        b.clear();
        for (cfg_str, action) in &hotkeys {
            let (kc, mask) =
                parse_shortcut(cfg_str).ok_or_else(|| format!("无法解析热键配置：{}", cfg_str))?;
            if let Some(name) = system_combo_name(kc, mask) {
                crate::log_line(&format!("[热键] 警告：已保存快捷键 {} 与系统{}冲突，保持原配置", cfg_str, name));
            }
            b.push(Binding { keycode: kc, mask, action: *action });
        }
    }
    unsafe {
        let mask: u64 = 1 << K_CG_EVENT_KEY_DOWN;
        let port = CGEventTapCreate(
            K_CG_EVENT_TAP_HID, K_CG_HEAD_INSERT, K_CG_TAP_DEFAULT, mask,
            tap_callback, std::ptr::null_mut(),
        );
        if port.is_null() {
            return Err("CGEventTapCreate 失败——请到 系统设置→隐私与安全性→辅助功能 授权纳言".into());
        }
        let src = CFMachPortCreateRunLoopSource(std::ptr::null_mut(), port, 0);
        if src.is_null() {
            return Err("CFMachPortCreateRunLoopSource 失败".into());
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), src, kCFRunLoopCommonModes);
        CGEventTapEnable(port, true);
        TAP_READY.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub fn tap_ready() -> bool { TAP_READY.load(Ordering::Relaxed) }

/// 换绑定（设置页/配置变更时调用）：改匹配表即生效
pub fn set_binding(keycode: u32, mask: u64, action: u32) {
    let mut b = BINDINGS.lock().unwrap();
    b.retain(|x| x.action != action);
    b.push(Binding { keycode, mask, action });
}

pub fn conflict_with(keycode: u32, mask: u64, except_action: u32) -> Option<u32> {
    BINDINGS
        .lock()
        .ok()?
        .iter()
        .find(|b| b.action != except_action && b.keycode == keycode && b.mask == mask)
        .map(|b| b.action)
}

// ---------- 录制模式（设置页「更改」） ----------
pub fn start_capture_mode(slot: u32) {
    start_capture_for(slot, CAPTURE_TIMEOUT);
}

fn start_capture_for(slot: u32, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    *CAPTURE_SLOT.lock().unwrap() = CaptureState { slot: Some(slot), deadline: Some(deadline), captured: None };
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        let mut state = CAPTURE_SLOT.lock().unwrap();
        // 旧定时器不能取消后来开始的录制。
        if state.deadline == Some(deadline) { expire_capture(&mut state); }
    });
}

fn expire_capture(state: &mut CaptureState) {
    if state.slot.is_some() && state.deadline.is_some_and(|d| Instant::now() >= d) {
        state.slot = None; state.deadline = None; state.captured = Some("__cancel__".into());
    }
}

pub fn cancel_capture_mode() {
    let mut state = CAPTURE_SLOT.lock().unwrap();
    state.slot = None; state.deadline = None; state.captured = Some("__cancel__".into());
}

/// None = 还没录到；Some("__cancel__")=Esc；Some("__none__")=没带修饰键；Some(combo)=成功
pub fn take_captured() -> Option<String> {
    let mut state = CAPTURE_SLOT.lock().unwrap();
    expire_capture(&mut state);
    state.captured.clone()
}

fn capture_key(kc: u32, flags: u64) -> bool {
    let mut state = CAPTURE_SLOT.lock().unwrap();
    expire_capture(&mut state);
    if state.slot.is_none() { return false; }
    if kc == 53 || !is_modifier_kc(kc) {
        state.slot = None; state.deadline = None;
        state.captured = Some(if kc == 53 { "__cancel__".into() } else { combo_string(kc, flags).unwrap_or_else(|| "__none__".into()) });
    }
    true
}

unsafe extern "C" fn tap_callback(
    _proxy: *mut c_void,
    ev_type: u32,
    event: *mut c_void,
    _user_info: *mut c_void,
) -> *mut c_void {
    if ev_type != K_CG_EVENT_KEY_DOWN {
        return event;
    }
    let kc = CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE) as u32;
    let flags = CGEventGetFlags(event);

    // 追踪「搬运信号」：⌘V 或携带长文本载荷的按键插入（语音输入法识别后写剪贴板再注入的通用指纹）。
    // 剪贴板监听在变化后 2.5s 内见到该信号 → 判定为输入法搬运，静默跳过。
    if ev_type == K_CG_EVENT_KEY_DOWN {
        let is_paste = flags & F_CMD != 0 && kc == 9; // ⌘V
        if !is_paste {
            let mut buf = [0u16; 512];
            let mut len: usize = 0;
            CGEventKeyboardGetUnicodeString(event, 512, &mut len, buf.as_mut_ptr());
            if len > 2 {
                crate::clipboard_watch::note_paste();
            }
        } else {
            crate::clipboard_watch::note_paste();
        }
    }

    // 录制模式优先：正在改绑定时，按键被记录并拦截
    if capture_key(kc, flags) {
        return std::ptr::null_mut(); // 录制期间一律拦截
    }

    // 常规匹配：修饰键精确匹配
    let bindings = BINDINGS.lock().ok();
    if let Some(list) = bindings {
        let hit = list
            .iter()
            .find(|b| b.keycode == kc && (flags & F_MODS_ALL) == b.mask)
            .map(|b| (b.action, b.keycode, b.mask));
        drop(list);
        if let Some((action, _, _)) = hit {
            if let Some(app) = APP.get() {
                let app = app.clone();
                match action {
                    1 => {
                        crate::log_line("热键触发(HID)：划词");
                        crate::start_capture(app);
                    }
                    2 => {
                        crate::log_line("热键触发(HID)：框选");
                        crate::box_select_start(app);
                    }
                    _ => {}
                }
            }
            return std::ptr::null_mut(); // 吃掉按键
        }
    }
    event
}

#[cfg(test)]
mod capture_tests {
    use super::*;

    #[test]
    fn system_combos_have_correct_names_and_require_exact_command_modifier() {
        for (key, name) in [("c", "复制"), ("v", "粘贴"), ("x", "剪切"), ("z", "撤销"),
            ("a", "全选"), ("s", "保存"), ("q", "退出"), ("w", "关窗"),
            ("h", "隐藏"), ("m", "最小化"), ("f", "查找"), ("p", "打印"),
            ("t", "新标签"), ("n", "新建"), ("o", "打开")] {
            let kc = parse_keycode(key).unwrap();
            assert_eq!(system_combo_name(kc, F_CMD), Some(name));
            for mask in [0, F_ALT, F_CTRL, F_CMD | F_SHIFT, F_CMD | F_CTRL, F_CMD | F_ALT] {
                assert_eq!(system_combo_name(kc, mask), None);
            }
        }
        assert_eq!(system_combo_name(parse_keycode("f5").unwrap(), F_CMD), None);
    }

    #[test]
    fn recording_keeps_modified_shortcuts_and_rejects_all_single_keys() {
        for key in ["a", "0", "f5", "f12"] {
            assert_eq!(combo_string(parse_keycode(key).unwrap(), 0), None);
        }
        for (combo, mask) in [("alt+s", F_ALT), ("ctrl+alt+x", F_CTRL | F_ALT),
            ("cmd+shift+c", F_CMD | F_SHIFT), ("ctrl+cmd+c", F_CTRL | F_CMD)] {
            let (kc, parsed) = parse_shortcut(combo).unwrap();
            assert_eq!(parsed, mask);
            let recorded = combo_string(kc, parsed).unwrap();
            assert_eq!(parse_shortcut(&recorded), Some((kc, mask)));
            assert_eq!(system_combo_name(kc, mask), None);
        }
    }

    #[test]
    fn idle_recording_expires_without_a_key_and_next_key_is_not_consumed() {
        start_capture_for(1, Duration::from_millis(20));
        let limit = Instant::now() + Duration::from_secs(1);
        // 不调用 take_captured / capture_key，直接确认后台超时清除状态。
        while CAPTURE_SLOT.lock().unwrap().slot.is_some() && Instant::now() < limit {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(CAPTURE_SLOT.lock().unwrap().slot.is_none());
        assert_eq!(take_captured().as_deref(), Some("__cancel__"));
        assert!(!capture_key(0, 0), "过期后普通字符不能被录制拦截");
        start_capture_mode(2); cancel_capture_mode();
        assert!(!capture_key(1, F_ALT), "关闭设置后的按键不能被录制拦截");
        assert_eq!(take_captured().as_deref(), Some("__cancel__"));
    }
}
