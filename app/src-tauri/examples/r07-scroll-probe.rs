//! R07 C0 opt-in native probe. Requires a caller-supplied PID and cursor point.
//! Prints geometry/counts only; does not read/write the clipboard or save source text.
#[allow(dead_code)]
#[path = "../src/ax_capture.rs"]
mod ax_capture;

use std::{ffi::c_void, time::{Duration, Instant}};
use serde_json::json;

fn log_line(s: &str) { eprintln!("{}", s); }

#[repr(C)]
#[derive(Clone, Copy)]
struct Point { x: f64, y: f64 }
#[repr(C)]
struct Size { width: f64, height: f64 }
#[repr(C)]
struct Rect { origin: Point, size: Size }

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> Rect;
    fn CGEventCreateScrollWheelEvent(source: *const c_void, units: u32, count: u32, ...) -> *const c_void;
    fn CGEventSetLocation(event: *const c_void, point: Point);
    fn CGEventPostToPid(pid: i32, event: *const c_void);
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CFRelease(value: *const c_void);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let value = |key: &str| args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned();
    let pid: i32 = value("--pid").expect("--pid required").parse().expect("PID");
    let screen = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let bottom: f64 = value("--screen-bottom").map(|s|s.parse().unwrap()).unwrap_or(screen.origin.y + screen.size.height);
    let trusted = ax_capture::ax_trusted();
    if !trusted {
        println!("{}", json!({"trusted":false,"status":"blocked: probe host has no Accessibility permission"}));
        std::process::exit(2);
    }
    let started = Instant::now();
    let before = ax_capture::harvest_text_blocks(pid);
    let initial_ms = started.elapsed().as_millis();
    let offscreen = before.iter().filter(|r| r.web && r.b.y > bottom).count();
    if !args.iter().any(|a| a == "--scroll") {
        println!("{}", json!({"trusted":true,"pid":pid,"blocks":before.len(),"web":before.iter().filter(|r|r.web).count(),"offscreen_below":offscreen,"initial_ms":initial_ms,"screen_bottom":bottom}));
        return;
    }
    let x = value("--x").expect("--x required").parse().unwrap();
    let y = value("--y").expect("--y required").parse().unwrap();
    let delay: u64 = value("--delay-ms").unwrap_or_else(|| "0".into()).parse().unwrap();
    std::thread::sleep(Duration::from_millis(delay));
    let held_before = unsafe { CGEventSourceButtonState(0, 0) };
    unsafe {
        let event = CGEventCreateScrollWheelEvent(std::ptr::null(), 0, 1, -60i32);
        assert!(!event.is_null(), "scroll event allocation failed");
        CGEventSetLocation(event, Point { x, y });
        CGEventPostToPid(pid, event);
        CFRelease(event);
    }
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    let after = ax_capture::harvest_text_blocks_now(pid);
    let read_ms = started.elapsed().as_millis();
    let held_after = unsafe { CGEventSourceButtonState(0, 0) };
    let mut deltas = Vec::new();
    for b in &before {
        if !b.web || before.iter().filter(|r|r.b.text == b.b.text).count() != 1 { continue; }
        let matches: Vec<_> = after.iter().filter(|r|r.web && r.b.text == b.b.text).collect();
        if matches.len() == 1 {
            deltas.push(b.b.y - matches[0].b.y);
        }
    }
    deltas.sort_by(|a,b|a.total_cmp(b));
    let changed: Vec<_> = deltas.iter().copied().filter(|d| d.abs() > 0.5).collect();
    println!("{}", json!({"trusted":trusted,"pid":pid,"method":"CGEventPostToPid","requested_pixels":60,
        "before_blocks":before.len(),"after_blocks":after.len(),"offscreen_below":offscreen,
        "initial_ms":initial_ms,"read_ms":read_ms,"matched_unique_blocks":deltas.len(),
        "changed_blocks":changed.len(),"min_delta":changed.first(),"max_delta":changed.last(),
        "median_changed_delta":changed.get(changed.len()/2),"mouse_held_before":held_before,"mouse_held_after":held_after}));
}
