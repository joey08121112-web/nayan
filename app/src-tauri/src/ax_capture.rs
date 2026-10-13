//! AX（辅助功能）捕获模块
//! 划词：直读焦点元素的 AXSelectedText——不模拟按键、不污染剪贴板（对比 ⌘C 模拟）。
//! 框选（第 2 步）：文本块走查也在这个模块扩展。
//! 全部走 Apple 公开 C API：AXUIElementCopyAttributeValue / AXIsProcessTrustedWithOptions。
//! CFString 与 NSString 免桥转换，因此不新增 core-foundation 依赖。

use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSString};
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::CStr;
use std::os::raw::c_void;
use std::time::Duration;

type CFRef = *const c_void;

/// 剪贴板监听抑制标记：⌘C 兜底会改剪贴板，监听器在此时间戳（ms epoch）前忽略变化
pub static CLIP_SUPPRESS_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFRef) -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> CFRef;
    fn AXUIElementCopyAttributeValue(el: CFRef, attr: CFRef, out: *mut CFRef) -> i32;
    fn AXUIElementSetAttributeValue(el: CFRef, attr: CFRef, val: CFRef) -> i32;
    fn CFRelease(cf: CFRef);
    fn CFRetain(cf: CFRef) -> CFRef;
    fn CFGetTypeID(cf: CFRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetCount(arr: CFRef) -> i64;
    fn CFArrayGetValueAtIndex(arr: CFRef, idx: i64) -> CFRef;
    fn AXValueGetType(value: CFRef) -> u32;
    fn AXValueGetValue(value: CFRef, t: u32, out: *mut c_void) -> u8;
    fn AXUIElementPerformAction(el: CFRef, action: CFRef) -> i32;
    // 私有但多年稳定的 HIServices 符号：AX 窗口元素 → CGWindowID
    // （会话归组用它区分同 App 的多个同名窗口；拿不到时返回 false，调用方退化为 wid=0）
    fn _AXUIElementGetWindow(el: CFRef, out: *mut u32) -> u8;
}

// ---------- 小工具 ----------

unsafe fn ns_str(s: &str) -> id {
    NSString::alloc(nil).init_str(s)
}

unsafe fn ns_to_string(ns: id) -> String {
    if ns == nil {
        return String::new();
    }
    let cstr = NSString::UTF8String(ns);
    if cstr.is_null() {
        String::new()
    } else {
        CStr::from_ptr(cstr).to_string_lossy().into_owned()
    }
}

unsafe fn true_bool() -> CFRef {
    let n: id = msg_send![class!(NSNumber), numberWithBool: true];
    n as CFRef
}

unsafe fn with_pool<F: FnOnce() -> T, T>(f: F) -> T {
    let pool = NSAutoreleasePool::new(nil);
    let out = f();
    NSAutoreleasePool::drain(pool);
    out
}

fn ax_err_name(code: i32) -> String {
    match code {
        0 => "success".into(),
        -25209 => "attributeUnsupported(该元素不暴露此属性)".into(),
        -25213 => "apiDisabled(辅助功能被禁用)".into(),
        -25214 => "noValue(无选区/无值)".into(),
        _ => format!("err({})——多为未授权或缺辅助功能权限", code),
    }
}

// ---------- 第 0 步：权限 ----------

/// NaYan 自身是否已获「辅助功能」授权
/// options 传 NULL 等价于「只查询、不弹系统提示」（头文档允许）
pub fn ax_trusted() -> bool {
    unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) != 0 }
}

/// 打开系统设置 → 隐私与安全性 → 辅助功能
pub fn open_ax_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

// ---------- 前台应用信息 ----------

pub struct FrontApp {
    pub pid: i32,
    pub name: String,
    pub title: String,
    /// 来源窗口的 CGWindowID（区分同 App 并行的多个窗口；拿不到为 0）
    pub wid: i64,
}

/// 只取前台 App 名（不查窗口标题，剪贴板监听高频用）
pub fn front_app_name() -> String {
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: id = msg_send![ws, frontmostApplication];
        let name = if app == nil {
            String::new()
        } else {
            ns_to_string(msg_send![app, localizedName])
        };
        NSAutoreleasePool::drain(pool);
        name
    }
}

pub fn front_app_info() -> Option<FrontApp> {
    unsafe {
        with_pool(|| {
            let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let app: id = msg_send![ws, frontmostApplication];
            if app == nil {
                return None;
            }
            let pid: i32 = msg_send![app, processIdentifier];
            let name = ns_to_string(msg_send![app, localizedName]);
            if pid <= 0 {
                return None;
            }
            let (title, wid) = main_window(pid);
            Some(FrontApp { pid, name, title, wid })
        })
    }
}

/// 主窗口标题 + CGWindowID（走 AX；读不到标题为空串、拿不到编号为 0）
pub fn main_window(pid: i32) -> (String, i64) {
    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return (String::new(), 0);
        }
        let mut win: CFRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(app_el, ns_str("AXMainWindow") as CFRef, &mut win);
        let out = if err == 0 && !win.is_null() {
            let title = copy_string(win, "AXTitle").unwrap_or_default();
            let mut wid: u32 = 0;
            if _AXUIElementGetWindow(win, &mut wid) == 0 {
                wid = 0;
            }
            (title, wid as i64)
        } else {
            (String::new(), 0)
        };
        if !win.is_null() {
            CFRelease(win);
        }
        CFRelease(app_el);
        out
    }
}

/// 主窗口标题（走 AX；读不到就空串）
pub fn window_title(pid: i32) -> String {
    main_window(pid).0
}

unsafe fn copy_string(el: CFRef, attr: &str) -> Option<String> {
    let mut out: CFRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(el, ns_str(attr) as CFRef, &mut out);
    if err != 0 || out.is_null() {
        return None;
    }
    let s = ns_to_string(out as id);
    CFRelease(out);
    Some(s)
}

// ---------- 划词：AXSelectedText 直读 ----------

fn focused_element(app_el: CFRef) -> Result<CFRef, i32> {
    unsafe {
        let mut out: CFRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(app_el, ns_str("AXFocusedUIElement") as CFRef, &mut out);
        if err != 0 || out.is_null() {
            Err(err)
        } else {
            Ok(out)
        }
    }
}

/// 读取前台 App 当前选中的文字。
/// 返回 Ok("")  = 该 App 的 AX 可用但当前没有选区（快速返回，不重试）；
/// 返回 Err    = AX 通道不可用（调用方降级 ⌘C）。
///
/// Chromium 系（Chrome/Edge/Electron）默认不暴露网页内容，
/// 首次访问需设 AXManualAccessibility=true 并等 AX 树构建（实测 0.6~1.2s，之后秒回）。
pub fn read_selected_text(pid: i32) -> Result<String, String> {
    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return Err("AXUIElementCreateApplication 失败".into());
        }
        // ① 立即读
        match focused_element(app_el) {
            Ok(fel) => {
                let t = copy_string(fel, "AXSelectedText").unwrap_or_default();
                CFRelease(fel);
                CFRelease(app_el);
                return Ok(t);
            }
            Err(first_err) => {
                // ② Chromium 系：开手动辅助功能 → 等树 → 重试一次
                let _ = AXUIElementSetAttributeValue(
                    app_el,
                    ns_str("AXManualAccessibility") as CFRef,
                    true_bool(),
                );
                std::thread::sleep(Duration::from_millis(900));
                let result = match focused_element(app_el) {
                    Ok(fel) => {
                        let t = copy_string(fel, "AXSelectedText").unwrap_or_default();
                        CFRelease(fel);
                        Ok(t)
                    }
                    Err(err) => Err(format!(
                        "AX 焦点元素读取失败：首读 {}（{}），重试 {}（{}）",
                        first_err,
                        ax_err_name(first_err),
                        err,
                        ax_err_name(err)
                    )),
                };
                CFRelease(app_el);
                result
            }
        }
    }
}

// 短的单段选区本来就没有换行；从 200 字起才尝试较慢的结构走查。
const AX_FLAT_SELECTION_MIN_CHARS: usize = 200;

