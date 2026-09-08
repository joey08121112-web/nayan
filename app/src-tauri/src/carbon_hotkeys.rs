//! 全局热键 · HID 层 CGEventTap 实现
//! 为什么不用 Carbon RegisterEventHotKey：实测本机（macOS 26）上 Carbon 分发被
//! 遗留僵尸注册拦截（HID 探针可见按键、Carbon 永不触发）。CGEventTap 挂在
//! kCGHIDEventTap（键盘信号第一站），比僵尸记录更靠前，物理上无法被截胡。
//! 代价：需要辅助功能权限（tapCreate 失败会明确报错）。
//! 当前设计只匹配 option+键（配置里写 "alt+s" 这类）。

use std::os::raw::c_void;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

const K_CG_EVENT_TAP_HID: u32 = 0; // kCGHIDEventTap
const K_CG_HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
const K_CG_TAP_DEFAULT: u32 = 0; // kCGEventTapOptionDefault（可拦截可透传）
const K_CG_EVENT_KEY_DOWN: u32 = 10;
const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
const K_CG_EVENT_FLAG_ALTERNATE: u64 = 0x0008_0000;

static APP: OnceLock<AppHandle> = OnceLock::new();
static KEY_ACTIONS: Mutex<Vec<(u32, u32)>> = Mutex::new(Vec::new()); // (键码, 动作id)

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
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    fn CFMachPortCreateRunLoopSource(
        alloc: *mut c_void,
        port: *mut c_void,
        order: i64,
    ) -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, src: *mut c_void, mode: *const c_void);
    fn CFRunLoopGetMain() -> *mut c_void;
}

unsafe extern "C" fn tap_callback(
    _proxy: *mut c_void,
    ev_type: u32,
    event: *mut c_void,
    _user_info: *mut c_void,
) -> *mut c_void {
    if ev_type == K_CG_EVENT_KEY_DOWN {
        let kc = CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE);
        let flags = CGEventGetFlags(event);
        if flags & K_CG_EVENT_FLAG_ALTERNATE != 0 {
            let action = KEY_ACTIONS
                .lock()
                .ok()
                .and_then(|m| m.iter().find(|(k, _)| *k == kc as u32).map(|(_, a)| *a));
            if let Some(action) = action {
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
                return std::ptr::null_mut(); // 吃掉按键，不透传给任何 App
            }
        }
    }
    event // 透传
}

/// "alt+s" → 键码（S=1，Z=6 …）。只支持 alt+键；其余修饰忽略（当前产品只需要 alt+键）。
pub fn parse_shortcut(s: &str) -> Option<u32> {
    let mut key: Option<String> = None;
    for part in s.split('+') {
        match part.trim().to_lowercase().as_str() {
            "alt" | "option" | "shift" | "ctrl" | "control" | "cmd" | "super" => {}
            k => key = Some(k.to_string()),
        }
    }
    Some(match key.as_deref()? {
        "a" => 0,  "s" => 1,  "d" => 2,  "f" => 3,  "h" => 4,  "g" => 5,
        "z" => 6,  "x" => 7,  "c" => 8,  "v" => 9,  "b" => 11, "q" => 12,
        "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17, "o" => 31,
        "u" => 32, "i" => 34, "p" => 35, "l" => 37, "j" => 38, "k" => 40,
        "n" => 45, "m" => 46,
        "0" => 29, "1" => 18, "2" => 19, "3" => 20, "4" => 21, "5" => 23,
        "6" => 22, "7" => 26, "8" => 28, "9" => 25,
        _ => return None,
    })
}

/// 安装 HID 层热键拦截。hotkeys = (配置串, 动作 id)：1=划词 2=框选。
/// 失败（典型原因：辅助功能未授权）时返回 Err，由调用方决定是否继续运行。
pub fn install(app: AppHandle, hotkeys: Vec<(String, u32)>) -> Result<(), String> {
    let _ = APP.set(app);
    {
        let mut ka = KEY_ACTIONS.lock().map_err(|_| "KEY_ACTIONS 被占用")?;
        ka.clear();
        for (cfg_str, action_id) in &hotkeys {
            let kc = parse_shortcut(cfg_str)
                .ok_or_else(|| format!("无法解析热键配置：{}", cfg_str))?;
            ka.push((kc, *action_id));
        }
    }
    unsafe {
        let mask: u64 = 1 << K_CG_EVENT_KEY_DOWN;
        let port = CGEventTapCreate(
            K_CG_EVENT_TAP_HID,
            K_CG_HEAD_INSERT,
            K_CG_TAP_DEFAULT,
            mask,
            tap_callback,
            std::ptr::null_mut(),
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
    }
    Ok(())
}
