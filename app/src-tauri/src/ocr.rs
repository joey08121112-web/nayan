//! 像素识别（OCR）兜底
//! ZCode 这类 Electron 构建不向辅助功能暴露网页内容（AX 走查仅得标题栏），
//! 框选在这些 App 里自动切换到「截取框选区域 + Vision 识别中英文」。
//! 识别器是 swift/ocr.swift 编译出的 nayan-ocr（build.rs 负责），需要宿主 App
//! 获得一次「屏幕录制」权限；识别失败会明确报错供上层引导授权。

use std::path::PathBuf;
use std::process::Command;

use crate::ax_capture::TextBlock;

fn helper_path() -> Result<PathBuf,String> {
    // 安装包里由 bundle.externalBin 放在主程序旁边（Contents/MacOS/nayan-ocr）。
    if let Ok(exe)=std::env::current_exe() {
        let bundled=exe.with_file_name("nayan-ocr");
        if bundled.is_file() {return Ok(bundled);}
    }
    // 只有开发构建（cargo test 等）才回退到构建机上的路径；发布包不内嵌本机绝对路径。
    #[cfg(debug_assertions)]
    if let Some(p)=option_env!("NAYAN_OCR_BIN").map(PathBuf::from).filter(|p|p.is_file()) {return Ok(p);}
    Err("截图助手未编译或缺失".into())
}

pub fn capture_region(x:f64,y:f64,w:f64,h:f64,excluded:u32)->Result<crate::capture_image::Draft,String> {
    let bin=helper_path()?;
    let out=Command::new(bin).args([x.to_string(),y.to_string(),w.to_string(),h.to_string(),excluded.to_string(),"--image".into()]).output().map_err(|e|e.to_string())?;
    let v:serde_json::Value=serde_json::from_slice(&out.stdout).map_err(|_|format!("屏幕截图失败（检查屏幕录制权限）：{}",String::from_utf8_lossy(&out.stdout)))?;
    let blocks=v["lines"].as_array().ok_or("识别结果缺少行集合")?.iter().filter_map(|l|Some(TextBlock {
        x:l["x"].as_f64()?,y:l["y"].as_f64()?,w:l["w"].as_f64()?,h:l["h"].as_f64()?,text:l["text"].as_str()?.into()
    })).collect::<Vec<_>>();
    // 原图是权威；派生文字只做保守的「一行就是一行」，不再猜段落/表格（R3）。
    let text=compose_ocr_lines(blocks);
    crate::capture_image::Draft::from_result(&v,text)
}

fn is_cjk(c: char) -> bool { (c as u32) >= 0x2E80 }

fn glue_inline(a: &str, b: &str) -> String {
    if a.is_empty() { return b.to_string(); }
    let a_cjk = a.chars().last().map(is_cjk).unwrap_or(false);
    let b_cjk = b.chars().next().map(is_cjk).unwrap_or(false);
    if a_cjk && b_cjk { format!("{}{}", a, b) } else { format!("{} {}", a, b) }
}

/// UX-BOX-ORIGINAL-CLAUDE-01/R3：OCR 行块 → 识别文字。
/// 规则（保守，不重建结构）：
/// ① 按竖直中心稳定排序后聚成视觉行（中心差 ≤ 0.5×行高中位数）；
/// ② 同一视觉行内按 x 排序拼接（中日韩相邻不加空格）；
/// ③ 每个视觉行单独成行——绝不把相邻行合并成段落；
/// ④ 行间空隙明显大于常规行距时补一个空行，保留段落分隔。
/// 不做去重（相同文字可能确实出现两次）、不推断表格/标题/缩进。
pub fn compose_ocr_lines(mut blocks: Vec<TextBlock>) -> String {
    blocks.retain(|b| !b.text.trim().is_empty() && b.h.is_finite() && b.y.is_finite() && b.x.is_finite() && b.h > 0.0);
    if blocks.is_empty() { return String::new(); }
    let mut hs: Vec<f64> = blocks.iter().map(|b| b.h).collect();
    hs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let med_h = hs[hs.len() / 2].max(1.0);
    let center = |b: &TextBlock| b.y + b.h / 2.0;
    blocks.sort_by(|a, b| center(a).partial_cmp(&center(b)).unwrap_or(std::cmp::Ordering::Equal));
    let mut rows: Vec<Vec<TextBlock>> = vec![];
    for b in blocks {
        let c = center(&b);
        let joins = rows.last().map(|r| {
            let rc = r.iter().map(|x| center(x)).sum::<f64>() / r.len() as f64;
            (c - rc).abs() <= med_h * 0.5
        }).unwrap_or(false);
        if joins { rows.last_mut().unwrap().push(b); } else { rows.push(vec![b]); }
    }
    struct Line { y0: f64, y1: f64, text: String }
    let lines: Vec<Line> = rows.into_iter().map(|mut r| {
        r.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
        let y0 = r.iter().map(|b| b.y).fold(f64::MAX, f64::min);
        let y1 = r.iter().map(|b| b.y + b.h).fold(f64::MIN, f64::max);
        let text = r.iter().fold(String::new(), |acc, b| glue_inline(&acc, b.text.trim()));
        Line { y0, y1, text }
    }).collect();
    let gaps: Vec<f64> = lines.windows(2).map(|w| (w[1].y0 - w[0].y1).max(0.0)).collect();
    // 常规行距取最紧的行间隙（代码/正文连续行），比它明显大的才算段落分隔。
    let tight = gaps.iter().copied().fold(f64::MAX, f64::min).max(med_h * 0.25);
    let para = (tight * 1.8).max(med_h * 0.6);
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
            if gaps[i - 1] > para { out.push('\n'); }
        }
        out.push_str(&l.text);
    }
    out
}

