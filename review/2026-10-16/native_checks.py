"""Generate native probes from the Swift implementation; use synthetic data only.

Updated after the fixes: probes now also exercise the production NavPolicy / BridgeGuard / PathGuard code
(extracted verbatim from src/main.swift) and end with a PASS/FAIL summary."""
from pathlib import Path
import subprocess, tempfile, json

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
source = (ROOT / 'src/main.swift').read_text()
fixture = Path(tempfile.mkdtemp(prefix='iris-review-'))
(fixture / 'docs/images').mkdir(parents=True)
(fixture / 'outside').mkdir()
(fixture / 'outside/private.txt').write_text('IRIS_SYNTHETIC_PRIVATE_MARKER')
(fixture / 'docs/images/ok.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'synthetic-ok')
(fixture / 'docs/index.md').write_text('# Test\n![not-an-image](../outside/private.txt)\n![ok](images/ok.png)')
(fixture / 'docs/images/innocent.png').symlink_to(fixture / 'outside/private.txt')
enum = source[source.index('enum PageKind'):source.index('final class App:')]
packaging = 'import Foundation\n' + enum + '\n' + f'''
let result = try MdzBundle.build(md: URL(fileURLWithPath: {json.dumps(str(fixture / 'docs/index.md'))}), imgDir: URL(fileURLWithPath: {json.dumps(str(fixture / 'docs/images'))}))
try result.zip.write(to: URL(fileURLWithPath: {json.dumps(str(OUT / 'synthetic-result.mdz'))}))
print("synthetic package entries: \\(result.count)")
'''
(OUT / 'package-probe.swift').write_text(packaging)
subprocess.run(['xcrun', 'swift', '-module-cache-path', '/private/tmp/iris-review-modulecache', str(OUT / 'package-probe.swift')], check=True)
import zipfile
with zipfile.ZipFile(OUT / 'synthetic-result.mdz') as z:
    entries = [{'name': n, 'includesSyntheticSecret': b'IRIS_SYNTHETIC_PRIVATE_MARKER' in z.read(n)} for n in z.namelist()]
(OUT / 'package-results.json').write_text(json.dumps(entries, indent=2)+'\n')
print(json.dumps(entries, indent=2))
SUMMARY = []
SUMMARY.append(('1 bundle: no synthetic secret in package', not any(e['includesSyntheticSecret'] for e in entries)))
SUMMARY.append(('1 bundle: legitimate image still included', any(e['name'] == 'images/ok.png' for e in entries)))

# Pure-policy checks against the production NavPolicy / BridgeGuard (no WebKit needed).
policy = 'import Foundation\n' + enum + r'''
let reader = URL(string: "file:///app/reader.html")!
let trusted: (URL) -> Bool = { $0.path == "/app/reader.html" }
let docs: (URL) -> URL? = { _ in URL(fileURLWithPath: "/tmp/d/other.md") }
func d(_ u: String, main: Bool = true, win: Bool = false, click: Bool = true) -> NavDecision {
    NavPolicy.decide(url: URL(string: u), mainFrame: main, newWindow: win, userClick: click, isTrusted: trusted, resolveDoc: docs)
}
var r: [String: Bool] = [:]
r["nav: trusted page/anchor allowed"] = d("file:///app/reader.html#sec", click: false) == .allow
r["nav: foreign local html not allowed in main frame"] = d("file:///tmp/outside/navigation.html") != .allow
r["nav: foreign local html routed to native open"] = d("file:///tmp/outside/navigation.html") == .document(URL(string: "file:///tmp/outside/navigation.html")!)
r["nav: non-click foreign navigation cancelled"] = d("file:///tmp/outside/navigation.html", click: false) == .cancel
r["nav: https opens externally"] = d("https://example.com/") == .external(URL(string: "https://example.com/")!)
r["nav: javascript: cancelled"] = d("javascript:alert(1)") == .cancel
r["nav: non-doc file cancelled"] = d("file:///etc/passwd") == .cancel
r["nav: irisdoc md link opens natively"] = d("irisdoc://doc/other.md") == .document(URL(fileURLWithPath: "/tmp/d/other.md"))
r["nav: sandboxed iframe navigation unaffected"] = d("about:srcdoc", main: false) == .allow
r["bridge: iframe cannot call home:recent"] = !BridgeGuard.accept(command: "home:recent", mainFrame: false, source: .other, page: .home, recent: ["/a.md"], path: "/a.md")
r["bridge: main frame foreign page rejected"] = !BridgeGuard.accept(command: "home:open", mainFrame: true, source: .other, page: .home, recent: [])
r["bridge: reader page cannot issue home commands"] = !BridgeGuard.accept(command: "home:open", mainFrame: true, source: .reader, page: .reader, recent: [])
r["bridge: home:recent needs native list membership"] = !BridgeGuard.accept(command: "home:recent", mainFrame: true, source: .home, page: .home, recent: [], path: "/synthetic/private.txt")
r["bridge: legit home:recent accepted"] = BridgeGuard.accept(command: "home:recent", mainFrame: true, source: .home, page: .home, recent: ["/a.md"], path: "/a.md")
r["bridge: legit reader open accepted"] = BridgeGuard.accept(command: "open", mainFrame: true, source: .reader, page: .reader, recent: [])
for (k, v) in r.sorted(by: { $0.key < $1.key }) { print("\(v ? "PASS" : "FAIL") \(k)") }
'''
(OUT / 'policy-probe.swift').write_text(policy)
subprocess.run(['xcrun', 'swiftc', '-module-cache-path', '/private/tmp/iris-review-modulecache', str(OUT / 'policy-probe.swift'), '-o', str(fixture / 'policy-probe')], check=True)
pr = subprocess.run([str(fixture / 'policy-probe')], capture_output=True, text=True, timeout=30)
(OUT / 'policy-results.txt').write_text(pr.stdout + pr.stderr)
print(pr.stdout, pr.stderr)
for line in pr.stdout.splitlines():
    SUMMARY.append((line[5:], line.startswith('PASS')))

# Exercise the real reader HTML with the same unrestricted read root and native bridge setup as App.
probe = r'''
import Cocoa
import WebKit
final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    var window: NSWindow!
    func run() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.userContentController.add(self, name: "native")
        web = WKWebView(frame: NSRect(x:0,y:0,width:800,height:600), configuration:cfg)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x:0,y:0,width:800,height:600), styleMask:[.titled], backing:.buffered, defer:false)
        window.contentView = web
        web.loadFileURL(URL(fileURLWithPath: READER_PATH), allowingReadAccessTo: URL(fileURLWithPath:"/"))
        DispatchQueue.main.asyncAfter(deadline:.now()+20) { print("PROBE_TIMEOUT"); exit(2) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let html = "<!doctype html><body><script>window.webkit.messageHandlers.native.postMessage({cmd:'home:recent',path:'/synthetic/private.txt'});</script></body>"
        let data = try! JSONSerialization.data(withJSONObject:[html])
        let literal = String(data:data,encoding:.utf8)!.dropFirst().dropLast()
        web.evaluateJavaScript("window.loadFromNative(\(literal), 'attack.html', '')") { _,error in
            if let e = error { print("JS_ERROR: \(e)") }
        }
    }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        print("NATIVE_BRIDGE_RECEIVED mainFrame=\(m.frameInfo.isMainFrame) body=\(m.body)")
        fflush(stdout)
        NSApp.terminate(nil)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe()
probe.run()
app.run()
'''.replace('READER_PATH', json.dumps(str(ROOT / 'dist/reader.html')))
bridge_src = probe.replace('        NSApp.terminate(nil)', '        print("PRODUCTION_GUARD_ACCEPTS_THIS_MESSAGE=\\(BridgeGuard.accept(command: "home:recent", mainFrame: m.frameInfo.isMainFrame, source: .other, page: .home, recent: ["/synthetic/private.txt"], path: "/synthetic/private.txt"))")\n        NSApp.terminate(nil)', 1) + '\n' + enum
(OUT / 'bridge-probe.swift').write_text(bridge_src)
subprocess.run(['xcrun', 'swiftc', '-module-cache-path', '/private/tmp/iris-review-modulecache', str(OUT / 'bridge-probe.swift'), '-o', str(fixture / 'bridge-probe')], check=True)
r = subprocess.run([str(fixture / 'bridge-probe')], capture_output=True, text=True, timeout=30)
(OUT / 'bridge-results.txt').write_text(r.stdout+r.stderr)
print(r.stdout, r.stderr)
if r.returncode: raise SystemExit(r.returncode)
SUMMARY.append(('2 bridge: iframe message rejected by production guard', 'mainFrame=false' in r.stdout and 'PRODUCTION_GUARD_ACCEPTS_THIS_MESSAGE=false' in r.stdout))

sanitize_js = r'''window.__irisReviewXSS=0;
window.loadFromNative('# Title\n\n<script>window.__irisReviewXSS=1</script>\n<img src="missing" onerror="window.__irisReviewXSS=1">\n[bad](javascript:alert(1))','safe.md','');
setTimeout(()=>window.webkit.messageHandlers.native.postMessage(JSON.stringify({
test:'basic-Markdown-sanitization',
passed:window.__irisReviewXSS===0&&!document.querySelector('#view script,#view [onerror],#view a[href^="javascript:"]')
})),100);'''
start = probe.index('        let html =')
stop = probe.index('    func userContentController(', start)
sanitize_probe = probe[:start] + '        web.evaluateJavaScript(' + json.dumps(sanitize_js) + ')\n    }\n' + probe[stop:]
(OUT / 'sanitization-probe.swift').write_text(sanitize_probe)
subprocess.run(['xcrun', 'swiftc', '-module-cache-path', '/private/tmp/iris-review-modulecache', str(OUT / 'sanitization-probe.swift'), '-o', str(fixture / 'sanitization-probe')], check=True)
r = subprocess.run([str(fixture / 'sanitization-probe')], capture_output=True, text=True, timeout=30)
(OUT / 'sanitization-results.txt').write_text(r.stdout+r.stderr)
print(r.stdout, r.stderr)
if r.returncode: raise SystemExit(r.returncode)
SUMMARY.append(('sanitization: basic XSS samples neutralised', '"passed":true' in r.stdout))

# Run ZIP checks inside the macOS system WebKit engine as well as the JS unit probe.
import io, base64
cases = []
def archive_case(label, content, compression, corrupt=False, bad_size=False):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=compression) as z:
        z.writestr('index.md', content)
    data = bytearray(buf.getvalue())
    cd = data.index(b'PK\x01\x02')
    if corrupt: data[38] ^= 1
    if bad_size:
        import struct
        struct.pack_into('<I', data, 22, 1)
        struct.pack_into('<I', data, cd+24, 1)
    cases.append({'name': label, 'inputBytes':len(data), 'b64':base64.b64encode(data).decode()})