/// 只按文字识别疑似丢失结构的 AX 选区，不按来源应用分叉。
pub fn ax_selection_degraded(t: &str) -> bool {
    t.contains('\u{fffc}')
        || (!t.contains(['\n', '\r']) && t.chars().count() >= AX_FLAT_SELECTION_MIN_CHARS)
}

/// 删除对象占位符；只有紧邻它的完整片段原样重复时才合并。
/// 不把任意后缀/前缀的局部重叠当作重复标题，也不猜换行。
pub fn tidy_ax_selection(t: &str) -> String {
    let mut parts = t.split('\u{fffc}');
    let mut previous = parts.next().unwrap_or_default();
    let mut out = previous.to_string();
    for tail in parts {
        let title = previous.rsplit(['\n', '\r', '。', '！', '？', '；', '：', '!', '?', ';', ':'])
            .next().unwrap_or_default().trim_start();
        let overlap = if title.chars().filter(|c| !c.is_whitespace()).count() >= 2 && tail.starts_with(title) {
            title.len()
        } else { 0 };
        out.push_str(&tail[overlap..]);
        previous = tail;
    }
    out
}

/// 按树序定位唯一的选区首尾；保留原始字符位置以裁剪 UTF-8 文本和样式块。
/// 首尾锚点不唯一或顺序反转时拒绝猜测，调用方回退纯文本。
pub fn slice_blocks_for_selection(blocks: &[RichBlock], selected: &str) -> Option<Vec<RichBlock>> {
    let selected: Vec<char> = tidy_ax_selection(selected).chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{fffc}').collect();
    if selected.is_empty() { return None; }
    let mut ordered: Vec<&RichBlock> = blocks.iter().collect();
    ordered.sort_by_key(|r| r.order);
    let mut text = Vec::new();
    let mut positions = Vec::new();
    for (block, r) in ordered.iter().enumerate() {
        for (byte, c) in r.b.text.char_indices() {
            if !c.is_whitespace() && c != '\u{fffc}' {
                text.push(c);
                positions.push((block, byte, byte + c.len_utf8()));
            }
        }
    }
    fn unique(haystack: &[char], needle: &[char]) -> Option<usize> {
        let mut hits = haystack.windows(needle.len()).enumerate()
            .filter(|(_, chunk)| *chunk == needle).map(|(i, _)| i);
        let first = hits.next()?;
        if hits.next().is_some() { None } else { Some(first) }
    }
    let (start, end) = if selected.len() < 60 {
        let start = unique(&text, &selected)?;
        (start, start + selected.len())
    } else {
        let start = unique(&text, &selected[..30])?;
        let tail = unique(&text, &selected[selected.len() - 30..])?;
        if tail < start + 30 { return None; }
        (start, tail + 30)
    };
    let (first, first_byte, _) = positions[start];
    let (last, _, last_byte) = positions[end - 1];
    let mut sliced: Vec<RichBlock> = ordered[first..=last].iter().map(|r| (*r).clone()).collect();
    for (i, r) in sliced.iter_mut().enumerate() {
        let from = if i == 0 { first_byte } else { 0 };
        let to = if first + i == last { last_byte } else { r.b.text.len() };
        r.b.text = r.b.text[from..to].to_string();
    }
    Some(sliced)
}

// ---------- 兜底：模拟 ⌘C + 剪贴板 ----------

fn pasteboard_change_count() -> i64 {
    unsafe {
        let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
        let c: i64 = msg_send![pb, changeCount];
        c
    }
}

fn post_cmd_c() {
    use core_graphics::event::{CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    fn make_event(kc: u16, keydown: bool) -> Option<core_graphics::event::CGEvent> {
        let src = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        core_graphics::event::CGEvent::new_keyboard_event(src, kc, keydown).ok()
    }
    let kc_c: u16 = 8; // kVK_ANSI_C
    if let Some(down) = make_event(kc_c, true) {
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
    }
    std::thread::sleep(Duration::from_millis(40));
    if let Some(up) = make_event(kc_c, false) {
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        up.post(CGEventTapLocation::HID);
    }
}

/// 保留本次复制的剪贴板内容。恢复旧文本存在 check/write 竞态，也会丢失旧富内容，
/// 因而这里不再写 general pasteboard，避免覆盖用户在等待期间的新复制。
pub fn simulate_copy_text() -> Result<(String, Option<String>), String> {
    CLIP_SUPPRESS_UNTIL.store(now_ms() + 4000, std::sync::atomic::Ordering::Relaxed);
    let before_count = pasteboard_change_count();
    post_cmd_c();
    let deadline = std::time::Instant::now() + Duration::from_millis(1200);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(80));
        if pasteboard_change_count() > before_count {
            if let Ok(snap) = clipboard_snapshot_now() {
                return Ok((snap.text, snap.html));
            }
        }
    }
    Err("⌘C 后未取得稳定文本（目标 App 可能不支持复制）".into())
}

/// HTML 味觉可用性守卫：非空、形如 HTML、未超信封字符上限（超出则退回纯文本如实收录）。
fn usable_clip_html(h: &str) -> bool {
    let t = h.trim();
    !t.is_empty() && t.chars().count() <= 90_000 && t.contains('<')
}

/// 读取当前剪贴板 (纯文本, HTML 味觉)——剪贴板类采集通道共用的适配层入口。
/// 只报告粘贴板上确实存在的数据；HTML 同样过 usable 守卫。
#[derive(Clone, Debug)]
pub struct ClipboardSnapshot {
    pub generation: i64,
    pub text: String,
    pub html: Option<String>,
}

fn bind_clipboard_snapshot(before: i64, after: i64, items: usize, text: Option<String>, html: Option<String>) -> Result<ClipboardSnapshot, String> {
    if before != after || items != 1 {
        return Err("剪贴板在读取中变化或含多个项目，请重新复制".into());
    }
    let text = text.filter(|t| !t.trim().is_empty()).ok_or("剪贴板没有文本")?;
    Ok(ClipboardSnapshot { generation: before, text, html: html.filter(|h| usable_clip_html(h)) })
}

/// NSPasteboardItem 是可变系统对象；仅在本次读取期间引用，前后核代次，
/// 把同一个 item 的两种 flavor 立即复制成自有 String，不跨 HUD 等待持有它。
pub fn clipboard_snapshot_now() -> Result<ClipboardSnapshot, String> {
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
            let before: i64 = msg_send![pb, changeCount];
            let items: id = msg_send![pb, pasteboardItems];
            let count: usize = if items == nil { 0 } else { msg_send![items, count] };
            if count != 1 { return Err("剪贴板项目不唯一，请复制一段文本".into()); }
            let item: id = msg_send![items, objectAtIndex:0usize];
            let read = |flavor: &str| -> Option<String> {
                let value: id = msg_send![item, stringForType:ns_str(flavor)];
                if value == nil { return None; }
                let ptr = NSString::UTF8String(value);
                let len: usize = msg_send![value, lengthOfBytesUsingEncoding:4usize];
                if ptr.is_null() { return None; }
                String::from_utf8(std::slice::from_raw_parts(ptr.cast::<u8>(), len).to_vec()).ok()
            };
            let text = read("public.utf8-plain-text");
            let html = read("public.html");
            let after: i64 = msg_send![pb, changeCount];
            bind_clipboard_snapshot(before, after, count, text, html)
        })();
        NSAutoreleasePool::drain(pool);
        result
    }
}

#[cfg(test)]
mod clipboard_snapshot_tests {
    use super::*;
    #[test]
    fn clipboard_snapshot_generation_and_verbatim() {
        let s = bind_clipboard_snapshot(4,4,1,Some("  x\r\n ".into()),Some("<pre>x</pre>".into())).unwrap();
        assert_eq!(s.text,"  x\r\n "); assert_eq!(s.generation,4); assert!(s.html.is_some());
        assert!(bind_clipboard_snapshot(4,5,1,Some("same".into()),Some("<b>new</b>".into())).is_err());
        for count in [0,2] { assert!(bind_clipboard_snapshot(4,4,count,Some("x".into()),None).is_err()); }
        assert!(bind_clipboard_snapshot(4,4,1,None,None).is_err());
        assert!(bind_clipboard_snapshot(4,4,1,Some(" \n".into()),None).is_err());
        assert!(bind_clipboard_snapshot(4,4,1,Some("x".into()),None).unwrap().html.is_none());
        assert!(bind_clipboard_snapshot(4,4,1,Some("x".into()),Some(format!("<p>{}</p>","x".repeat(90001)))).unwrap().html.is_none());
        let a=bind_clipboard_snapshot(4,4,1,Some("same".into()),Some("<b>same</b>".into())).unwrap();
        let b=bind_clipboard_snapshot(5,5,1,Some("same".into()),Some("<i>same</i>".into())).unwrap();
        assert_ne!(a.generation,b.generation); assert_ne!(a.html,b.html);
    }
}

