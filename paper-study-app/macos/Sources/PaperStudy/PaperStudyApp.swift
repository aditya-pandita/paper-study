import SwiftUI
import WebKit
import AppKit
import UniformTypeIdentifiers

// Paper Study for macOS: a native window, menus, file pickers and storage around the
// study screens in Resources/web. The web files are served from the app bundle through
// the paperstudy:// scheme, so nothing touches the network.

@main
struct PaperStudyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var web = WebController()

    var body: some Scene {
        WindowGroup("Paper Study") {
            WebView(controller: web)
                .frame(minWidth: 760, minHeight: 560)
        }
        .defaultSize(width: 1100, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Import Pack Folder…") { web.importFolder() }
                    .keyboardShortcut("o")
                Button("Import pack.json…") { web.importFile() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
            }
            CommandGroup(after: .sidebar) {
                Button("Library") { web.run("window.PaperStudy && window.PaperStudy.goHome()") }
                    .keyboardShortcut("l")
                Button("Reload") { web.webView.reload() }
                    .keyboardShortcut("r")
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct WebView: NSViewRepresentable {
    let controller: WebController
    func makeNSView(context: Context) -> WKWebView { controller.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

final class WebController: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private let selfTest = ProcessInfo.processInfo.environment["PAPERSTUDY_SELFTEST"] == "1"

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persistent IndexedDB in the app's own container
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "paperstudy")
        let content = WKUserContentController()
        config.userContentController = content
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        content.add(self, name: "paperstudy")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isInspectable = true
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: URL(string: "paperstudy://app/index.html")!))
    }

    func run(_ js: String) { webView.evaluateJavaScript(js, completionHandler: nil) }

    // MARK: messages from the page
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "import-folder": importFolder()
        case "import-file": importFile()
        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(body["text"] as? String ?? "", forType: .string)
        case "selftest":
            print("SELFTEST " + (body["result"] as? String ?? "?"))
            fflush(stdout)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
        default: break
        }
    }

    // MARK: importing
    func importFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose a study pack folder (the one with manifest.json)"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        guard panel.runModal() == .OK, let dir = panel.url else { return }
        send(payload: PackReader.readFolder(dir))
    }

    func importFile() {
        let panel = NSOpenPanel()
        panel.title = "Choose a bundled .pack.json file"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        send(payload: ["files": [url.lastPathComponent: text], "assets": [String: Any]()])
    }

    private func send(payload: [String: Any]) {
        webView.callAsyncJavaScript("await window.PaperStudy.importRaw(payload)", arguments: ["payload": payload],
                                    in: nil, in: .page) { result in
            if case .failure(let error) = result { self.alert("Import failed", error.localizedDescription) }
        }
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert(); a.messageText = title; a.informativeText = text; a.runModal()
    }

    // MARK: navigation: keep the app inside the bundle, send web links to the browser
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(["paperstudy", "blob", "about"].contains(url.scheme ?? "") ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard selfTest else { return }
        run("""
        (async () => {
          const r = {};
          try {
            r.secure = window.isSecureContext; r.subtle = !!(window.crypto && crypto.subtle);
            r.bridge = !!window.PaperStudy; r.validator = !!window.PackValidator;
            const db = await new Promise((ok, bad) => { const q = indexedDB.open('selftest', 1);
              q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error); });
            const get = (k) => new Promise((ok) => { const g = db.transaction('kv').objectStore('kv').get(k); g.onsuccess = () => ok(g.result); });
            r.previousRun = (await get('stamp')) || null;
            await new Promise((ok) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(new Date().toISOString(), 'stamp'); t.oncomplete = ok; });
            r.indexedDB = 'ok';
            r.ui = document.querySelector('h1') ? document.querySelector('h1').textContent : 'no heading';
          } catch (e) { r.error = String(e); }
          window.webkit.messageHandlers.paperstudy.postMessage({ type: 'selftest', result: JSON.stringify(r) });
        })();
        """)
    }

    // target="_blank" links
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        alert(message, ""); completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
}

/// Serves Resources/web/* for paperstudy://app/<path>.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL!.appendingPathComponent("web")
    private let types = ["html": "text/html", "js": "text/javascript", "css": "text/css", "svg": "image/svg+xml",
                         "png": "image/png", "json": "application/json", "mp4": "video/mp4"]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        path = path.removingPercentEncoding ?? path
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            let r = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
            task.didReceive(r); task.didReceive(Data()); task.didFinish(); return
        }
        let mime = types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let headers = ["Content-Type": mime, "Content-Length": String(data.count)]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// Reads a pack folder into { files: {name: text}, assets: {path: {mime, text|base64}} }.
enum PackReader {
    static let mimes = ["svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                        "webp": "image/webp", "html": "text/html", "mp4": "video/mp4"]

    static func readFolder(_ dir: URL) -> [String: Any] {
        var files: [String: String] = [:]
        var assets: [String: [String: String]] = [:]
        let base = dir.standardizedFileURL.path + "/"
        let walker = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey],
                                                    options: [.skipsHiddenFiles])
        while let url = walker?.nextObject() as? URL {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let rel = String(url.standardizedFileURL.path.dropFirst(base.count))
            let ext = url.pathExtension.lowercased()
            // Nested paths are fine: the page finds manifest.json and strips any parent folder.
            if ext == "json" {
                if let text = try? String(contentsOf: url, encoding: .utf8) { files[rel] = text }
            } else if let mime = mimes[ext], rel.contains("visuals/") || ext == "html",
                      let data = try? Data(contentsOf: url) {
                if ext == "svg" || ext == "html" {
                    assets[rel] = ["mime": mime, "text": String(decoding: data, as: UTF8.self)]
                } else {
                    assets[rel] = ["mime": mime, "base64": data.base64EncodedString()]
                }
            }
        }
        return ["files": files, "assets": assets]
    }
}
