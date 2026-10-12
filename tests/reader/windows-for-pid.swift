// tests/reader/windows-for-pid.swift —— 列出指定 pid 的窗口数与标题（R1-F02 隔离证据）
// 用法：swift windows-for-pid.swift <pid>
// 输出：第一行 = 窗口数；随后每行 "windowId | title"
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count >= 2, let pid = Int32(args[1]) else {
  print("0")
  exit(0)
}
let list = CGWindowListCopyWindowInfo([], kCGNullWindowID) as? [[String: Any]] ?? []
var lines: [String] = []
for w in list {
  if (w["kCGWindowOwnerPID"] as? Int32) == pid {
    let name = w["kCGWindowName"] as? String ?? ""
    lines.append("\(w["kCGWindowNumber"] as? Int ?? 0) | \(name)")
  }
}
print(lines.count)
for l in lines { print(l) }
