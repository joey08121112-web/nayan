// 纳言 OCR 辅助工具（Swift / ScreenCaptureKit + Vision）
// 用法: nayan-ocr <x> <y> <w> <h> [排除窗口号]
//   截取屏幕指定区域（全局坐标，点，原点左上），Vision 识别中英文，按行输出 stdout。
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
        try handler.perform([request])

        var lines: [(top: Double, left: Double, h: Double, text: String)] = []
        if let results = request.results {
            for obs in results {
                guard let cand = obs.topCandidates(1).first else { continue }
                let b = obs.boundingBox
                lines.append((top: Double(b.origin.y + b.height),
                              left: Double(b.origin.x),
                              h: Double(b.height),
                              text: cand.string))
            }
        }
        lines.sort { lhs, rhs in
            if abs(lhs.top - rhs.top) < max(lhs.h, rhs.h) / 2 {
                return lhs.left < rhs.left
            }
            return lhs.top > rhs.top
        }
        var out: [String] = []
        var prevTop: Double? = nil
        for l in lines {
            if let p = prevTop, abs(p - l.top) < max(l.h, 8) / 2, let last = out.last {
                out[out.count - 1] = last + " " + l.text
            } else {
                out.append(l.text)
                prevTop = l.top
            }
        }
        Box.result = .success(out.joined(separator: "\n"))
    } catch {
        Box.result = .failure(OCRFailure(message: "\(error)"))
    }
}

Box.sem.wait()
switch Box.result {
case .success(let text):
    print(text)
case .failure(let m):
    err(m.message)
case nil:
    err("no result")
}
exit(0)