// ---------- 工作区解析（从 HS init.lua 的 resolveWorkspace 移植，行为对齐） ----------

pub fn resolve_workspace(win_title: &str) -> String {
    if win_title.is_empty() {
        return String::new();
    }
    let name = win_title.rsplit('|').next().unwrap_or(win_title).trim();
    if name.is_empty() || name.chars().count() > 60 {
        return String::new();
    }
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return String::new(),
    };
    for root in ["Documents", "Desktop", "Projects", "workspaces"] {
        let out = std::process::Command::new("find")
            .arg(format!("{}/{}", home, root))
            .arg("-maxdepth")
            .arg("4")
            .arg("-type")
            .arg("d")
            .arg("-name")
            .arg(name)
            .output();
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout);
            if let Some(first) = s.lines().next() {
                let first = first.trim();
                if !first.is_empty() {
                    return first.to_string();
                }
            }
        }
    }
    String::new()
}

// ---------- 回到来源窗口（AX Raise） ----------

/// 激活来源 App 并提升其窗口（标题模糊匹配；找不到精确窗口时提升主窗口）
pub fn raise_source_window(app_name: &str, title: &str) -> bool {
    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let out = raise_impl(app_name, title);
        NSAutoreleasePool::drain(pool);
        out
    }
}

unsafe fn raise_impl(app_name: &str, title: &str) -> bool {
    use cocoa::base::id;
    // ① 找到目标 App（名字互含模糊匹配）
    let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
    let apps: id = msg_send![ws, runningApplications];
    let n: usize = msg_send![apps, count];
    let mut target: id = nil;
    for i in 0..n {
        let a: id = msg_send![apps, objectAtIndexedSubscript: i as u64];
        let policy: i64 = msg_send![a, activationPolicy];
        if policy != 0 { continue; } // 只要常规 App
        let nm = ns_to_string(msg_send![a, localizedName]);
        if nm == app_name || nm.contains(app_name) || (!nm.is_empty() && app_name.contains(&nm)) {
            target = a;
            break;
        }
    }
    if target == nil {
        return false;
    }
    let pid: i32 = msg_send![target, processIdentifier];
    // ② 激活 App（NSRunningApplication 的方法；注意 activateIgnoringOtherApps 是 NSApplication 的，发错对象会抛异常）
    let _: () = msg_send![target, activateWithOptions: 0u64];
    // ③ AX 提升窗口：优先精确标题，否则主窗口兜底
    let app_el = AXUIElementCreateApplication(pid);
    if app_el.is_null() {
        return false;
    }
    let mut target_win: CFRef = std::ptr::null();
    let mut windows: CFRef = std::ptr::null();
    let werr = AXUIElementCopyAttributeValue(app_el, ns_str("AXWindows") as CFRef, &mut windows);
    if werr == 0 && !windows.is_null() {
        let cnt = CFArrayGetCount(windows);
        // 第一轮：标题匹配的窗口
        for i in 0..cnt {
            let w = CFArrayGetValueAtIndex(windows, i);
            if w.is_null() { continue; }
            let wt = copy_string(w, "AXTitle").unwrap_or_default();
            if !title.is_empty()
                && (wt == title || wt.contains(title) || (!wt.is_empty() && title.contains(&wt)))
            {
                target_win = CFRetain(w);
                break;
            }
        }
        // 兜底：非桌面的第一个窗口（桌面的 AXRaise 会返回失败）
        if target_win.is_null() {
            for i in 0..cnt {
                let w = CFArrayGetValueAtIndex(windows, i);
                if w.is_null() { continue; }
                let role = copy_string(w, "AXRole").unwrap_or_default();
                if role != "AXDesktop" {
                    target_win = CFRetain(w);
                    break;
                }
            }
        }
        CFRelease(windows);
    }
    if !target_win.is_null() {
        let st = AXUIElementPerformAction(target_win, ns_str("AXRaise") as CFRef);
        if st != 0 {
            eprintln!("[回源] AXRaise code={}", st);
        }
        CFRelease(target_win);
    }
    // App 激活本身已把窗口带到前台
    true
}

// ---------- 框选：AX 文本块走查（对应 HS boxHarvest / Wispal 候选采集） ----------

/// 文本块（屏幕坐标，单位=点；走查后由调用方换算成 overlay 局部坐标）
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct TextBlock {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub text: String,
}

// 实测（2026-10-10，前台走查）：Electron/Chromium 网页正文在 AX 树 35~42 层，
// 旧上限 20 层把 Claude/ChatGPT/ZCode/Chrome 的正文整片剪掉（误判为「不暴露 AX」）。
// 80 层下 Chrome 长对话约 4.5k 节点 / 0.3s；另设时间预算兜底超大界面。
const NODE_CAP: usize = 15000;
const BLOCK_CAP: usize = 4000;
const DEPTH_CAP: usize = 80;
const WALK_BUDGET: Duration = Duration::from_millis(1500);

#[repr(C)]
struct AxPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
struct AxSize {
    w: f64,
    h: f64,
}

unsafe fn ax_point(el: CFRef, attr: &str) -> Option<(f64, f64)> {
    let mut out: CFRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(el, ns_str(attr) as CFRef, &mut out);
    if err != 0 || out.is_null() {
        return None;
    }
    let t = AXValueGetType(out); // 1 = CGPoint, 2 = CGSize
    let mut p = AxPoint { x: 0.0, y: 0.0 };
    let ok = t == 1 && AXValueGetValue(out, 1, &mut p as *mut AxPoint as *mut c_void) != 0;
    CFRelease(out);
    if ok {
        Some((p.x, p.y))
    } else {
        None
    }
}

unsafe fn ax_size(el: CFRef) -> Option<(f64, f64)> {
    let mut out: CFRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(el, ns_str("AXSize") as CFRef, &mut out);
    if err != 0 || out.is_null() {
        return None;
    }
    let t = AXValueGetType(out);
    let mut s = AxSize { w: 0.0, h: 0.0 };
    let ok = t == 2 && AXValueGetValue(out, 2, &mut s as *mut AxSize as *mut c_void) != 0;
    CFRelease(out);
    if ok {
        Some((s.w, s.h))
    } else {
        None
    }
}

