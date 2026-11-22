package app.whatsappcentral;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.system.Os;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Mantém o app ligado em segundo plano: roda o servidor (o mesmo código do Mac)
 * dentro do motor Node e mostra um aviso do Android para cada mensagem nova.
 * Fica como "serviço em primeiro plano", com um aviso fixo, para o Android não
 * fechar a conexão com o WhatsApp.
 */
public class NodeService extends Service {
    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    public native int startNode(String[] args);

    static final int PORT = 4319;
    static final String BASE = "http://127.0.0.1:" + PORT;
    static final String TOKEN = randomHex();
    static volatile boolean appVisible = false;

    private static volatile boolean nodeStarted = false;
    private static final String TAG = "WCService";
    private static final String CH_SERVICE = "service";
    private static final String CH_MESSAGES = "messages";

    /** Últimas linhas de cada conversa, para o aviso mostrar mais de uma mensagem. */
    static final Map<String, List<String>> lines = new ConcurrentHashMap<>();
    private final Map<String, String> chatNames = new ConcurrentHashMap<>();
    private Thread listener;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CH_SERVICE, "Connection", NotificationManager.IMPORTANCE_MIN));
        nm.createNotificationChannel(new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH));

        Notification n = new Notification.Builder(this, CH_SERVICE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Whatsapp Central is connected")
                .setContentIntent(openApp(null))
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(1, n);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!nodeStarted) {
            nodeStarted = true;
            new Thread(this::runNode, "node").start();
        }
        if (listener == null) {
            listener = new Thread(this::listen, "events");
            listener.start();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- Node ----------

    private void runNode() {
        try {
            File project = prepareProject();
            File data = new File(getFilesDir(), "data");
            data.mkdirs();
            Os.setenv("WC_DATA", data.getAbsolutePath(), true);
            Os.setenv("WC_PORT", String.valueOf(PORT), true);
            Os.setenv("WC_TOKEN", TOKEN, true);
            Os.setenv("WC_MOBILE", "1", true);
            String main = new File(project, "server/index.js").getAbsolutePath();
            int code = startNode(new String[]{"node", main});
            Log.e(TAG, "Node stopped with code " + code);
        } catch (Exception e) {
            Log.e(TAG, "Could not start Node", e);
        }
    }

    /** Descompacta o código do servidor na primeira abertura e a cada nova versão do app. */
    private File prepareProject() throws Exception {
        File dir = new File(getFilesDir(), "nodejs-project");
        long stamp = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        SharedPreferences prefs = getSharedPreferences("wc", MODE_PRIVATE);
        if (dir.exists() && prefs.getLong("projectStamp", 0) == stamp) return dir;

        deleteTree(dir);
        dir.mkdirs();
        try (ZipInputStream zip = new ZipInputStream(getAssets().open("nodejs-project.zip"))) {
            byte[] buf = new byte[64 * 1024];
            ZipEntry e;
            String root = dir.getCanonicalPath() + File.separator;
            while ((e = zip.getNextEntry()) != null) {
                File f = new File(dir, e.getName());
                if (!f.getCanonicalPath().startsWith(root)) continue; // ignora caminhos fora da pasta
                if (e.isDirectory()) {
                    f.mkdirs();
                    continue;
                }
                f.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(f)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) out.write(buf, 0, n);
                }
            }
        }
        prefs.edit().putLong("projectStamp", stamp).apply();
        return dir;
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    // ---------- avisos ----------

    /** Lê os eventos do servidor e cria um aviso para cada mensagem recebida. */
    private void listen() {
        while (true) {
            try {
                loadNames();
                UnreadWidget.refreshSoon(this);
                HttpURLConnection c = open("/api/events");
                c.setReadTimeout(0);
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        if (line.startsWith("data: ")) handle(new JSONObject(line.substring(6)));
                    }
                }
            } catch (Exception e) {
                // O servidor ainda está subindo, ou caiu: tenta de novo em 2 segundos.
            }
            try {
                Thread.sleep(2000);
            } catch (InterruptedException ignored) {
                return;
            }
        }
    }

    static HttpURLConnection open(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        c.setRequestProperty("Cookie", "wc=" + TOKEN);
        c.setConnectTimeout(3000);
        return c;
    }

    private void loadNames() throws Exception {
        HttpURLConnection c = open("/api/state");
        c.setReadTimeout(20000);
        try (InputStream in = c.getInputStream()) {
            String body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            JSONArray chats = new JSONObject(body).getJSONArray("chats");
            for (int i = 0; i < chats.length(); i++) {
                JSONObject ch = chats.getJSONObject(i);
                chatNames.put(ch.getString("account") + "|" + ch.getString("id"), ch.getString("name"));
            }
        }
    }

    private void handle(JSONObject ev) throws Exception {
        String type = ev.optString("type");
        if (type.equals("chat")) {
            JSONObject ch = ev.getJSONObject("chat");
            chatNames.put(ch.getString("account") + "|" + ch.getString("id"), ch.getString("name"));
            UnreadWidget.refreshSoon(this);
            return;
        }
        if (type.equals("reload") || type.equals("chat-removed") || type.equals("notes") || type.equals("notes-local")) {
            UnreadWidget.refreshSoon(this);
            return;
        }
        if (!type.equals("message") || !ev.optBoolean("live") || ev.optBoolean("updated")) return;
        JSONObject m = ev.getJSONObject("message");
        if (m.optBoolean("fromMe") || appVisible) return;

        String key = m.getString("account") + "|" + m.getString("chatId");
        String name = chatNames.getOrDefault(key, "New message");
        String text = describe(m);
        String sender = m.optString("senderName", "");
        if (key.endsWith("@g.us") && !sender.isEmpty()) text = sender + ": " + text;

        List<String> list = lines.computeIfAbsent(key, k -> new ArrayList<>());
        synchronized (list) {
            list.add(text);
            while (list.size() > 6) list.remove(0);
        }
        Notification.InboxStyle style = new Notification.InboxStyle();
        synchronized (list) {
            for (String l : list) style.addLine(l);
        }
        Notification n = new Notification.Builder(this, CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(name)
                .setContentText(text)
                .setStyle(style)
                .setNumber(list.size())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setContentIntent(openApp(key))
                .build();
        getSystemService(NotificationManager.class).notify(key.hashCode(), n);
    }

    private static String describe(JSONObject m) {
        String kind = m.optString("kind");
        String text = m.optString("text", "");
        switch (kind) {
            case "text": return text;
            case "image": return text.isEmpty() ? "Photo" : "Photo: " + text;
            case "video": return text.isEmpty() ? "Video" : "Video: " + text;
            case "audio": return "Voice message";
            case "sticker": return "Sticker";
            case "document": return "Document";
            default: return text.isEmpty() ? "Message" : text;
        }
    }

    private PendingIntent openApp(String chatKey) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (chatKey != null) i.putExtra("chat", chatKey);
        int req = chatKey == null ? 0 : chatKey.hashCode();
        return PendingIntent.getActivity(this, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String randomHex() {
        byte[] b = new byte[24];
        new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