archive_case('valid store', b'# hello', zipfile.ZIP_STORED)
archive_case('CRC mismatch', b'# hello', zipfile.ZIP_STORED, corrupt=True)
archive_case('valid deflate', b'# hello', zipfile.ZIP_DEFLATED)
archive_case('false declared size: 1 byte', b'A'*(2*1024*1024), zipfile.ZIP_DEFLATED, bad_size=True)
zip_js = '''(async()=>{
const results=[];
for (const c of CASES) {
 const bytes=Uint8Array.from(atob(c.b64), x=>x.charCodeAt(0));
 try { const entries=await unzip(bytes.buffer); results.push({name:c.name,inputBytes:c.inputBytes,accepted:true,outputBytes:entries.reduce((s,e)=>s+e[1].length,0)}) }
 catch(e) {results.push({name:c.name,accepted:false,error:String(e)})}
}
window.webkit.messageHandlers.native.postMessage(JSON.stringify(results));
})()'''.replace('CASES', json.dumps(cases))
start = probe.index('        let html =')
stop = probe.index('    func userContentController(', start)
zip_probe = probe[:start] + '        web.evaluateJavaScript(' + json.dumps(zip_js) + ')\n    }\n' + probe[stop:]
(OUT / 'zip-probe.swift').write_text(zip_probe)
subprocess.run(['xcrun', 'swiftc', '-module-cache-path', '/private/tmp/iris-review-modulecache', str(OUT / 'zip-probe.swift'), '-o', str(fixture / 'zip-probe')], check=True)
r = subprocess.run([str(fixture / 'zip-probe')], capture_output=True, text=True, timeout=30)
(OUT / 'zip-results.txt').write_text(r.stdout+r.stderr)
print(r.stdout, r.stderr)
if r.returncode: raise SystemExit(r.returncode)
zr = {c['name']: c for c in json.loads(r.stdout[r.stdout.index('body=')+5:].strip())}
SUMMARY.append(('4 zip: valid store accepted', zr['valid store']['accepted'] and zr['valid store']['outputBytes'] == 7))
SUMMARY.append(('4 zip: valid deflate accepted', zr['valid deflate']['accepted'] and zr['valid deflate']['outputBytes'] == 7))
SUMMARY.append(('4 zip: CRC mismatch rejected', not zr['CRC mismatch']['accepted']))
SUMMARY.append(('4 zip: false declared size rejected', not zr['false declared size: 1 byte']['accepted']))