/// 带结构的文本块：几何（给 overlay 求交）+ 界面结构（给 Markdown 还原）。
/// 结构取自 AX 树（实测 2026-10-10 Claude/Chromium）：加粗=AXStrongStyleGroup、
/// 代码=AXCodeStyleGroup、列表=AXList+AXListMarker、标题=AXHeading(AXValue=级别)、
/// 表格=AXTable/AXRow/AXCell、链接=AXLink(AXURL)；sr-only 读屏副本必须剔除。
#[derive(Clone, Debug, Default)]
pub struct RichBlock {
    pub b: TextBlock,
    /// 树序（=阅读顺序）
    pub order: u32,
    /// 所属块级元素编号（同一段落/列表项/单元格/代码行的碎块共享）
    pub block: u32,
    pub kind: BlockKind,
    /// 行内样式位：1=加粗 2=斜体 4=行内代码
    pub inline: u8,
    pub link: Option<String>,
    /// 所在代码块（AXCodeStyleGroup 包住块级元素）编号，0=不在代码块
    pub pre: u32,
    pub list: u32,
    pub list_depth: u8,
    pub table: u32,
    pub row: u32,
    pub cell: u32,
    /// 位于网页区域（AXWebArea）内：结构可信，走 Markdown 还原
    pub web: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum BlockKind {
    #[default]
    Para,
    Heading(u8),
    ListItem,
    Cell,
}

#[derive(Clone, Default)]
struct Ctx {
    block: u32,
    kind: BlockKind,
    inline: u8,
    link: Option<String>,
    code_group: u32,
    pre: u32,
    list: u32,
    list_depth: u8,
    table: u32,
    row: u32,
    cell: u32,
    web: bool,
    /// 当前元素本身是 AXList（其直接子组即列表项）
    at_list: bool,
}

struct WalkState {
    nodes: usize,
    order: u32,
    blocks: Vec<RichBlock>,
    deadline: std::time::Instant,
}

impl WalkState {
    fn exhausted(&self) -> bool {
        self.nodes > NODE_CAP || self.blocks.len() > BLOCK_CAP || std::time::Instant::now() > self.deadline
    }
}

/// 属性值若是字符串则取出（类型不符返回 None，避免把 NSNumber/NSURL 当字符串读崩）
unsafe fn copy_typed_string(el: CFRef, attr: &str) -> Option<String> {
    let mut out: CFRef = std::ptr::null();
    if AXUIElementCopyAttributeValue(el, ns_str(attr) as CFRef, &mut out) != 0 || out.is_null() {
        return None;
    }
    let s = if CFGetTypeID(out) == CFStringGetTypeID() { Some(ns_to_string(out as id)) } else { None };
    CFRelease(out);
    s
}

unsafe fn heading_level(el: CFRef) -> u8 {
    let mut out: CFRef = std::ptr::null();
    if AXUIElementCopyAttributeValue(el, ns_str("AXValue") as CFRef, &mut out) != 0 || out.is_null() {
        return 2;
    }
    let is_num: bool = msg_send![out as id, isKindOfClass: class!(NSNumber)];
    let lv: i64 = if is_num { msg_send![out as id, integerValue] } else { 2 };
    CFRelease(out);
    lv.clamp(1, 6) as u8
}

unsafe fn link_url(el: CFRef) -> Option<String> {
    let mut out: CFRef = std::ptr::null();
    if AXUIElementCopyAttributeValue(el, ns_str("AXURL") as CFRef, &mut out) != 0 || out.is_null() {
        return None;
    }
    let is_url: bool = msg_send![out as id, isKindOfClass: class!(NSURL)];
    let s = if is_url { Some(ns_to_string(msg_send![out as id, absoluteString])) } else { None };
    CFRelease(out);
    s.filter(|u| u.starts_with("http://") || u.starts_with("https://"))
}

/// 读屏专用隐藏副本（Tailwind sr-only / visually-hidden）：屏幕上看不见，收进来就是重复文字
unsafe fn is_screen_reader_only(el: CFRef) -> bool {
    let mut out: CFRef = std::ptr::null();
    if AXUIElementCopyAttributeValue(el, ns_str("AXDOMClassList") as CFRef, &mut out) != 0 || out.is_null() {
        return false;
    }
    let mut hit = false;
    if CFGetTypeID(out) != CFStringGetTypeID() {
        let n = CFArrayGetCount(out);
        for i in 0..n {
            let v = CFArrayGetValueAtIndex(out, i);
            if !v.is_null() && CFGetTypeID(v) == CFStringGetTypeID() {
                let c = ns_to_string(v as id);
                if c == "sr-only" || c == "visually-hidden" || c == "screen-reader-only" {
                    hit = true;
                    break;
                }
            }
        }
    }
    CFRelease(out);
    hit
}

unsafe fn walk(el: CFRef, depth: usize, ctx: &Ctx, st: &mut WalkState) {
    if depth > DEPTH_CAP || st.exhausted() {
        return;
    }
    st.nodes += 1;
    let me = st.nodes as u32;
    let role = copy_typed_string(el, "AXRole").unwrap_or_default();
    // 菜单类是瞬态 UI，永远不是框选目标，整棵剪掉省几千个节点
    if role == "AXMenu" || role == "AXMenuItem" || role == "AXMenuBar" {
        return;
    }
    let mut c = ctx.clone();
    let subrole = if role == "AXGroup" { copy_typed_string(el, "AXSubrole").unwrap_or_default() } else { String::new() };
    if c.web && role == "AXGroup" && is_screen_reader_only(el) {
        return;
    }
    let mut inline_like = matches!(role.as_str(), "AXStaticText" | "AXListMarker" | "AXLink");
    match role.as_str() {
        "AXWebArea" => c.web = true,
        "AXHeading" => { c.block = me; c.kind = BlockKind::Heading(heading_level(el)); inline_like = true; }
        "AXList" => { c.list = me; c.list_depth = c.list_depth.saturating_add(1); }
        "AXTable" => c.table = me,
        "AXRow" => c.row = me,
        "AXCell" => { c.cell = me; c.block = me; c.kind = BlockKind::Cell; inline_like = true; }
        "AXLink" => c.link = link_url(el),
        _ => {}
    }
    match subrole.as_str() {
        "AXStrongStyleGroup" => { c.inline |= 1; inline_like = true; }
        "AXEmphasisStyleGroup" => { c.inline |= 2; inline_like = true; }
        "AXCodeStyleGroup" => { c.inline |= 4; c.code_group = me; inline_like = true; }
        _ => {}
    }
    // 非行内元素 = 新的块级容器：段落、列表的直接子组=列表项、代码块里的行……
    // 列表项、单元格内部的段落不再拆块（标记与正文同属一项）；嵌套列表另起。
    let structural = matches!(role.as_str(), "AXWebArea" | "AXList" | "AXTable" | "AXRow");
    if !inline_like && !structural {
        let inside_item = ctx.kind == BlockKind::ListItem && ctx.list == c.list && ctx.block != 0;
        let inside_cell = c.cell != 0 && c.block == c.cell;
        if !inside_item && !inside_cell {
            c.block = me;
            c.kind = if ctx.at_list { BlockKind::ListItem } else { BlockKind::Para };
        }
    }
    c.at_list = role == "AXList";
    // 代码组包住了块级元素 → 这是代码块，不是行内代码
    if !inline_like && c.inline & 4 != 0 {
        c.inline &= !4;
        c.pre = c.code_group;
    }
    // 文本判定：AXValue 是字符串（文本角色与含字符串值的通用元素都算）
    if role != "AXHeading" {
        if let Some(text) = copy_typed_string(el, "AXValue") {
            let marker = role == "AXListMarker";
            if !text.trim().is_empty() || (marker && !text.is_empty()) {
                if let (Some((x, y)), Some((w, h))) = (ax_point(el, "AXPosition"), ax_size(el)) {
                    // 列表符号（• / 1.）可能很窄，放行；其余沿用最小尺寸过滤噪点
                    if marker || (w >= 14.0 && h >= 6.0) {
                        st.order += 1;
                        st.blocks.push(RichBlock {
                            b: TextBlock { x, y, w, h, text },
                            order: st.order,
                            block: c.block,
                            kind: c.kind,
                            inline: c.inline,
                            link: c.link.clone(),
                            pre: c.pre,
                            list: c.list,
                            list_depth: c.list_depth,
                            table: c.table,
                            row: c.row,
                            cell: c.cell,
                            web: c.web,
                        });
                    }
                }
            }
        }
    }
    let mut kids: CFRef = std::ptr::null();
    let kerr = AXUIElementCopyAttributeValue(el, ns_str("AXChildren") as CFRef, &mut kids);
    if kerr == 0 && !kids.is_null() {
        let n = CFArrayGetCount(kids);
        for i in 0..n {
            let child = CFArrayGetValueAtIndex(kids, i);
            if !child.is_null() {
                walk(child, depth + 1, &c, st);
            }
            if st.exhausted() {
                break;
            }
        }
        CFRelease(kids);
    }
}

/// 走查目标 App 的全部文本块（屏幕坐标，带界面结构）。
/// Chromium 系（Chrome/Electron）首次开 AX 后建树要 1~2 秒：最多三轮
/// （600ms / +1.2s / +1.5s），取块数最多的一轮；部分 Electron 还需
/// AXEnhancedUserInterface 属性才肯暴露内容。
pub fn harvest_text_blocks(pid: i32) -> Vec<RichBlock> {
    let mut best = harvest_once(pid, 600);
    let waits = [1200u64, 1500u64];
    for w in waits {
        if best.len() >= 8 {
            return best;
        }
        crate::log_line(&format!(
            "[框选] 首轮仅 {} 块（AX 建树中），{}ms 后重采",
            best.len(), w
        ));
        let again = harvest_once(pid, w);
        if again.len() > best.len() {
            best = again;
        }
    }
    best
}

fn harvest_once(pid: i32, warmup_ms: u64) -> Vec<RichBlock> {
    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return vec![];
        }
        let _ = AXUIElementSetAttributeValue(
            app_el,
            ns_str("AXManualAccessibility") as CFRef,
            true_bool(),
        );
        let _ = AXUIElementSetAttributeValue(
            app_el,
            ns_str("AXEnhancedUserInterface") as CFRef,
            true_bool(),
        );
        if warmup_ms > 0 {
            std::thread::sleep(Duration::from_millis(warmup_ms));
        }
        let mut st = WalkState {
            nodes: 0,
            order: 0,
            blocks: vec![],
            deadline: std::time::Instant::now() + WALK_BUDGET,
        };
        with_pool(|| walk(app_el, 0, &Ctx::default(), &mut st));
        CFRelease(app_el);
        if st.exhausted() {
            crate::log_line(&format!("[框选] AX 走查触顶：{} 节点 / {} 块", st.nodes, st.blocks.len()));
        }
        st.blocks
    }
}

