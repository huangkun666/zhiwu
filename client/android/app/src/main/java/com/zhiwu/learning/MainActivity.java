package com.zhiwu.learning;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.plugin.WebView;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final int NATIVE_VERSION = 2;
    private static final String OTA_PREFS = "ZhiwuOtaPrefs";
    private static final String KEY_OTA_VERSION = "otaVersion";
    private static final String KEY_OTA_NATIVE = "otaForNativeVersion";

    private final ExecutorService otaExecutor = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Clear any stale OTA bundle if a newer native APK was just installed
        SharedPreferences otaPrefs = getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
        int savedForNative = otaPrefs.getInt(KEY_OTA_NATIVE, 0);
        if (savedForNative > 0 && savedForNative < NATIVE_VERSION) {
            getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE)
                .edit()
                .remove(WebView.CAP_SERVER_PATH)
                .apply();
            otaPrefs.edit().clear().apply();
        }

        super.onCreate(savedInstanceState);

        // Apply system bars & display cutout insets (do NOT include IME so adjustResize never double-pads)
        View rootView = findViewById(android.R.id.content);
        if (rootView != null) {
            ViewCompat.setOnApplyWindowInsetsListener(rootView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return windowInsets;
            });
            ViewCompat.requestApplyInsets(rootView);
        }

        applySystemBarTheme(true);

        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new ZhiwuNativeBridge(), "ZhiwuNative");
        }
    }

    private void applySystemBarTheme(boolean isDark) {
        int bgColor = Color.parseColor(isDark ? "#09090B" : "#F6F7F9");
        View decor = getWindow().getDecorView();
        decor.setBackgroundColor(bgColor);
        View rootView = findViewById(android.R.id.content);
        if (rootView != null) {
            rootView.setBackgroundColor(bgColor);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), decor);
        if (controller != null) {
            controller.setAppearanceLightStatusBars(!isDark);
            controller.setAppearanceLightNavigationBars(!isDark);
        }
    }

    private void emitOtaEvent(String status, String message) {
        runOnUiThread(() -> {
            if (this.bridge == null || this.bridge.getWebView() == null) return;
            try {
                JSONObject obj = new JSONObject();
                obj.put("status", status);
                obj.put("message", message);
                String js = "window.__zhiwuOtaEvent && window.__zhiwuOtaEvent(" + obj.toString() + ");";
                this.bridge.getWebView().evaluateJavascript(js, null);
            } catch (Exception ignored) {}
        });
    }

    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File c : children) deleteRecursive(c);
            }
        }
        file.delete();
    }

    private class ZhiwuNativeBridge {
        @JavascriptInterface
        public void setTheme(boolean isDark) {
            runOnUiThread(() -> applySystemBarTheme(isDark));
        }

        @JavascriptInterface
        public String getOtaState() {
            try {
                SharedPreferences otaPrefs = getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE);
                SharedPreferences capPrefs = getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
                String path = capPrefs.getString(WebView.CAP_SERVER_PATH, "");
                JSONObject obj = new JSONObject();
                obj.put("isNative", true);
                obj.put("nativeVersion", NATIVE_VERSION);
                obj.put("otaVersion", otaPrefs.getString(KEY_OTA_VERSION, ""));
                obj.put("isOtaActive", path != null && !path.isEmpty() && new File(path).exists());
                return obj.toString();
            } catch (Exception e) {
                return "{\"isNative\":true,\"nativeVersion\":" + NATIVE_VERSION + ",\"otaVersion\":\"\",\"isOtaActive\":false}";
            }
        }

        @JavascriptInterface
        public void applyOtaUpdate(String downloadUrl, String newVersion, String githubToken) {
            otaExecutor.execute(() -> {
                HttpURLConnection conn = null;
                File tempZip = null;
                try {
                    emitOtaEvent("downloading", "正在下载更新包...");

                    // Follow redirects manually so Authorization header is sent to api.github.com
                    // but stripped on redirected S3/CDN asset URLs (prevents AWS S3 400 error).
                    String currentUrl = downloadUrl;
                    boolean sendAuth = githubToken != null && !githubToken.trim().isEmpty();
                    for (int redirects = 0; redirects < 6; redirects++) {
                        conn = (HttpURLConnection) new URL(currentUrl).openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(45000);
                        conn.setRequestProperty("User-Agent", "Zhiwu-Android-OTA");
                        if (sendAuth && currentUrl.contains("api.github.com")) {
                            conn.setRequestProperty("Authorization", "Bearer " + githubToken.trim());
                            conn.setRequestProperty("Accept", "application/octet-stream");
                        } else if (sendAuth && currentUrl.contains("github.com")) {
                            conn.setRequestProperty("Authorization", "Bearer " + githubToken.trim());
                        }
                        int code = conn.getResponseCode();
                        if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                            String loc = conn.getHeaderField("Location");
                            conn.disconnect();
                            if (loc == null || loc.isEmpty()) throw new Exception("重定向地址为空");
                            currentUrl = loc;
                            continue;
                        }
                        if (code < 200 || code >= 300) {
                            throw new Exception("下载更新包失败 (HTTP " + code + ")");
                        }
                        break;
                    }

                    File otaRoot = new File(getFilesDir(), "ota");
                    if (!otaRoot.exists()) otaRoot.mkdirs();
                    tempZip = new File(otaRoot, "bundle.zip");

                    try (InputStream in = new BufferedInputStream(conn.getInputStream());
                         FileOutputStream out = new FileOutputStream(tempZip)) {
                        byte[] buf = new byte[16384];
                        int n;
                        long total = 0;
                        while ((n = in.read(buf)) != -1) {
                            out.write(buf, 0, n);
                            total += n;
                        }
                        if (total < 1024) {
                            throw new Exception("下载的文件异常过小，请检查网络或 Token 权限");
                        }
                    }

                    emitOtaEvent("extracting", "正在校验并解压新版本...");
                    String safeDirName = "v_" + System.currentTimeMillis();
                    File targetDir = new File(otaRoot, safeDirName);
                    targetDir.mkdirs();
                    String canonicalRoot = targetDir.getCanonicalPath() + File.separator;

                    try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new java.io.FileInputStream(tempZip)))) {
                        ZipEntry entry;
                        byte[] buf = new byte[16384];
                        while ((entry = zis.getNextEntry()) != null) {
                            File outFile = new File(targetDir, entry.getName());
                            String canonicalFile = outFile.getCanonicalPath();
                            if (!canonicalFile.startsWith(canonicalRoot)) {
                                throw new SecurityException("非法压缩包路径");
                            }
                            if (entry.isDirectory()) {
                                outFile.mkdirs();
                            } else {
                                File parent = outFile.getParentFile();
                                if (parent != null && !parent.exists()) parent.mkdirs();
                                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                                    int len;
                                    while ((len = zis.read(buf)) > 0) {
                                        fos.write(buf, 0, len);
                                    }
                                }
                            }
                            zis.closeEntry();
                        }
                    }

                    File indexFile = new File(targetDir, "index.html");
                    if (!indexFile.exists()) {
                        deleteRecursive(targetDir);
                        throw new Exception("更新包缺少 index.html，已自动取消应用");
                    }

                    // Clean old OTA bundles to save phone storage
                    File[] oldDirs = otaRoot.listFiles();
                    if (oldDirs != null) {
                        for (File f : oldDirs) {
                            if (f.isDirectory() && !f.getName().equals(safeDirName)) {
                                deleteRecursive(f);
                            }
                        }
                    }
                    if (tempZip.exists()) tempZip.delete();

                    // Persist new serverBasePath in Capacitor prefs & reload live!
                    getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE)
                        .edit()
                        .putString(WebView.CAP_SERVER_PATH, targetDir.getAbsolutePath())
                        .apply();
                    getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE)
                        .edit()
                        .putString(KEY_OTA_VERSION, newVersion)
                        .putInt(KEY_OTA_NATIVE, NATIVE_VERSION)
                        .apply();

                    emitOtaEvent("done", "热更新完成，正在加载新版本...");
                    runOnUiThread(() -> {
                        if (bridge != null) {
                            bridge.setServerBasePath(targetDir.getAbsolutePath());
                        }
                    });
                } catch (Exception e) {
                    if (tempZip != null && tempZip.exists()) tempZip.delete();
                    emitOtaEvent("error", e.getMessage() != null ? e.getMessage() : "热更新失败");
                } finally {
                    if (conn != null) conn.disconnect();
                }
            });
        }

        @JavascriptInterface
        public void resetOtaUpdate() {
            getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE)
                .edit()
                .remove(WebView.CAP_SERVER_PATH)
                .apply();
            getSharedPreferences(OTA_PREFS, Activity.MODE_PRIVATE).edit().clear().apply();
            runOnUiThread(() -> {
                if (bridge != null) {
                    bridge.setServerAssetPath("public");
                }
            });
        }
    }
}
