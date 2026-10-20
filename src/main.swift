import Cocoa
import WebKit
import UniformTypeIdentifiers

enum PageKind { case home, reader }

// ---- 路径安全:先解析符号链接并规范化,再判断是否落在授权根目录内 ----
enum PathGuard {
    static func inside(_ base: URL, _ p: URL) -> String? {
        let b = base.resolvingSymlinksInPath().standardizedFileURL.path
        let f = p.resolvingSymlinksInPath().standardizedFileURL.path
        guard f.hasPrefix(b + "/") else { return nil }
        return String(f.dropFirst(b.count + 1))
    }
    static func isRegularFile(_ u: URL) -> Bool {
        (try? u.resolvingSymlinksInPath().resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true
    }
    static func size(_ u: URL) -> Int? {
        (try? u.resolvingSymlinksInPath().resourceValues(forKeys: [.fileSizeKey]))?.fileSize
    }
}

enum BundleError: LocalizedError {
    case tooLarge(String)
    var errorDescription: String? { if case .tooLarge(let m) = self { return m }; return nil }
}

// ---- .mdz 图文包(zip, store 模式)写入:无第三方依赖 ----
enum MdzBundle {
    static let imgExt: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]
    static let maxMarkdown = 8 << 20
    static let maxImage = 25 << 20
    static let maxTotal = 200 << 20
    static let maxCount = 2000
    static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
        return c
    }
    static func crc32(_ d: Data) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        for b in d { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFFFFFF
    }

    static func makeZip(_ entries: [(name: String, data: Data)]) -> Data {
        var out = Data(), central = Data()
        func u16(_ v: Int) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
        func u32(_ v: UInt32) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * UInt32($0))) & 0xFF) } }
        func cat(_ parts: [UInt8]...) -> [UInt8] { parts.flatMap { $0 } }
        for e in entries {
            let name = Data(e.name.utf8), crc = crc32(e.data), size = UInt32(e.data.count)
            let offset = UInt32(out.count)
            out.append(contentsOf: cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
                                       u32(crc), u32(size), u32(size), u16(name.count), u16(0)))
            out.append(name); out.append(e.data)
            central.append(contentsOf: cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
                                           u32(crc), u32(size), u32(size), u16(name.count), u16(0), u16(0),
                                           u16(0), u16(0), u32(0), u32(offset)))
            central.append(name)
        }
        let cdOffset = UInt32(out.count)
        out.append(central)
        out.append(contentsOf: cat(u32(0x06054b50), u16(0), u16(0), u16(entries.count), u16(entries.count),
                                   u32(UInt32(central.count)), u32(cdOffset), u16(0)))
        return out
    }

    // md + 图片文件夹 → (zip, 图片数, 未收录的引用及原因)
    // 只收录:真实路径(解析符号链接后)位于 md 所在目录或所选图片目录内、是普通文件、扩展名为图片、未超过大小限制的文件。
    static func build(md: URL, imgDir: URL?) throws -> (zip: Data, count: Int, missing: [String]) {
        let mdDir = md.deletingLastPathComponent()
        guard (PathGuard.size(md) ?? 0) <= maxMarkdown else { throw BundleError.tooLarge("Markdown 文件超过 8 MB") }
        let text = try Data(contentsOf: md)
        let src = String(decoding: text, as: UTF8.self)
        var files: [(String, URL)] = []
        var seen = Set<String>()
        var total = text.count
        var missing: [String] = []

        // 返回 nil 表示收录;否则返回未收录原因
        func add(_ abs: URL) -> String? {
            guard imgExt.contains(abs.pathExtension.lowercased()) else { return "不是图片" }
            guard PathGuard.isRegularFile(abs) else { return "不是普通文件" }
            let name: String
            if let r = PathGuard.inside(mdDir, abs) { name = r }
            else if let d = imgDir, let r = PathGuard.inside(d, abs) { name = "assets/" + r }
            else { return "在所选文件夹之外" }
            if seen.contains(name) { return nil }
            guard let sz = PathGuard.size(abs), sz <= maxImage else { return "超过单个图片 25 MB 上限" }
            guard files.count < maxCount, total + sz <= maxTotal else { return "超过图文包数量/总大小上限" }
            seen.insert(name); total += sz
            files.append((name, abs.resolvingSymlinksInPath()))
            return nil
        }

        let fm = FileManager.default
        if let dir = imgDir,
           let en = fm.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey],
                                  options: [.skipsHiddenFiles, .skipsPackageDescendants]) {
            for case let u as URL in en where imgExt.contains(u.pathExtension.lowercased()) {
                if u.pathComponents.contains("node_modules") { continue }
                if let why = add(u) { missing.append("\(u.lastPathComponent)(\(why))") }
            }
        }
        // md 里引用到的图片:同样只收录授权目录内的图片
        var refs: [String] = []
        for pat in [#"!\[[^\]]*\]\(\s*<?([^)>\s]+)"#, #"<img[^>]*?\ssrc\s*=\s*["']([^"']+)["']"#] {
            let re = try NSRegularExpression(pattern: pat, options: [.caseInsensitive])
            for m in re.matches(in: src, range: NSRange(src.startIndex..., in: src)) {
                if let r = Range(m.range(at: 1), in: src) { refs.append(String(src[r])) }
            }
        }
        let external = try NSRegularExpression(pattern: #"^([a-z][a-z0-9+.-]*:|//|#)"#, options: [.caseInsensitive])
        var done = Set<String>()
        for ref in refs where done.insert(ref).inserted {
            if external.firstMatch(in: ref, range: NSRange(ref.startIndex..., in: ref)) != nil { continue }
            var rel = ref.components(separatedBy: "#")[0].components(separatedBy: "?")[0]
            rel = rel.removingPercentEncoding ?? rel
            let abs = URL(fileURLWithPath: rel, relativeTo: mdDir).standardizedFileURL
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: abs.path, isDirectory: &isDir), !isDir.boolValue {
                if let why = add(abs) { missing.append("\(ref)(\(why))") }
                continue
            }
            let leaf = (rel as NSString).lastPathComponent.lowercased()
            if !files.contains(where: { ($0.0 as NSString).lastPathComponent.lowercased() == leaf }) { missing.append("\(ref)(找不到)") }
        }
        let mdName = md.lastPathComponent
        var entries: [(String, Data)] = [(mdName, text)]
        for (name, url) in files where name != mdName {
            if let d = try? Data(contentsOf: url) { entries.append((name, d)) }
        }
        return (makeZip(entries.map { (name: $0.0, data: $0.1) }), entries.count - 1, missing)
    }
}

