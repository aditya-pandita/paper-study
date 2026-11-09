package local.paperstudy.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;
import android.view.WindowInsets;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Paper Study for Android: a full-screen WebView that serves the shared study screens from the
 * APK's assets at https://appassets.androidplatform.net (a secure origin, so IndexedDB and
 * WebCrypto work), plus native pickers for pack folders and pack.json bundles.
 */
public class MainActivity extends Activity {
    private static final String TAG = "PaperStudy";
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/assets/web/index.html";
    private static final int PICK_FOLDER = 1, PICK_FILE = 2;
    private static final Map<String, String> MIME = Map.of(
            "svg", "image/svg+xml", "png", "image/png", "jpg", "image/jpeg", "jpeg", "image/jpeg",
            "webp", "image/webp", "html", "text/html", "mp4", "video/mp4");

    private WebView web;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        boolean night = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        int bg = Color.parseColor(night ? "#1C1C1A" : "#FAF9F5");
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(bg);
        web = new WebView(this);
        web.setBackgroundColor(bg);
        root.addView(web);
        setContentView(root);
        // Dark status/navigation icons on the light theme, light icons on the dark one.
        if (Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null) {
            int light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            getWindow().getInsetsController().setSystemBarsAppearance(night ? 0 : light, light);
        }
        // Keep content clear of the status and navigation bars (targetSdk 35+ draws edge to edge).
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
            }
            return WindowInsets.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        boolean selfTest = getIntent().getBooleanExtra("selftest", false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.toString().startsWith(ORIGIN)) return false;
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto")) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (selfTest) runSelfTest();
            }
        });
        web.setWebChromeClient(new WebChromeClient() { // default alert/confirm dialogs; page console goes to logcat
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                Log.i(TAG, "console " + m.messageLevel() + ": " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        // Bridge only for our own origin; the page calls PaperStudyAndroid.postMessage(json).
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "PaperStudyAndroid", Collections.singleton(ORIGIN),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (isMainFrame && message.getData() != null) onBridgeMessage(message.getData());
                    });
        }

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBackOrFinish);
        }
        if (state != null) web.restoreState(state); else web.loadUrl(START);
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { goBackOrFinish(); }

    // Back closes an open sheet or menu in the page first, then steps back through screens.
    private void goBackOrFinish() {
        web.evaluateJavascript("window.PaperStudy && window.PaperStudy.onBack ? window.PaperStudy.onBack() : false", handled -> {
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack(); else finish();
        });
    }

    // ---------- messages from the page ----------
    private void onBridgeMessage(String json) {
        try {
            JSONObject m = new JSONObject(json);
            switch (m.optString("type")) {
                case "import-folder": pick(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_FOLDER); break;
                case "import-file": pick(openDocument("application/json", "text/plain", "application/octet-stream"), PICK_FILE); break;
                case "copy":
                    ClipboardManager cm = getSystemService(ClipboardManager.class);
                    cm.setPrimaryClip(ClipData.newPlainText("Study pack issues", m.optString("text")));
                    if (Build.VERSION.SDK_INT < 33) Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show();
                    break;
                case "selftest": Log.i(TAG, "SELFTEST " + m.optString("result")); break;
                case "haptic": {
                    String kind = m.optString("kind");
                    int fb = android.view.HapticFeedbackConstants.CLOCK_TICK;
                    if (Build.VERSION.SDK_INT >= 30) {
                        if ("confirm".equals(kind)) fb = android.view.HapticFeedbackConstants.CONFIRM;
                        else if ("reject".equals(kind)) fb = android.view.HapticFeedbackConstants.REJECT;
                    }
                    web.performHapticFeedback(fb);
                    break;
                }
                default: break;
            }
        } catch (Exception e) { Log.w(TAG, "bad bridge message", e); }
    }

    private Intent openDocument(String... types) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, types);
        return i;
    }

    @SuppressWarnings("deprecation")
    private void pick(Intent i, int code) {
        try { startActivityForResult(i, code); }
        catch (Exception e) { Toast.makeText(this, "No file picker available", Toast.LENGTH_LONG).show(); }
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        io.execute(() -> {
            try {
                if (code == PICK_FOLDER) {
                    JSONObject payload = readTree(uri);
                    callJs("window.PaperStudy.importRaw(" + payload + ")");
                } else if (code == PICK_FILE) {
                    JSONObject files = new JSONObject().put("pack.json", new String(readAll(uri), StandardCharsets.UTF_8));
                    callJs("window.PaperStudy.importRaw(" + new JSONObject().put("files", files).put("assets", new JSONObject()) + ")");
                }
            } catch (Exception e) {
                Log.w(TAG, "import failed", e);
                ui.post(() -> Toast.makeText(this, "Import failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        });
    }

    private void callJs(String js) { ui.post(() -> web.evaluateJavascript(js, null)); }

    // ---------- reading a pack folder through the Storage Access Framework ----------
    private JSONObject readTree(Uri tree) throws Exception {
        JSONObject files = new JSONObject(), assets = new JSONObject();
        String rootDoc = DocumentsContract.getTreeDocumentId(tree);
        walk(tree, rootDoc, "", files, assets);
        return new JSONObject().put("files", files).put("assets", assets);
    }

    private void walk(Uri tree, String docId, String prefix, JSONObject files, JSONObject assets) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] cols = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE};
        try (Cursor c = getContentResolver().query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                if (name == null || name.startsWith(".")) continue;
                String rel = prefix + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(tree, id, rel + "/", files, assets);
                    continue;
                }
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                // Nested paths are fine: the page finds manifest.json and strips any parent folder.
                if (ext.equals("json")) {
                    files.put(rel, new String(readAll(doc), StandardCharsets.UTF_8));
                } else if (MIME.containsKey(ext) && (rel.contains("visuals/") || ext.equals("html"))) {
                    byte[] bytes = readAll(doc);
                    JSONObject a = new JSONObject().put("mime", MIME.get(ext));
                    if (ext.equals("svg") || ext.equals("html")) a.put("text", new String(bytes, StandardCharsets.UTF_8));
                    else a.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    assets.put(rel, a);
                }
            }
        }
    }

    private byte[] readAll(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    // ---------- self-test: adb shell am start -n local.paperstudy.android/.MainActivity --ez selftest true ----------
    private void runSelfTest() {
        web.evaluateJavascript(
            "(async () => { const r = {};" +
            " try { r.secure = isSecureContext; r.subtle = !!(crypto && crypto.subtle); r.bridge = !!window.PaperStudyAndroid;" +
            "  r.app = !!window.PaperStudy; r.validator = !!window.PackValidator;" +
            "  const db = await new Promise((ok, bad) => { const q = indexedDB.open('selftest', 1);" +
            "   q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error); });" +
            "  r.previousRun = await new Promise((ok) => { const g = db.transaction('kv').objectStore('kv').get('stamp'); g.onsuccess = () => ok(g.result || null); });" +
            "  await new Promise((ok) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(new Date().toISOString(), 'stamp'); t.oncomplete = ok; });" +
            "  r.indexedDB = 'ok'; await new Promise((ok) => setTimeout(ok, 1500));" +
            "  r.screen = (document.querySelector('main') || {}).innerText || ''; r.screen = r.screen.slice(0, 80);" +
            "  r.size = innerWidth + 'x' + innerHeight; } catch (e) { r.error = String(e); }" +
            " PaperStudyAndroid.postMessage(JSON.stringify({ type: 'selftest', result: JSON.stringify(r) })); })()", null);
    }
}