#[cfg(test)]
mod compose_ocr_lines_tests {
    use super::*;
    fn b(x: f64, y: f64, t: &str) -> TextBlock { TextBlock { x, y, w: 200.0, h: 16.0, text: t.into() } }
    #[test] fn numbered_lines_stay_separate() {
        let s = compose_ocr_lines(vec![b(10., 0., "1. 安装依赖"), b(10., 22., "2. 修改配置文件"), b(10., 44., "3. 重启服务")]);
        assert_eq!(s, "1. 安装依赖\n2. 修改配置文件\n3. 重启服务");
    }
    #[test] fn commands_never_merge_and_paragraph_gap_kept() {
        let s = compose_ocr_lines(vec![b(10., 0., "（一）创建部门专属用户组"), b(10., 40., "bash"), b(10., 70., "sudo groupadd datasafe"), b(10., 92., "grep datasafe /etc/group"), b(10., 130., "截图①：含 datasafe:x:xxxx: 那一行")]);
        assert!(s.contains("sudo groupadd datasafe\ngrep datasafe /etc/group"), "{s}");
        assert!(s.lines().all(|l| l != "sudo groupadd datasafe grep datasafe /etc/group"));
        assert!(s.contains("\n\n截图①"), "{s}");
    }
    #[test] fn same_row_fragments_join_in_x_order() {
        let s = compose_ocr_lines(vec![b(300., 1., "复制"), b(10., 0., "bash"), b(10., 30., "中文"), b(220., 31., "片段")]);
        assert_eq!(s, "bash 复制\n中文片段");
    }
    #[test] fn repeated_lines_are_not_deduplicated() {
        let s = compose_ocr_lines(vec![b(10., 0., "sudo adduser lihua"), b(10., 22., "sudo adduser lihua")]);
        assert_eq!(s, "sudo adduser lihua\nsudo adduser lihua");
    }
    #[test] fn empty_and_invalid_blocks_yield_empty_text() {
        assert_eq!(compose_ocr_lines(vec![]), "");
        assert_eq!(compose_ocr_lines(vec![TextBlock { x: 0., y: f64::NAN, w: 1., h: 16., text: "x".into() }, b(0., 0., "  ")]), "");
    }
}

/// 屏幕录制权限预检（不弹窗，只查询）：像素识别兜底依赖它
pub fn screen_recording_ok() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// 对屏幕区域（全局坐标，点）做文字识别，返回行级文本块（屏幕坐标）。
/// swift 端输出 JSON（{"lines":[{x,y,w,h,text}]}），错误仍用 __ERR__ 前缀行。
pub fn ocr_region_blocks(x: f64, y: f64, w: f64, h: f64, exclude_window_number: u32) -> Result<Vec<TextBlock>, String> {
    let bin = helper_path()?;
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
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("OCR 输出解析失败：{}", e))?;
    let mut blocks = Vec::new();
    if let Some(lines) = v["lines"].as_array() {
        for l in lines {
            if let (Some(x), Some(y), Some(w), Some(h), Some(text)) = (
                l["x"].as_f64(),
                l["y"].as_f64(),
                l["w"].as_f64(),
                l["h"].as_f64(),
                l["text"].as_str(),
            ) {
                if !text.trim().is_empty() {
                    blocks.push(TextBlock {
                        x,
                        y,
                        w,
                        h,
                        text: text.to_string(),
                    });
                }
            }
        }
    }
    if blocks.is_empty() {
        return Err("画面里没有识别到文字".into());
    }
    Ok(blocks)
}
