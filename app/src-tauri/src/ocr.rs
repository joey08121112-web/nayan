//! 像素识别（OCR）兜底
//! ZCode 这类 Electron 构建不向辅助功能暴露网页内容（AX 走查仅得标题栏），
//! 框选在这些 App 里自动切换到「截取框选区域 + Vision 识别中英文」。
//! 识别器是 swift/ocr.swift 编译出的 nayan-ocr（build.rs 负责），需要宿主 App
//! 获得一次「屏幕录制」权限；识别失败会明确报错供上层引导授权。

use std::path::PathBuf;
use std::process::Command;

/// 对屏幕区域（全局坐标，点）做文字识别
pub fn ocr_region(x: f64, y: f64, w: f64, h: f64, exclude_window_number: u32) -> Result<String, String> {
    let bin = match option_env!("NAYAN_OCR_BIN") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => return Err("OCR 助手未编译（需要 Xcode/swiftc 重新构建）".into()),
    };
    let out = Command::new(&bin)
        .args([
            format!("{:.0}", x),
            format!("{:.0}", y),
            format!("{:.0}", w),
            format!("{:.0}", h),
            format!("{}", exclude_window_number),
        ])
        .output()
        .map_err(|e| format!("OCR 助手启动失败：{}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if let Some(msg) = stdout.strip_prefix("__ERR__") {
        return Err(match msg.trim() {
            "capture" | "empty-capture" => {
                "屏幕取像失败——请在 系统设置→隐私与安全性→屏幕录制 中授权纳言后重试".into()
            }
            other => format!("OCR 失败：{}", other),
        });
    }
    let text = stdout.trim_end().to_string();
    if text.trim().is_empty() {
        return Err("画面里没有识别到文字".into());
    }
    Ok(text)
}