# Click an actual sanitized Markdown link, then simulate the same evaluateJavaScript
# delivery used by App.deliver. The destination and delivered content are synthetic.
destination = fixture / 'outside/navigation.html'
destination.write_text('''<!doctype html><body>synthetic destination<script>
window.loadFromNative = text => window.webkit.messageHandlers.native.postMessage({test:'next-open-captured',text});
</script></body>''')
navigation_probe = probe.replace('final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler', 'final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler')
start = navigation_probe.index('    func webView(')
stop = navigation_probe.index('    func userContentController(', start)
navigation_probe = navigation_probe[:start] + r'''
    var loads = 0
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // same decision function as production App.webView(_:decidePolicyFor:)
        let d = NavPolicy.decide(url: action.request.url, mainFrame: action.targetFrame?.isMainFrame ?? false,
                                 newWindow: action.targetFrame == nil, userClick: action.navigationType == .linkActivated,
                                 isTrusted: { $0.path == READER_PATH_LIT }, resolveDoc: { _ in nil })
        print("NAV_DECISION \(action.request.url?.absoluteString ?? "nil") type=\(action.navigationType.rawValue) -> \(d)")
        if case .allow = d { decisionHandler(.allow) } else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loads += 1
        print("MAIN_NAVIGATION \(web.url?.absoluteString ?? "nil")")
        if loads == 1 {
            let md = MARKDOWN_LINK
            let data = try! JSONSerialization.data(withJSONObject:[md])
            let literal = String(data:data,encoding:.utf8)!.dropFirst().dropLast()
            web.evaluateJavaScript("window.loadFromNative(\(literal), 'attack.md', ''); document.querySelector('#view a').click()") { _,error in
                if let e = error { print("JS_ERROR: \(e)") }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                print("FINAL_MAIN_URL \(self.web.url?.absoluteString ?? "nil")")
                self.web.evaluateJavaScript("window.loadFromNative('IRIS_SYNTHETIC_NEXT_OPEN_CONTENT', 'private.txt', ''); document.querySelector('#view').innerText") { v, _ in
                    print("RENDERED_BY_TRUSTED_READER \(v ?? "nil")")
                    fflush(stdout); NSApp.terminate(nil)
                }
            }
        }
    }
'''.replace('MARKDOWN_LINK', json.dumps('[continue](' + str(destination) + ')')).replace('READER_PATH_LIT', json.dumps(str(ROOT / 'dist/reader.html'))) + navigation_probe[stop:]
navigation_src = navigation_probe + '\n' + enum
(OUT / 'navigation-probe.swift').write_text(navigation_src)
subprocess.run(['xcrun', 'swiftc', '-module-cache-path', '/private/tmp/iris-review-modulecache', str(OUT / 'navigation-probe.swift'), '-o', str(fixture / 'navigation-probe')], check=True)
r = subprocess.run([str(fixture / 'navigation-probe')], capture_output=True, text=True, timeout=30)
(OUT / 'navigation-results.txt').write_text(r.stdout+r.stderr)
print(r.stdout, r.stderr)
if r.returncode: raise SystemExit(r.returncode)
SUMMARY.append(('3 navigation: main frame stays on trusted reader', f"FINAL_MAIN_URL file://{ROOT / 'dist/reader.html'}" in r.stdout))
SUMMARY.append(('3 navigation: next-open content not captured by untrusted page', 'RENDERED_BY_TRUSTED_READER' in r.stdout and 'next-open-captured' not in r.stdout))

print('\n=== SUMMARY ===')
bad = 0
for name, ok in SUMMARY:
    print(('PASS ' if ok else 'FAIL ') + name); bad += (not ok)
(OUT / 'summary.txt').write_text('\n'.join(('PASS ' if ok else 'FAIL ') + n for n, ok in SUMMARY) + '\n')
raise SystemExit(1 if bad else 0)
