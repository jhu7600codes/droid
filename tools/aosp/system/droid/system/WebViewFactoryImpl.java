package droid.system;

import android.content.Context;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewFactoryProvider;
import android.webkit.WebViewProvider;

/**
 * droid's WebView provider. kitkat's is chromium, which droid does not have: a WebView here is an empty
 * view (no page is drawn) whose settings, cookies and calls all work and do nothing, so apps and their
 * ad / sign-in SDKs that create one keep running.
 */
public class WebViewFactoryImpl extends droid.defaults.DefaultWebViewFactoryProvider {
    private final CookieManager cookies = new droid.defaults.DefaultCookieManager();
    @Override public Statics getStatics() {
        return new droid.defaults.DefaultStatics() {
            @Override public String getDefaultUserAgent(Context context) { return "Mozilla/5.0 (Linux; Android 4.4.4; Droid) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36"; }
            @Override public String findAddress(String addr) { return null; }
        };
    }
    @Override public CookieManager getCookieManager() { return cookies; }
    @Override public WebViewProvider createWebView(WebView webView, WebView.PrivateAccess access) { return new Provider(); }

    static class Provider extends droid.defaults.DefaultWebViewProvider {
        private final WebSettings settings = new droid.defaults.DefaultWebSettings() {
            @Override public String getUserAgentString() { return "Mozilla/5.0 (Linux; Android 4.4.4; Droid) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36"; }
            @Override public String getDefaultTextEncodingName() { return "UTF-8"; }
        };
        private String url;
        @Override public WebSettings getSettings() { return settings; }
        @Override public ViewDelegate getViewDelegate() { return new droid.defaults.DefaultViewDelegate(); }
        @Override public ScrollDelegate getScrollDelegate() { return new droid.defaults.DefaultScrollDelegate(); }
        @Override public void loadUrl(String u) { url = u; }
        @Override @SuppressWarnings("rawtypes") public void loadUrl(String u, java.util.Map headers) { url = u; }
        @Override public String getUrl() { return url; }
        @Override public String getOriginalUrl() { return url; }
        @Override public String getTitle() { return ""; }
    }
}