// ---- 文档资源:irisdoc://doc/<相对路径> 只能读到当前文档目录内的资源文件 ----
enum DocRoot {
    static let scheme = "irisdoc", host = "doc"
    static var base: String { "\(scheme)://\(host)/" }
    static func resolve(_ url: URL, root: URL?) -> URL? {
        guard url.scheme == scheme, url.host == host, let root = root else { return nil }
        let rel = String(url.path.drop(while: { $0 == "/" }))
        guard !rel.isEmpty else { return nil }
        let f = root.appendingPathComponent(rel)
        guard PathGuard.inside(root, f) != nil, PathGuard.isRegularFile(f) else { return nil }
        return f.resolvingSymlinksInPath()
    }
}

// ---- 主框架导航策略:阅读页/首页不得被文档内容替换 ----
enum NavDecision: Equatable { case allow, cancel, external(URL), document(URL) }
enum NavPolicy {
    static let docExt: Set<String> = ["md", "markdown", "txt", "html", "htm", "mdz", "zip"]
    static func decide(url: URL?, mainFrame: Bool, newWindow: Bool, userClick: Bool,
                       isTrusted: (URL) -> Bool, resolveDoc: (URL) -> URL?) -> NavDecision {
        guard let url = url else { return .cancel }
        if !mainFrame && !newWindow { return .allow }            // 沙箱 iframe 内部导航
        let scheme = (url.scheme ?? "").lowercased()
        if scheme == "file", isTrusted(url) { return newWindow ? .cancel : .allow }   // 应用自带页面(含 #锚点)
        guard userClick else { return .cancel }
        switch scheme {
        case "http", "https", "mailto":
            return .external(url)
        case "irisdoc":
            if let f = resolveDoc(url), docExt.contains(f.pathExtension.lowercased()) { return .document(f) }
            return .cancel
        case "file":
            return docExt.contains(url.pathExtension.lowercased()) ? .document(url) : .cancel
        default:
            return .cancel
        }
    }
}