/// 已完成首次建树后的即时走查；R07 技术验证用于量测实际滚动位移。
pub fn harvest_text_blocks_now(pid: i32) -> Vec<RichBlock> {
    harvest_once(pid, 0)
}

// ---------- 框选：界面结构 → Markdown ----------

fn md_inline(r: &RichBlock) -> String {
    let t = &r.b.text;
    if r.pre != 0 {
        return t.clone();
    }
    // 行内标记要贴着文字：前后空白挪到标记外，否则 Markdown 不认
    let core = t.trim();
    if core.is_empty() {
        return t.clone();
    }
    let lead = &t[..t.len() - t.trim_start().len()];
    let trail = &t[t.trim_end().len()..];
    let mut m = core.replace('\n', " ");
    if r.inline & 4 != 0 {
        m = format!("`{}`", m);
    }
    if r.inline & 1 != 0 {
        m = format!("**{}**", m);
    }
    if r.inline & 2 != 0 {
        m = format!("*{}*", m);
    }
    if let Some(u) = &r.link {
        m = format!("[{}]({})", m, u);
    }
    format!("{}{}{}", lead, m, trail)
}

fn list_marker(text: &str) -> String {
    let t = text.trim();
    if t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        let n: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
        format!("{}. ", n)
    } else {
        "- ".into()
    }
}

/// 把命中块按树序还原为 Markdown：段落/标题/列表/代码块/表格 + 加粗/斜体/行内代码/链接。
pub fn compose_markdown(mut rs: Vec<RichBlock>) -> String {
    rs.sort_by_key(|r| r.order);
    // 1) 碎块按块级元素聚合（树序相邻且 block 相同）
    struct Blk { kind: BlockKind, pre: u32, list: u32, depth: u8, table: u32, row: u32, cell: u32, marker: String, text: String }
    let mut blks: Vec<Blk> = vec![];
    let mut last_block = u32::MAX;
    for r in &rs {
        let is_marker = r.kind == BlockKind::ListItem && r.inline == 0 && r.link.is_none()
            && { let t = r.b.text.trim(); !t.is_empty() && t.chars().count() <= 4
                && (t.trim_end_matches(['.', ')', '、']).chars().all(|c| c.is_ascii_digit()) || matches!(t, "•" | "◦" | "▪" | "-" | "*" | "·")) };
        if r.block != last_block || blks.is_empty() {
            blks.push(Blk { kind: r.kind, pre: r.pre, list: r.list, depth: r.list_depth, table: r.table, row: r.row, cell: r.cell, marker: String::new(), text: String::new() });
            last_block = r.block;
        }
        let cur = blks.last_mut().unwrap();
        if is_marker && cur.text.trim().is_empty() && cur.marker.is_empty() {
            cur.marker = list_marker(&r.b.text);
        } else {
            cur.text.push_str(&md_inline(r));
        }
    }
    // 2) 按块类型输出；代码块、表格、同一列表的连续块需要整体处理
    let mut out: Vec<String> = vec![];
    let mut i = 0;
    while i < blks.len() {
        let b = &blks[i];
        if b.pre != 0 {
            let mut lines = vec![];
            while i < blks.len() && blks[i].pre == b.pre {
                lines.push(blks[i].text.trim_end_matches('\n').to_string());
                i += 1;
            }
            out.push(format!("```\n{}\n```", lines.join("\n")));
            continue;
        }
        if b.table != 0 && b.cell != 0 {
            let table = b.table;
            let mut rows: Vec<(u32, Vec<String>)> = vec![];
            let mut last_cell = 0;
            while i < blks.len() && blks[i].table == table {
                let x = &blks[i];
                let cell = x.text.trim().replace('\n', " ").replace('|', "\\|");
                if rows.last().map(|r| r.0) != Some(x.row) {
                    rows.push((x.row, vec![]));
                    last_cell = 0;
                }
                let row = &mut rows.last_mut().unwrap().1;
                if x.cell == last_cell && !row.is_empty() {
                    let l = row.last_mut().unwrap();
                    l.push(' ');
                    l.push_str(&cell);
                } else {
                    row.push(cell);
                }
                last_cell = x.cell;
                i += 1;
            }
            let cols = rows.iter().map(|r| r.1.len()).max().unwrap_or(1).max(1);
            let mut t = vec![];
            for (ri, (_, cells)) in rows.iter().enumerate() {
                let mut c = cells.clone();
                c.resize(cols, String::new());
                t.push(format!("| {} |", c.join(" | ")));
                if ri == 0 {
                    t.push(format!("|{}", " --- |".repeat(cols)));
                }
            }
            out.push(t.join("\n"));
            continue;
        }
        let text = b.text.trim().to_string();
        if text.is_empty() && b.marker.is_empty() {
            i += 1;
            continue;
        }
        let line = match b.kind {
            BlockKind::Heading(lv) => format!("{} {}", "#".repeat(lv as usize), text),
            BlockKind::ListItem => {
                let indent = "   ".repeat(b.depth.saturating_sub(1) as usize);
                let m = if b.marker.is_empty() { "- ".to_string() } else { b.marker.clone() };
                format!("{}{}{}", indent, m, text)
            }
            _ => text,
        };
        // 同一列表的相邻项只换一行；同一列表项的续段缩进接在后面
        let same_list = i > 0 && b.list != 0 && blks[i - 1].list != 0 && blks[i - 1].pre == 0
            && (blks[i - 1].list == b.list || blks[i - 1].depth != b.depth)
            && matches!(b.kind, BlockKind::ListItem);
        if same_list && !out.is_empty() {
            let l = out.last_mut().unwrap();
            l.push('\n');
            l.push_str(&line);
        } else {
            out.push(line);
        }
        i += 1;
    }
    out.join("\n\n").trim().to_string()
}

// ---------- 框选：段落重组（HS boxCompose 的 Rust 移植） ----------

fn is_cjk(c: char) -> bool {
    // UTF-8 中文 3 字节，首字节 ≥ 0xE0 覆盖 CJK 与全角标点（与 HS 版同一启发式）
    let b = c as u32;
    b >= 0x2E80
}

fn glue(a: &str, b: &str) -> String {
    if a.is_empty() {
        return b.to_string();
    }
    if b.is_empty() {
        return a.to_string();
    }
    let a_cjk = a.chars().last().map(is_cjk).unwrap_or(false);
    let b_cjk = b.chars().next().map(is_cjk).unwrap_or(false);
    if a_cjk && b_cjk {
        format!("{}{}", a, b)
    } else {
        format!("{} {}", a, b)
    }
}

