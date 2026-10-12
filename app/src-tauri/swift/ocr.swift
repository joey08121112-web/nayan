// 纳言 OCR 辅助工具（Swift / ScreenCaptureKit + Vision）
// 用法: nayan-ocr <x> <y> <w> <h> [排除窗口号]
//   截取屏幕指定区域（全局坐标，点，原点左上），Vision 识别中英文，
//   stdout 输出 JSON：{"lines":[{x,y,w,h,text}...]}（屏幕点坐标，每行一块）。
// 首次运行会自动弹「屏幕录制」系统授权提示（ScreenCaptureKit 标准行为）。

import AppKit
import Vision
import ScreenCaptureKit

func err(_ msg: String) -> Never {
    print("__ERR__" + msg)
    exit(0)
}

let a = CommandLine.arguments
guard a.count >= 5,
      let x = Double(a[1]), let y = Double(a[2]),
      let w = Double(a[3]), let h = Double(a[4]), w > 1, h > 1 else {
    err("args")
}
let excludeID: CGWindowID = a.count >= 6 ? (UInt32(a[5]) ?? 0) : 0
let keepImage = a.dropFirst(6).contains("--image")

struct OCRFailure: Error { let message: String }
struct Box {
    static var result: Result<String, OCRFailure>?
    static let sem = DispatchSemaphore(value: 0)
}

Task {
    defer { Box.sem.signal() }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        // 找覆盖该区域起点的显示器
        guard let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: x, y: y)) })
                ?? content.displays.first else {
            Box.result = .failure(OCRFailure(message: "no display"))
            return
        }
        // 排除框选 overlay 自己（按窗口号匹配）
        let excluded = excludeID > 0 ? content.windows.filter { $0.windowID == excludeID } : []
        let filter = SCContentFilter(display: display, excludingWindows: excluded)
        let config = SCStreamConfiguration()
        // sourceRect：显示frame 内、原点左上（与全局坐标同向）
        config.sourceRect = CGRect(x: x - display.frame.origin.x,
                                   y: y - display.frame.origin.y,
                                   width: w, height: h)
        guard x.isFinite, y.isFinite, w.isFinite, h.isFinite,
              display.frame.contains(CGRect(x: x, y: y, width: w, height: h)),
              w <= 8192, h <= 8192 else {
            Box.result = .failure(OCRFailure(message: "region-outside-display")); return
        }
        // R5：按显示模式的像素宽/点宽求缩放；SCDisplay.width 以点为单位，旧比值在 Retina 上恒为 1。
        var scale = 1.0
        if let mode = CGDisplayCopyDisplayMode(display.displayID), mode.width > 0, mode.pixelWidth > 0 {
            scale = Double(mode.pixelWidth) / Double(mode.width)
        }
        if !scale.isFinite || scale < 1 { scale = 1 }
        config.width = Int(ceil(w * scale))
        config.height = Int(ceil(h * scale))
        config.showsCursor = false
        config.captureResolution = .best

        let cgimg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        if cgimg.width < 8 {
            Box.result = .failure(OCRFailure(message: "empty-capture"))
            return
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false

        let handler = VNImageRequestHandler(cgImage: cgimg, options: [:])
        var recognitionError: String? = nil
        do { try handler.perform([request]) }
        catch { if !keepImage { throw error }; recognitionError = String(describing: error) }

        var items: [[String: Any]] = []
        if let results = request.results {
            for obs in results {
                guard let cand = obs.topCandidates(1).first else { continue }
                let b = obs.boundingBox
                // 归一化坐标（原点左下）→ 屏幕点坐标（原点左上，区域偏移 + 缩放）
                let text = cand.string.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let px = x + Double(b.origin.x) * w
                let py = y + (1.0 - b.origin.y - b.height) * h
                let pw = Double(b.width) * w
                let ph = Double(b.height) * h
                items.append(["x": px, "y": py, "w": pw, "h": ph, "text": text])
            }
        }
        // 行合并/排序交给 Rust 侧 compose_table/compose_text（与 AX 块同一管线）
        var result: [String: Any] = ["lines": items]
        if keepImage {
            guard let png = NSBitmapImageRep(cgImage: cgimg).representation(using: .png, properties: [:]),
                  png.count <= 32 * 1024 * 1024 else {
                Box.result = .failure(OCRFailure(message: "image-too-large")); return
            }
            result["image"] = ["png": png.base64EncodedString(), "width": cgimg.width, "height": cgimg.height]
            result["ocrError"] = recognitionError ?? ""
        }
        if let data = try? JSONSerialization.data(withJSONObject: result),
           let json = String(data: data, encoding: .utf8) {
            Box.result = .success(json)
        } else {
            Box.result = .failure(OCRFailure(message: "json"))
        }
    } catch {
        Box.result = .failure(OCRFailure(message: "\(error)"))
    }
}

guard Box.sem.wait(timeout: .now() + 20) == .success else { err("capture-timeout") }
switch Box.result {
case .success(let text):
    print(text)
case .failure(let m):
    err(m.message)
case nil:
    err("no result")
}
exit(0)