// ---- 原生桥:只接受来自应用自带页面主框架的、与当前页面匹配的命令 ----
enum BridgeGuard {
    enum Source { case home, reader, other }
    static func accept(command: String, mainFrame: Bool, source: Source, page: PageKind,
                       recent: [String], path: String? = nil) -> Bool {
        guard mainFrame else { return false }
        switch command {
        case "open": return source == .reader && page == .reader
        case "home:open", "home:bundle": return source == .home && page == .home
        case "home:recent":
            guard source == .home, page == .home, let p = path else { return false }
            return recent.contains(p)
        default: return false
        }
    }
}

final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var page: PageKind = .home
    let docHandler = DocSchemeHandler()
    let maxDocBytes = 32 << 20
    let maxBundleBytes = 64 << 20
    var ready = false
    var pending: URL?
    var pendingText: String?
    let recentKey = "recentFiles"
    let docRE = try! NSRegularExpression(pattern: #"\.(md|markdown|txt|html?|mdz|zip)$"#, options: .caseInsensitive)

    func applicationDidFinishLaunching(_ n: Notification) {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "native")
        cfg.setURLSchemeHandler(docHandler, forURLScheme: DocRoot.scheme)
        if let r = UserDefaults.standard.string(forKey: "docRoot") { docHandler.root = URL(fileURLWithPath: r) }
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Iris"
        window.contentView = web
        window.delegate = self
        window.setFrameAutosaveName("main")
        window.center()
        window.makeKeyAndOrderFront(nil)

        buildMenu()
        show(pending != nil ? .reader : .home)
        NSApp.activate(ignoringOtherApps: true)
    }

    // ---- 页面切换 ----
    func show(_ p: PageKind) {
        page = p; ready = false
        if p == .home { window.title = "Iris" }
        let name = p == .home ? "home" : "reader"
        guard let html = Bundle.main.url(forResource: name, withExtension: "html") else { return }
        web.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
    }

    // ---- 可信页面:只有应用包里的 home.html / reader.html ----
    func pageURL(_ name: String) -> String? {
        Bundle.main.url(forResource: name, withExtension: "html")?.resolvingSymlinksInPath().standardizedFileURL.path
    }
    func trustedKind(_ u: URL?) -> BridgeGuard.Source {
        guard let u = u, u.isFileURL else { return .other }
        let p = u.resolvingSymlinksInPath().standardizedFileURL.path
        if p == pageURL("home") { return .home }
        if p == pageURL("reader") { return .reader }
        return .other
    }

    // 主框架不得离开应用自带页面;链接改走原生流程
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let d = NavPolicy.decide(
            url: action.request.url,
            mainFrame: action.targetFrame?.isMainFrame ?? false,
            newWindow: action.targetFrame == nil,
            userClick: action.navigationType == .linkActivated,
            isTrusted: { self.trustedKind($0) != .other },
            resolveDoc: { DocRoot.resolve($0, root: self.docHandler.root) })
        switch d {
        case .allow: decisionHandler(.allow)
        case .cancel: decisionHandler(.cancel)
        case .external(let u): decisionHandler(.cancel); NSWorkspace.shared.open(u)
        case .document(let u):
            decisionHandler(.cancel)
            if FileManager.default.fileExists(atPath: u.path) { openDoc(u) }
        }
    }

    func webView(_ w: WKWebView, didFinish _: WKNavigation!) {
        ready = true
        if page == .home { pushRecent() }
        else if let u = pending { deliver(u); pending = nil }
        else if let t = pendingText { pendingText = nil; web.evaluateJavaScript("window.loadFromNative(\(json(t)), '剪贴板')") }
    }

    // Finder 双击 / 拖到 Dock 图标 / 「打开方式」
    func application(_ app: NSApplication, open urls: [URL]) {
        guard let u = urls.first else { return }
        openDoc(u)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }

    func openDoc(_ url: URL) {
        pending = url
        guard web != nil else { return }          // 启动阶段:didFinishLaunching 会处理
        if page != .reader { show(.reader) }
        else if ready { deliver(url); pending = nil }
    }

    func deliver(_ url: URL) {
        guard page == .reader, trustedKind(web.url) == .reader else { return }   // 只把内容交给应用自带的阅读页
        let name = url.lastPathComponent
        let isBundle = ["mdz", "zip"].contains(url.pathExtension.lowercased())
        guard (PathGuard.size(url) ?? 0) <= (isBundle ? maxBundleBytes : maxDocBytes) else {
            alert("文件太大", "\(name) 超过 \(isBundle ? 64 : 32) MB 上限,已拒绝打开。"); return
        }
        if isBundle {
            guard let data = try? Data(contentsOf: url) else { return }
            web.evaluateJavaScript("window.loadBundleB64(\(json(data.base64EncodedString())), \(json(name)))")
        } else {
            guard let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { return }
            // 文档里的相对路径资源经 irisdoc:// 提供,且只能读到该文档所在目录内的资源文件
            docHandler.root = url.deletingLastPathComponent()
            UserDefaults.standard.set(docHandler.root!.path, forKey: "docRoot")
            web.evaluateJavaScript("window.loadFromNative(\(json(text)), \(json(name)), \(json(DocRoot.base)))")
        }
        window.title = name
        NSDocumentController.shared.noteNewRecentDocumentURL(url)
        addRecent(url)
    }

    // ---- 最近打开 ----
    func recentPaths() -> [String] { UserDefaults.standard.stringArray(forKey: recentKey) ?? [] }
    func addRecent(_ url: URL) {
        let p = url.standardizedFileURL.path
        UserDefaults.standard.set(Array(([p] + recentPaths().filter { $0 != p }).prefix(10)), forKey: recentKey)
    }
    func pushRecent() {
        let list: [[String: Any]] = recentPaths().map { p in
            ["path": p, "name": (p as NSString).lastPathComponent,
             "dir": (p as NSString).deletingLastPathComponent,
             "exists": FileManager.default.fileExists(atPath: p)]
        }
        guard let d = try? JSONSerialization.data(withJSONObject: list),
              let s = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.setRecent(\(s))")
    }

    func json(_ s: String) -> String {
        let d = try! JSONSerialization.data(withJSONObject: [s])
        let a = String(data: d, encoding: .utf8)!
        return String(a.dropFirst().dropLast())
    }

    // ---- 面板 ----
    @objc func showOpenPanel() {
        let p = NSOpenPanel()
        p.allowedContentTypes = ["md", "markdown", "txt", "html", "htm", "mdz", "zip"].compactMap { UTType(filenameExtension: $0) }
        p.allowsMultipleSelection = false
        if p.runModal() == .OK, let u = p.url { openDoc(u) }
    }

    @objc func makeBundle() {
        let m = NSOpenPanel()
        m.message = "第 1 步:选择 Markdown 文件"
        m.allowedContentTypes = ["md", "markdown"].compactMap { UTType(filenameExtension: $0) }
        guard m.runModal() == .OK, let md = m.url else { return }

        let d = NSOpenPanel()
        d.message = "第 2 步:选择存放图片的文件夹(默认是 md 所在文件夹)"
        d.canChooseFiles = false; d.canChooseDirectories = true
        d.directoryURL = md.deletingLastPathComponent()
        guard d.runModal() == .OK, let dir = d.url else { return }

        let out: (zip: Data, count: Int, missing: [String])
        do { out = try MdzBundle.build(md: md, imgDir: dir) }
        catch { alert("合成失败", error.localizedDescription); return }

        let s = NSSavePanel()
        s.message = "第 3 步:保存图文包(以后直接打开这个文件即可)"
        s.directoryURL = md.deletingLastPathComponent()
        s.nameFieldStringValue = md.deletingPathExtension().lastPathComponent + ".mdz"
        if let t = UTType(filenameExtension: "mdz") { s.allowedContentTypes = [t] }
        guard s.runModal() == .OK, let dest = s.url else { return }
        do { try out.zip.write(to: dest) }
        catch { alert("保存失败", error.localizedDescription); return }

        if !out.missing.isEmpty {
            alert("部分图片没找到",
                  "已保存图文包,包含 \(out.count) 个图片文件。\n以下引用没有收进包(找不到、不是图片、超出大小限制,或在所选文件夹之外):\n\n"
                  + out.missing.prefix(15).joined(separator: "\n") + (out.missing.count > 15 ? "\n…" : ""))
        }
        openDoc(dest)
    }

    func alert(_ title: String, _ text: String) {
        let a = NSAlert(); a.messageText = title; a.informativeText = text; a.runModal()
    }

    @objc func goHome() { pending = nil; pendingText = nil; if page != .home { show(.home) } }

    // 网页 → 原生。字符串:阅读页的"打开文件"按钮;字典:首页按钮
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        let src = trustedKind(m.frameInfo.request.url)
        let main = m.frameInfo.isMainFrame
        if let cmd = m.body as? String {
            if cmd == "open", BridgeGuard.accept(command: cmd, mainFrame: main, source: src, page: page, recent: []) { showOpenPanel() }
            return
        }
        guard let d = m.body as? [String: Any], let cmd = d["cmd"] as? String,
              BridgeGuard.accept(command: cmd, mainFrame: main, source: src, page: page,
                                 recent: recentPaths(), path: d["path"] as? String) else { return }
        switch cmd {
        case "home:open": showOpenPanel()
        case "home:bundle": makeBundle()
        case "home:recent":
            guard let p = d["path"] as? String else { return }
            guard docRE.firstMatch(in: p, range: NSRange(p.startIndex..., in: p)) != nil else { return }
            if FileManager.default.fileExists(atPath: p) { openDoc(URL(fileURLWithPath: p)) }
            else { alert("这个文件已经不存在了", p) }
        default: break
        }
    }

    @objc func pasteMarkdown() {
        guard let t = NSPasteboard.general.string(forType: .string) else { return }
        if page != .reader || !ready { pending = nil; pendingText = t; if page != .reader { show(.reader) }; return }
        web.evaluateJavaScript("window.loadFromNative(\(json(t)), '剪贴板')")
    }
    @objc func printPage() { web.printOperation(with: NSPrintInfo.shared).run() }
    @objc func zoom(_ s: NSMenuItem) {
        web.pageZoom = s.tag == 0 ? 1 : max(0.5, min(3, web.pageZoom + (s.tag > 0 ? 0.1 : -0.1)))
    }

    func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let it = NSMenuItem(); main.addItem(it)
            let m = NSMenu(title: title); it.submenu = m
            items.forEach { m.addItem($0) }
        }
        let own: [Selector] = [#selector(showOpenPanel), #selector(pasteMarkdown), #selector(printPage),
                               #selector(zoom(_:)), #selector(makeBundle), #selector(goHome)]
        func mi(_ t: String, _ a: Selector?, _ k: String = "", tag: Int = 0, mod: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
            i.keyEquivalentModifierMask = mod; i.tag = tag
            if let a = a, own.contains(a) { i.target = self }
            return i
        }
        add("App", [mi("关于 Iris", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
                    .separator(), mi("隐藏 Iris", #selector(NSApplication.hide(_:)), "h"),
                    .separator(), mi("退出 Iris", #selector(NSApplication.terminate(_:)), "q")])
        add("文件", [mi("主页", #selector(goHome), "h", mod: [.command, .shift]),
                    mi("打开…", #selector(showOpenPanel), "o"),
                    mi("合成图文包并打开…", #selector(makeBundle), "b", mod: [.command, .shift]),
                    mi("粘贴为文档", #selector(pasteMarkdown), "v", mod: [.command, .shift]),
                    .separator(), mi("打印…", #selector(printPage), "p"),
                    mi("关闭窗口", #selector(NSWindow.performClose(_:)), "w")])
        add("编辑", [mi("拷贝", #selector(NSText.copy(_:)), "c"),
                    mi("全选", #selector(NSText.selectAll(_:)), "a"),
                    mi("粘贴", #selector(NSText.paste(_:)), "v"),
                    mi("剪切", #selector(NSText.cut(_:)), "x"),
                    mi("撤销", Selector(("undo:")), "z")])
        add("显示", [mi("放大", #selector(zoom(_:)), "=", tag: 1),
                    mi("缩小", #selector(zoom(_:)), "-", tag: -1),
                    mi("实际大小", #selector(zoom(_:)), "0", tag: 0)])
        NSApp.mainMenu = main
    }
}

final class DocSchemeHandler: NSObject, WKURLSchemeHandler {
    var root: URL?
    static let mime: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
        "svg": "image/svg+xml", "bmp": "image/bmp", "avif": "image/avif", "ico": "image/x-icon",
        "css": "text/css", "js": "text/javascript", "json": "application/json",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf",
        "html": "text/html", "htm": "text/html",
    ]
    func webView(_ w: WKWebView, start t: WKURLSchemeTask) {
        guard let url = t.request.url, let file = DocRoot.resolve(url, root: root),
              let mime = Self.mime[file.pathExtension.lowercased()],
              let size = PathGuard.size(file), size <= 64 << 20,
              let data = try? Data(contentsOf: file),
              let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": mime, "Content-Length": "\(data.count)",
                "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"])
        else { t.didFailWithError(URLError(.fileDoesNotExist)); return }
        t.didReceive(resp); t.didReceive(data); t.didFinish()
    }
    func webView(_ w: WKWebView, stop t: WKURLSchemeTask) {}
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