/// 表格重构：命中块按屏幕坐标聚类成网格（列=x 起点聚类、行=y 中心聚类），
/// 满足 ≥2 列 × ≥2 个多格行且 ≥70% 块落格时输出 Markdown 表格；否则 None（调用方回退 compose_text）。
/// 局限：合并单元格/跨行列无法感知；表头恒取首行（详情页可编辑兜底）。
pub fn compose_table(blocks: &[TextBlock]) -> Option<String> {
    if blocks.len() < 4 {
        return None;
    }
    // 行高中位数 → 行聚类容差
    let mut hs: Vec<f64> = blocks.iter().map(|b| b.h).filter(|h| *h > 1.0).collect();
    if hs.is_empty() {
        return None;
    }
    hs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let med_h = hs[hs.len() / 2];
    let row_tol = (med_h * 0.6).max(4.0);

    // 按 y 中心排序后聚成视觉行
    let mut sorted: Vec<&TextBlock> = blocks.iter().collect();
    sorted.sort_by(|a, b| {
        let ya = a.y + a.h / 2.0;
        let yb = b.y + b.h / 2.0;
        ya.partial_cmp(&yb).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut vis_rows: Vec<Vec<&TextBlock>> = vec![];
    for b in &sorted {
        let yc = b.y + b.h / 2.0;
        match vis_rows.last_mut() {
            Some(r) => {
                let rc = r.iter().map(|x| x.y + x.h / 2.0).sum::<f64>() / r.len() as f64;
                if (yc - rc).abs() <= row_tol {
                    r.push(b);
                } else {
                    vis_rows.push(vec![b]);
                }
            }
            None => vis_rows.push(vec![b]),
        }
    }

    // 列聚类：x 起点排序，间距 >12px 即新列
    let mut xs: Vec<f64> = sorted.iter().map(|b| b.x).collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut col_starts: Vec<f64> = vec![];
    for x in xs {
        if col_starts.last().map_or(true, |c| x - c > 12.0) {
            col_starts.push(x);
        }
    }
    if col_starts.len() < 2 {
        return None;
    }
    let col_of = |x: f64| -> usize {
        col_starts
            .iter()
            .enumerate()
            .min_by(|a, b| {
                (x - a.1)
                    .abs()
                    .partial_cmp(&(x - b.1).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap()
            .0
    };

    // 每个视觉行 → 列槽（同槽冲突保留面积大者）
    let ncols = col_starts.len();
    let mut grid_rows: Vec<Vec<Option<&TextBlock>>> = vec![];
    for r in &vis_rows {
        let mut cells: Vec<Option<&TextBlock>> = vec![None; ncols];
        for b in r {
            let c = col_of(b.x);
            let replace = match cells[c] {
                None => true,
                Some(old) => old.w * old.h < b.w * b.h,
            };
            if replace {
                cells[c] = Some(b);
            }
        }
        grid_rows.push(cells);
    }

    // 资格判定：≥2 个多格行，且 ≥70% 块落在多格行里
    let multi: Vec<&Vec<Option<&TextBlock>>> =
        grid_rows.iter().filter(|r| r.iter().filter(|c| c.is_some()).count() >= 2).collect();
    if multi.len() < 2 {
        return None;
    }
    let in_multi: usize = multi.iter().map(|r| r.iter().filter(|c| c.is_some()).count()).sum();
    if (in_multi as f64) < sorted.len() as f64 * 0.7 {
        return None;
    }

    // 输出：网格外的小块（题注等）按 y 排在表格外
    let mut md: Vec<String> = vec![];
    let sep: String = std::iter::repeat("---".to_string()).take(ncols).collect::<Vec<_>>().join(" | ");
    let mut header_done = false;
    let mut stray: Vec<&TextBlock> = vec![];
    for r in &grid_rows {
        let n = r.iter().filter(|c| c.is_some()).count();
        if n >= 2 {
            let cells: Vec<String> = (0..ncols)
                .map(|i| r[i].map(|b| b.text.replace('|', "\\|")).unwrap_or_default())
                .collect();
            md.push(format!("| {} |", cells.join(" | ")));
            if !header_done {
                md.push(format!("| {} |", sep));
                header_done = true;
            }
        } else {
            for c in r.iter().flatten() {
                stray.push(c);
            }
        }
    }
    let mut stray = stray;
    stray.sort_by(|a, b| {
        let ya = a.y + a.h / 2.0;
        let yb = b.y + b.h / 2.0;
        ya.partial_cmp(&yb).unwrap_or(std::cmp::Ordering::Equal)
    });
    let stray_text: Vec<String> = stray.iter().map(|b| b.text.clone()).collect();
    let table = md.join("\n");
    if stray_text.is_empty() {
        Some(table)
    } else {
        Some(format!("{}\n{}", stray_text.join("\n"), table))
    }
}

/// 把命中块重组为可读文本：Chrome 把网页文本按渲染行逐个暴露（逗号都可能独立成块），
/// 需要 ① 同行（|Δy|≤5px）按 x 排序合并 ② 行距 ≤0.75×行高判同段续行 ③ 中英混排补空格。
pub fn compose_text(mut blocks: Vec<TextBlock>) -> String {
    // y 升序（8px 容差内按 x），与命中时序无关
    blocks.sort_by(|a, b| {
        if (a.y - b.y).abs() < 8.0 {
            a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal)
        }
    });

    // ① 行合并（anchor_y = 行首块 y，不随后续块更新——与 HS 版一致）
    struct Row {
        anchor_y: f64,
        y0: f64,
        y1: f64,
        h: f64,
        text: String,
    }
    let mut raw_rows: Vec<Vec<TextBlock>> = vec![];
    for b in &blocks {
        match raw_rows.last_mut() {
            Some(r) if (b.y - r[0].y).abs() <= 5.0 => r.push(b.clone()),
            _ => raw_rows.push(vec![b.clone()]),
        }
    }
    let mut rows: Vec<Row> = vec![];
    for parts in &raw_rows {
        let mut parts = parts.clone();
        parts.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
        let mut line = String::new();
        for p in &parts {
            if line.is_empty() || !line.contains(&p.text) {
                line = glue(&line, &p.text);
            }
        }
        let y0 = parts.iter().map(|p| p.y).fold(f64::MAX, f64::min);
        let y1 = parts.iter().map(|p| p.y + p.h).fold(f64::MIN, f64::max);
        let h = parts.iter().map(|p| p.h).fold(f64::MIN, f64::max);
        rows.push(Row {
            anchor_y: parts[0].y,
            y0,
            y1,
            h,
            text: line,
        });
    }

    // ② 段落重组：间隙 ≤ max(6, 行高×0.75) 视为同段续行
    let mut out: Vec<String> = vec![];
    let mut prev: Option<Row> = None;
    for r in rows {
        match prev.take() {
            None => prev = Some(r),
            Some(mut p) => {
                let gap = r.y0 - p.y1;
                if gap <= (p.h * 0.75).max(6.0) {
                    p.text = glue(&p.text, &r.text);
                    p.y1 = r.y1;
                    p.h = p.h.max(r.y1 - p.y0);
                    prev = Some(p);
                } else {
                    out.push(p.text);
                    prev = Some(r);
                }
            }
        }
    }
    if let Some(p) = prev {
        out.push(p.text);
    }
    out.join("\n")
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    fn r(order: u32, text: &str) -> RichBlock {
        RichBlock { b: TextBlock { text: text.into(), ..Default::default() },
            order, block: order, web: true, ..Default::default() }
    }

    #[test]
    fn degraded_uses_characters_and_preserves_short_and_multiline_selections() {
        assert!(ax_selection_degraded("短句\u{fffc}"));
        assert!(ax_selection_degraded(&"字".repeat(250)));
        assert!(ax_selection_degraded(&"字".repeat(200)));
        assert!(!ax_selection_degraded(&"字".repeat(199)));
        assert!(!ax_selection_degraded(&"字".repeat(50)));
        for sep in ['\n', '\r'] {
            assert!(!ax_selection_degraded(&format!("{}{}", "字".repeat(250), sep)));
        }
        assert!(!ax_selection_degraded(""));
    }

    #[test]
    fn tidy_complete_title_without_erasing_partial_overlap_or_whitespace() {
        assert_eq!(tidy_ax_selection("已运行 2 个命令\u{fffc}已运行 2 个命令清理"), "已运行 2 个命令清理");
        assert_eq!(tidy_ax_selection("正文：已运行 2 个命令\u{fffc}已运行 2 个命令清理"), "正文：已运行 2 个命令清理");
        assert_eq!(tidy_ax_selection("甲a\u{fffc}abc"), "甲aabc");
        assert_eq!(tidy_ax_selection("海\u{fffc}海边"), "海海边");
        assert_eq!(tidy_ax_selection("上文 \u{fffc} 下文"), "上文  下文");
        assert_eq!(tidy_ax_selection("\u{fffc}"), "");
        assert_eq!(tidy_ax_selection("前\u{fffc}后"), "前后");
        assert_eq!(tidy_ax_selection("• 项目。• 项目。\n`代码`"), "• 项目。• 项目。\n`代码`");
    }

    #[test]
    fn slices_first_and_last_blocks_in_tree_order_with_unicode_offsets() {
        let blocks = vec![r(4, "结束🦀后文"), r(1, "不选"), r(3, "中 间"), r(2, "前文起点")];
        let sel = slice_blocks_for_selection(&blocks, "起点 中间 结束🦀").unwrap();
        assert_eq!(sel.iter().map(|b| b.b.text.as_str()).collect::<Vec<_>>(), ["起点", "中 间", "结束🦀"]);
        assert_eq!(sel.iter().map(|b| b.order).collect::<Vec<_>>(), [2, 3, 4]);
    }

    #[test]
    fn slices_one_block_without_expanding_to_whole_paragraph() {
        let sel = slice_blocks_for_selection(&[r(1, "前缀单块片段后缀")], "单块片段").unwrap();
        assert_eq!(sel.len(), 1);
        assert_eq!(sel[0].b.text, "单块片段");
        assert!(slice_blocks_for_selection(&[r(1, "其他")], "单块片段").is_none());
        assert!(slice_blocks_for_selection(&[], "单块片段").is_none());
        assert!(slice_blocks_for_selection(&[r(1, "其他")], " \u{fffc}\n").is_none());
    }

    #[test]
    fn short_selection_must_be_unique() {
        assert!(slice_blocks_for_selection(&[r(1, "重复片段"), r(2, "重复片段")], "重复片段").is_none());
    }

    #[test]
    fn long_selection_uses_unique_anchors_and_tolerates_extra_control_title_in_middle() {
        let head = "开头锚点".repeat(8);
        let tail = "末尾锚点".repeat(8);
        let blocks = vec![r(1, &format!("前缀{}", head)), r(2, "已运行 2 个命令清理"), r(3, &format!("{}后缀", tail))];
        let selected = format!("{}已运行 2 个命令\u{fffc}已运行 2 个命令清理{}", head, tail);
        let sel = slice_blocks_for_selection(&blocks, &selected).unwrap();
        assert_eq!(sel[0].b.text, head);
        assert_eq!(sel[1].b.text, "已运行 2 个命令清理");
        assert_eq!(sel[2].b.text, tail);
    }

    #[test]
    fn long_selection_rejects_duplicate_start_duplicate_end_and_reverse_order() {
        let head = "甲".repeat(30);
        let tail = "乙".repeat(30);
        let selected = format!("{}中间{}", head, tail);
        for blocks in [vec![r(1, &head), r(2, &head), r(3, &tail)],
            vec![r(1, &head), r(2, &tail), r(3, &tail)], vec![r(1, &tail), r(2, &head)]] {
            assert!(slice_blocks_for_selection(&blocks, &selected).is_none());
        }
    }

    #[test]
    fn sliced_markdown_keeps_paragraph_list_and_inline_code_structure() {
        let mut list = r(2, "第二项"); list.kind = BlockKind::ListItem; list.list = 7; list.list_depth = 1;
        let mut code = r(3, "脚本路径"); code.inline = 4;
        let blocks = [r(1, "前缀第一段"), list, code, r(4, "末段后缀")];
        let sel = slice_blocks_for_selection(&blocks, "第一段第二项脚本路径末段").unwrap();
        assert_eq!(sel[1].kind, BlockKind::ListItem);
        assert_eq!(sel[2].inline, 4);
        assert_eq!(compose_markdown(sel), "第一段\n\n- 第二项\n\n`脚本路径`\n\n末段");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 交互探针：断言宿主进程已获辅助功能授权，并读取「当前前台」真实应用的
    // 名称/标题/选区——结果取决于谁在前台，且未授权时必然 panic。不进默认测试。
    // 手动运行（需先在 系统设置→隐私与安全性→辅助功能 授权测试宿主）：
    //   cargo test --offline ax_plumbing -- --ignored --nocapture
    #[test]
    #[ignore = "交互探针：依赖真实辅助功能授权与前台应用，结果非确定"]
    fn ax_plumbing() {
        use std::io::Write;
        let log = |s: &str| { let _ = std::io::stdout().flush(); println!("{}", s); let _ = std::io::stdout().flush(); };
        log("S1: ax_trusted()");
        let t = ax_trusted();
        log(&format!("S1 ok: trusted={}", t));
        assert!(t, "运行测试的宿主进程未获辅助功能授权");
        log("S2: front_app_info()");
        let f = front_app_info().expect("拿不到前台 App");
        log(&format!("S2 ok: {} pid={} title={:?}", f.name, f.pid, f.title));
        log("S3: window_title");
        let title = window_title(f.pid);
        log(&format!("S3 ok: {:?}", title));
        log("S4: read_selected_text");
        match read_selected_text(f.pid) {
            Ok(t) if t.is_empty() => log("S4 ok: AX 通道可用，但当前无选区（符合预期）"),
            Ok(t) => log(&format!("S4 ok: AX 读到选区 {} 字", t.chars().count())),
            Err(e) => log(&format!("S4 err（不 panic，记录）: {}", e)),
        }
        log("S5: resolve_workspace");
        let ws = resolve_workspace(&f.title);
        log(&format!("S5 ok: {:?}", ws));
    }

    // 交互探针：raise_source_window 会真实切换用户当前前台应用（默认 Finder），
    // 属于对真实窗口的副作用操作，禁止进入无人值守测试。
    // 手动运行（可用 PROBE_APP/PROBE_TITLE 指定目标）：
    //   PROBE_APP=Finder cargo test --offline raise_probe -- --ignored --nocapture
    #[test]
    #[ignore = "交互探针：会真实抬升/切换其他应用窗口（副作用）"]
    fn raise_probe() {
        use std::env;
        let name = env::var("PROBE_APP").unwrap_or_else(|_| "Finder".into());
        let title = env::var("PROBE_TITLE").unwrap_or_default();
        println!("尝试抬升: {} / title={:?}" , name, title);
        let ok = raise_source_window(&name, &title);
        println!("结果: {}", ok);
        // 验证前台变成目标
        std::thread::sleep(std::time::Duration::from_millis(600));
        let f = front_app_name();
        println!("当前前台: {}", f);
    }

    #[test]
    fn compose_merges_fragment_lines() {
        // 模拟 Chrome 的行碎片：一行内逗号独立成块、跨行段落、中英混排
        let b = |x: f64, y: f64, w: f64, h: f64, text: &str| TextBlock {
            x,
            y,
            w,
            h,
            text: text.to_string(),
        };
        let blocks = vec![
            b(100.0, 100.0, 120.0, 18.0, "他们很容易受伤"),
            b(224.0, 100.0, 12.0, 18.0, "，"),
            b(100.0, 124.0, 150.0, 18.0, "因为他们的要求太高"),
            b(100.0, 160.0, 60.0, 18.0, "const"),
            b(166.0, 160.0, 60.0, 18.0, "anchor"),
            b(100.0, 300.0, 100.0, 18.0, "第二段内容"),
        ];
        let out = compose_text(blocks);
        assert!(
            out.contains("他们很容易受伤，因为他们的要求太高"),
            "同行合并失败: {}",
            out
        );
        assert!(out.contains("const anchor"), "中英混排应有空格: {}", out);
        assert!(out.contains('\n'), "段与段之间应换行: {}", out);
    }

    #[test]
    fn compose_orders_by_position() {
        // 乱序输入 → 输出按阅读顺序
        let b = |x: f64, y: f64, w: f64, h: f64, text: &str| TextBlock {
            x,
            y,
            w,
            h,
            text: text.to_string(),
        };
        let blocks = vec![
            b(100.0, 200.0, 80.0, 18.0, "二行"),
            b(100.0, 100.0, 80.0, 18.0, "一行"),
        ];
        let out = compose_text(blocks);
        assert_eq!(out, "一行\n二行");
    }

    #[test]
    fn table_reconstructed_from_grid() {
        let b = |x: f64, y: f64, w: f64, h: f64, text: &str| TextBlock {
            x,
            y,
            w,
            h,
            text: text.to_string(),
        };
        let mut blocks = vec![];
        let mut y = 100.0;
        for r in 0..3 {
            let mut x = 200.0;
            for c in 0..3 {
                blocks.push(b(x, y, 80.0, 18.0, &format!("r{}c{}", r, c)));
                x += 120.0;
            }
            y += 24.0;
        }
        let out = compose_table(&blocks).expect("3×3 网格应识别为表格");
        assert!(out.starts_with("| r0c0 | r0c1 | r0c2 |"), "{}", out);
        assert!(out.contains("| --- | --- | --- |"), "缺分隔行: {}", out);
        assert!(out.contains("| r2c0 | r2c1 | r2c2 |"), "{}", out);
    }

    #[test]
    fn table_rejects_single_column_lines() {
        let b = |x: f64, y: f64, w: f64, h: f64, text: &str| TextBlock {
            x,
            y,
            w,
            h,
            text: text.to_string(),
        };
        let blocks: Vec<TextBlock> = (0..5)
            .map(|i| b(200.0, 100.0 + i as f64 * 24.0, 300.0, 18.0, &format!("line {}", i)))
            .collect();
        assert!(compose_table(&blocks).is_none(), "单列文本不应判为表格");
    }

    #[test]
    fn table_caption_prepends_stray() {
        let b = |x: f64, y: f64, w: f64, h: f64, text: &str| TextBlock {
            x,
            y,
            w,
            h,
            text: text.to_string(),
        };
        let mut blocks = vec![b(200.0, 60.0, 200.0, 16.0, "表格题注")];
        let mut y = 100.0;
        for r in 0..2 {
            let mut x = 200.0;
            for c in 0..2 {
                blocks.push(b(x, y, 60.0, 18.0, &format!("{}{}", r, c)));
                x += 100.0;
            }
            y += 24.0;
        }
        let out = compose_table(&blocks).expect("网格+题注应识别");
        assert!(out.starts_with("表格题注\n"), "题注应在表格前: {}", out);
        assert!(out.contains("| 00 | 01 |"), "{}", out);
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSAutoreleasePool;

    fn app_by_name(name: &str) -> Option<FrontApp> {
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let apps: id = msg_send![ws, runningApplications];
            let n: usize = msg_send![apps, count];
            let mut out = None;
            for i in 0..n {
                let a: id = msg_send![apps, objectAtIndexedSubscript: i as u64];
                let policy: i64 = msg_send![a, activationPolicy];
                if policy != 0 { continue; }
                let s = ns_to_string(msg_send![a, localizedName]);
                if s == name {
                    let pid: i32 = msg_send![a, processIdentifier];
                    // 与生产 front_app_info 一致：标题与窗口编号同源取自 main_window，
                    // 拿不到 AX 主窗时 title=""、wid=0（FrontApp 的既有约定，非本测试新造）
                    let (title, wid) = main_window(pid);
                    out = Some(FrontApp { pid, name: s, title, wid });
                    break;
                }
            }
            NSAutoreleasePool::drain(pool);
            out
        }
    }

    // 交互探针：按名字找一台真实在运行的应用（默认 ZCode）并读取其 AX 文本块，
    // 读取的是真实用户应用的界面内容，且目标不在运行时必然失败。
    // 手动运行（PROBE_APP 指定目标应用名）：
    //   PROBE_APP=Safari cargo test --offline harvest_probe_named -- --ignored --nocapture
    #[test]
    #[ignore = "交互探针：读取真实运行应用的 AX 内容，需目标 App 在运行"]
    fn harvest_probe_named() {
        let name = std::env::var("PROBE_APP").unwrap_or_else(|_| "ZCode".into());
        let f = app_by_name(&name).expect("找不到目标 App");
        println!("目标: {} pid={}", f.name, f.pid);
        let blocks: Vec<TextBlock> = harvest_text_blocks(f.pid).into_iter().map(|r| r.b).collect();
        println!("命中块数: {}", blocks.len());
        for b in blocks.iter().take(8) {
            println!(
                "  [{}x{}@{},{}] {}",
                b.w as i32, b.h as i32, b.x as i32, b.y as i32,
                b.text.chars().take(40).collect::<String>()
            );
        }
    }
}


#[cfg(test)]
mod markdown_tests {
    use super::*;

    struct B { order: u32 }
    impl B {
        fn r(&mut self, block: u32, kind: BlockKind, text: &str) -> RichBlock {
            self.order += 1;
            RichBlock { b: TextBlock { text: text.into(), w: 20.0, h: 16.0, ..Default::default() },
                order: self.order, block, kind, web: true, ..Default::default() }
        }
    }

    /// 形状取自 Claude 实测：段落内加粗是独立碎块、列表标记独立成块、隐藏读屏副本已在走查剔除
    #[test]
    fn paragraphs_bold_and_numbered_list() {
        let mut b = B { order: 0 };
        let mut v = vec![];
        let mut x = b.r(10, BlockKind::Para, "能不能补回来："); x.inline = 1; v.push(x);
        v.push(b.r(10, BlockKind::Para, " 界面接口里其实带着结构信息。"));
        for (n, (blk, body, bold)) in [(20, "回车后切到 ", "Claude"), (21, "停住别动", "")].iter().enumerate() {
            let mut m = b.r(*blk, BlockKind::ListItem, &format!("{}. ", n + 1)); m.list = 5; m.list_depth = 1; v.push(m);
            let mut t = b.r(*blk, BlockKind::ListItem, body); t.list = 5; t.list_depth = 1; v.push(t);
            if !bold.is_empty() { let mut s = b.r(*blk, BlockKind::ListItem, bold); s.list = 5; s.list_depth = 1; s.inline = 1; v.push(s); }
        }
        v.push(b.r(30, BlockKind::Para, "测完告诉我。"));
        v.reverse(); // 输入顺序无关：按树序还原
        let md = compose_markdown(v);
        assert_eq!(md, "**能不能补回来：** 界面接口里其实带着结构信息。\n\n1. 回车后切到 **Claude**\n2. 停住别动\n\n测完告诉我。");
    }

    #[test]
    fn heading_inline_code_link_and_code_block() {
        let mut b = B { order: 0 };
        let mut v = vec![b.r(1, BlockKind::Heading(2), "实测结论")];
        v.push(b.r(2, BlockKind::Para, "运行 "));
        let mut c = b.r(2, BlockKind::Para, "deploy.sh"); c.inline = 4; v.push(c);
        let mut l = b.r(2, BlockKind::Para, "文档"); l.link = Some("https://wispal.ai/".into()); v.push(l);
        for (blk, line) in [(3, "let a = 1;"), (4, "let b = 2;")] { let mut p = b.r(blk, BlockKind::Para, line); p.pre = 9; v.push(p); }
        let md = compose_markdown(v);
        assert_eq!(md, "## 实测结论\n\n运行 `deploy.sh`[文档](https://wispal.ai/)\n\n```\nlet a = 1;\nlet b = 2;\n```");
    }

    #[test]
    fn table_rows_and_cells() {
        let mut b = B { order: 0 };
        let mut v = vec![];
        for (row, cells) in [(1u32, ["App", "块数"]), (2, ["Claude", "34 | 块"])] {
            for (ci, t) in cells.iter().enumerate() {
                let cell = row * 10 + ci as u32;
                let mut r = b.r(cell, BlockKind::Cell, t); r.table = 7; r.row = row; r.cell = cell; v.push(r);
            }
        }
        let mut bold = b.r(21, BlockKind::Cell, "新"); bold.table = 7; bold.row = 2; bold.cell = 21; bold.inline = 1; v.push(bold);
        let md = compose_markdown(v);
        assert_eq!(md, "| App | 块数 |\n| --- | --- |\n| Claude | 34 \\| 块**新** |");
    }
}
