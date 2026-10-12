// build.rs：编译 Swift OCR 辅助工具 → tauri 构建
use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // 先把 swift/ocr.swift 编译成 binaries/nayan-ocr-<目标三元组>：tauri.conf.json 的
    // bundle.externalBin 把它打进 NaYan.app/Contents/MacOS/nayan-ocr（并随 App 一起签名），
    // ocr.rs 运行时在主程序旁边找它。tauri_build 会校验这个文件存在，所以必须先于它生成。
    // 无 swiftc（或编译失败）时放一个只会报错的占位脚本，不阻塞构建，仅 OCR 兜底不可用。
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest_dir.join("swift/ocr.swift");
    let target = env::var("TARGET").unwrap();
    let bin_dir = manifest_dir.join("binaries");
    let bin = bin_dir.join(format!("nayan-ocr-{}", target));
    println!("cargo:rerun-if-changed={}", src.display());
    std::fs::create_dir_all(&bin_dir).unwrap();
    let ok = src.exists()
        && matches!(
            Command::new("swiftc").arg("-O").arg("-o").arg(bin.as_os_str()).arg(src.as_os_str()).status(),
            Ok(s) if s.success()
        );
    if ok {
        println!("cargo:rustc-env=NAYAN_OCR_BIN={}", bin.display());
    } else {
        println!("cargo:warning=Swift OCR 助手编译失败，像素识别兜底将不可用");
        std::fs::write(&bin, "#!/bin/sh\necho 'nayan-ocr 未编译（构建时缺少 swiftc）'\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    tauri_build::build();
}
