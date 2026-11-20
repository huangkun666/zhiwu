package com.zhiwu.learning;

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

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Apply real system bar + display cutout + keyboard insets so the WebView
        // never overlaps the Android 15/16 status bar or bottom navigation pill.
        View rootView = findViewById(android.R.id.content);
        if (rootView != null) {
            ViewCompat.setOnApplyWindowInsetsListener(rootView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout()
                        | WindowInsetsCompat.Type.ime()
                );
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(rootView);
        }

        // Default to dark theme chrome until web layer syncs saved preference
        applySystemBarTheme(true);

        // Expose lightweight theme sync hook so switching Dark/Light updates Android status bar icons live
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void setTheme(boolean isDark) {
                    runOnUiThread(() -> applySystemBarTheme(isDark));
                }
            }, "ZhiwuNative");
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
}
