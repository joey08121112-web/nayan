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
            Some(FrontApp {
                pid,
                name,
                title: window_title(pid),
            })
        })
    }
}

/// 主窗口标题（走 AX；读不到就空串）
pub fn window_title(pid: i32) -> String {
    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return String::new();
        }
        let mut win: CFRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(app_el, ns_str("AXMainWindow") as CFRef, &mut win);
        let title = if err == 0 && !win.is_null() {
            copy_string(win, "AXTitle").unwrap_or_default()
        } else {
            String::new()
        };
        if !win.is_null() {
            CFRelease(win);
        }
        CFRelease(app_el);
        title
    }
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

// ---------- 兜底：模拟 ⌘C + 剪贴板（用完恢复） ----------

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

/// 模拟 ⌘C 读剪贴板，读完恢复原内容（HS 版没做的改进）。
/// 限制：只恢复文本内容；图片等富内容恢复不了。
pub fn simulate_copy_text() -> Result<String, String> {
    CLIP_SUPPRESS_UNTIL.store(now_ms() + 4000, std::sync::atomic::Ordering::Relaxed);
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let before = cb.get_text().ok();
    let before_count = pasteboard_change_count();
    post_cmd_c();
    let deadline = std::time::Instant::now() + Duration::from_millis(1200);
    let mut got: Option<String> = None;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(80));
        if pasteboard_change_count() > before_count {
            if let Ok(t) = cb.get_text() {
                if !t.is_empty() && Some(&t) != before.as_ref() {
                    got = Some(t);
                    break;
                }
            }
        }
    }
    // 恢复原剪贴板（改了 changeCount，对用户无感）
    if let Some(old) = before {
        let _ = cb.set_text(old);
    }
    got.ok_or_else(|| "⌘C 后剪贴板无变化（目标 App 可能不支持复制）".into())
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
#[derive(Clone, serde::Serialize)]
pub struct TextBlock {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub text: String,
}

const NODE_CAP: usize = 5000;
const BLOCK_CAP: usize = 2500;
const DEPTH_CAP: usize = 20;

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

struct WalkState {
    nodes: usize,
    blocks: Vec<TextBlock>,
}

unsafe fn walk(el: CFRef, depth: usize, st: &mut WalkState) {
    if depth > DEPTH_CAP || st.nodes > NODE_CAP || st.blocks.len() > BLOCK_CAP {
        return;
    }
    st.nodes += 1;
    let role = copy_string(el, "AXRole").unwrap_or_default();
    // 菜单类是瞬态 UI，永远不是框选目标，整棵剪掉省几千个节点
    if role == "AXMenu" || role == "AXMenuItem" || role == "AXMenuBar" {
        return;
    }
    // 文本判定：AXValue 是字符串（文本角色与含字符串值的通用元素都算）
    let mut val: CFRef = std::ptr::null();
    let verr = AXUIElementCopyAttributeValue(el, ns_str("AXValue") as CFRef, &mut val);
    let mut text = String::new();
    if verr == 0 && !val.is_null() {
        if CFGetTypeID(val) == CFStringGetTypeID() {
            text = ns_to_string(val as id);
        }
        CFRelease(val);
    }
    if !text.trim().is_empty() {
        if let (Some((x, y)), Some((w, h))) = (ax_point(el, "AXPosition"), ax_size(el)) {
            if w >= 14.0 && h >= 6.0 {
                st.blocks.push(TextBlock { x, y, w, h, text });
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
                walk(child, depth + 1, st);
            }
            if st.nodes > NODE_CAP || st.blocks.len() > BLOCK_CAP {
                break;
            }
        }
        CFRelease(kids);
    }
}

/// 走查目标 App 的全部文本块（屏幕坐标）。
/// Chromium 系（Chrome/Electron）首次开 AX 后建树要 1~2 秒：最多三轮
/// （600ms / +1.2s / +1.5s），取块数最多的一轮；部分 Electron 还需
/// AXEnhancedUserInterface 属性才肯暴露内容。
pub fn harvest_text_blocks(pid: i32) -> Vec<TextBlock> {
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

fn harvest_once(pid: i32, warmup_ms: u64) -> Vec<TextBlock> {
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
            blocks: vec![],
        };
        walk(app_el, 0, &mut st);
        CFRelease(app_el);
        st.blocks
    }
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
mod tests {
    use super::*;

    #[test]
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

    #[test]
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
                    out = Some(FrontApp { pid, name: s, title: window_title(pid) });
                    break;
                }
            }
            NSAutoreleasePool::drain(pool);
            out
        }
    }

    #[test]
    fn harvest_probe_named() {
        let name = std::env::var("PROBE_APP").unwrap_or_else(|_| "ZCode".into());
        let f = app_by_name(&name).expect("找不到目标 App");
        println!("目标: {} pid={}", f.name, f.pid);
        let blocks = harvest_text_blocks(f.pid);
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
