package app.whatsappcentral;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.widget.Toast;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.net.HttpURLConnection;

/** A janela do app: mostra a mesma tela do Mac, servida pelo Node dentro do celular. */
public class MainActivity extends Activity {
    private WebView web;
    private String pendingChat;
    private boolean loaded = false;
    private PermissionRequest pendingMic;
    private ValueCallback<Uri[]> pendingFiles;
    private static final int REQ_MIC = 2;
    private static final int REQ_FILES = 3;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        web.setBackgroundColor(0xFF161615);
        // A tela vai até as bordas (Android 15). O recuo fica numa moldura em volta da
        // página, porque a WebView ignora o próprio recuo. Ele evita a barra de status,
        // a câmera, a barra de navegação e o teclado.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF161615);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets s = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(s.left, s.top, s.right, s.bottom);
            return WindowInsets.CONSUMED;
        });
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                // Links de mensagens abrem no navegador.
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url.startsWith(NodeService.BASE)) openPendingChat();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // A tela pede o microfone para gravar uma mensagem de voz.
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean audio = false;
                    for (String r : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                    }
                    if (!audio) {
                        request.deny();
                    } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingMic = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }

            // O botão de foto abre o seletor de fotos do Android.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILES);
                } catch (Exception e) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(root);
        web.loadData("<body style='background:#161615;color:#9a978f;font:16px sans-serif;"
                + "display:grid;place-items:center;height:90vh'>Starting...</body>", "text/html", "utf-8");

        startForegroundService(new Intent(this, NodeService.class));
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        handleIntent(getIntent());
        waitForServer();
    }

    /** Espera o servidor responder (na primeira abertura ele descompacta e demora mais). */
    private void waitForServer() {
        new Thread(() -> {
            for (int i = 0; i < 300; i++) {
                try {
                    HttpURLConnection c = NodeService.open("/");
                    if (c.getResponseCode() == 200) {
                        runOnUiThread(() -> {
                            loaded = true;
                            web.loadUrl(NodeService.BASE + "/");
                        });
                        return;
                    }
                } catch (Exception ignored) {
                }
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_MIC && pendingMic != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingMic.deny();
            }
            pendingMic = null;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQ_FILES && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingFiles = null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
        if (loaded) openPendingChat();
    }

    private void handleIntent(Intent intent) {
        String chat = intent == null ? null : intent.getStringExtra("chat");
        if (chat != null) pendingChat = chat;
        if (intent != null && intent.getBooleanExtra("pinWidget", false)) pinWidget();
    }

    /** Pede à tela inicial para colocar o widget. O Android mostra uma confirmação. */
    void pinWidget() {
        AppWidgetManager mgr = getSystemService(AppWidgetManager.class);
        boolean ok = mgr.isRequestPinAppWidgetSupported()
                && mgr.requestPinAppWidget(new ComponentName(this, UnreadWidget.class), null, null);
        if (!ok) {
            Toast.makeText(this, "This home screen does not accept widget requests. Long-press the home screen and add it from Widgets.", Toast.LENGTH_LONG).show();
        }
    }

    private void openPendingChat() {
        if (pendingChat == null) return;
        String js = "setTimeout(() => window.wc && wc.openChatKey(" + JSONObject.quote(pendingChat) + "), 600)";
        pendingChat = null;
        web.evaluateJavascript(js, null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        NodeService.appVisible = true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        NodeService.appVisible = false;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // A tela decide: volta da conversa para a lista, ou deixa o app ir para o fundo.
        web.evaluateJavascript("window.wc && wc.back ? wc.back() : false", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    /** Funções que a tela chama (window.Android). */
    class Bridge {
        @JavascriptInterface
        public void addWidget() {
            runOnUiThread(MainActivity.this::pinWidget);
        }

        @JavascriptInterface
        public void chatOpened(String key) {
            NodeService.lines.remove(key);
            getSystemService(NotificationManager.class).cancel(key.hashCode());
        }
    }
}
