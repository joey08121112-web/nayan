// build.rs：tauri 构建 + 编译 Swift OCR 辅助工具（有 Xcode/swiftc 时）
use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    tauri_build::build();

    // 把 swift/ocr.swift 编译成 nayan-ocr，运行时经 NAYAN_OCR_BIN 环境变量定位。
    // 无 swiftc（或编译失败）时不阻塞构建，仅 OCR 兜底不可用（日志可见）。
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest_dir.join("swift/ocr.swift");
    if !src.exists() {
        return;
    }
    println!("cargo:rerun-if-changed={}", src.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let bin = out_dir.join("nayan-ocr");
    let status = Command::new("swiftc")
        .arg("-O")
        .arg("-o")
        .arg(bin.as_os_str())
        .arg(src.as_os_str())
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=NAYAN_OCR_BIN={}", bin.display());
        }
        _ => {
            println!("cargo:warning=Swift OCR 助手编译失败，像素识别兜底将不可用");
        }
    }
}
