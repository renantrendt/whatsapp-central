package app.whatsappcentral;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Widget 4x2 da tela inicial com duas abas: Inbox (conversas recentes, não lidas
 * primeiro) e Notes (notas, a editada mais recentemente primeiro). Os dados vêm do
 * servidor que roda dentro do app (o mesmo da tela).
 */
public class UnreadWidget extends AppWidgetProvider {
    static final String ACTION_TAB = "app.whatsappcentral.WIDGET_TAB";
    static final String TAB_INBOX = "inbox";
    static final String TAB_NOTES = "notes";

    /** Aba escolhida em cada widget (cada widget lembra a sua). */
    static String tabOf(Context ctx, int widgetId) {
        return ctx.getSharedPreferences("widget", Context.MODE_PRIVATE).getString("tab" + widgetId, TAB_INBOX);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
    }

    /** Uma nota, para a aba Notes. */
    static class Note {
        long id, updated;
        String title, summary;
    }

    /** Lê as notas do servidor do app, a editada mais recentemente primeiro. */
    static List<Note> loadNotes() {
        List<Note> out = new ArrayList<>();
        try {
            HttpURLConnection c = NodeService.open("/api/notes");
            c.setReadTimeout(10000);
            String body;
            try (InputStream in = c.getInputStream()) {
                body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
            JSONArray notes = new JSONObject(body).getJSONArray("notes");
            for (int i = 0; i < notes.length() && out.size() < 30; i++) {
                JSONObject n = notes.getJSONObject(i);
                Note it = new Note();
                it.id = n.getLong("id");
                it.updated = n.optLong("updated");
                it.title = n.optString("title").trim().isEmpty() ? "Untitled" : n.optString("title").trim();
                it.summary = toText(n.optString("body"));
                out.add(it);
            }
        } catch (Exception ignored) {
        }
        out.sort((a, b) -> Long.compare(b.updated, a.updated));
        return out;
    }

    /**
     * A nota inteira em texto simples, para o widget: listas com "•", listas
     * numeradas com "1.", tarefas com ☐ e ☑. Linhas vazias seguidas viram uma só.
     */
    static String toText(String html) {
        StringBuilder out = new StringBuilder();
        java.util.ArrayDeque<int[]> lists = new java.util.ArrayDeque<>(); // {tipo, contador}: 0 = •, 1 = número, 2 = tarefa
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("<(/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)").matcher(html == null ? "" : html);
        while (m.find()) {
            if (m.group(4) != null) {
                out.append(m.group(4).replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">")
                        .replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&"));
                continue;
            }
            boolean close = !m.group(1).isEmpty();
            String tag = m.group(2).toLowerCase();
            String attrs = m.group(3);
            switch (tag) {
                case "ul":
                case "ol":
                    if (close) {
                        if (!lists.isEmpty()) lists.pop();
                    } else {
                        int type = tag.equals("ol") ? 1 : attrs.contains("checklist") ? 2 : 0;
                        lists.push(new int[]{type, 0});
                    }
                    newline(out);
                    break;
                case "li":
                    if (close) break;
                    newline(out);
                    int[] list = lists.peek();
                    for (int k = 1; k < lists.size(); k++) out.append("    ");
                    if (list == null || list[0] == 0) out.append("• ");
                    else if (list[0] == 1) out.append(++list[1]).append(". ");
                    else out.append(attrs.contains("\"true\"") ? "☑ " : "☐ ");
                    break;
                case "br":
                    out.append('\n');
                    break;
                case "div":
                case "p":
                    newline(out);
                    break;
                default:
                    break;
            }
        }
        String text = out.toString().replaceAll("[ \t]+\n", "\n").replaceAll("\n{3,}", "\n\n").trim();
        return text.isEmpty() ? "Empty" : text;
    }

    private static void newline(StringBuilder out) {
        if (out.length() > 0 && out.charAt(out.length() - 1) != '\n') out.append('\n');
    }

    /** Uma conversa com mensagens não lidas. */
    static class Item {
        String key, account, id, name, text;
        int unread;
        long avatar;
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        refresh(ctx);
    }

    /** Lê as conversas não lidas do servidor do app (fora da linha principal). */
    static List<Item> loadUnread() {
        List<Item> out = new ArrayList<>();
        try {
            HttpURLConnection c = NodeService.open("/api/state");
            c.setReadTimeout(10000);
            String body;
            try (InputStream in = c.getInputStream()) {
                body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
            JSONArray chats = new JSONObject(body).getJSONArray("chats");
            for (int i = 0; i < chats.length(); i++) {
                JSONObject ch = chats.getJSONObject(i);
                // Mostra as conversas mais recentes da caixa de entrada, lidas ou não.
                if (ch.optBoolean("archived")) continue;
                Item it = new Item();
                it.account = ch.getString("account");
                it.id = ch.getString("id");
                it.key = it.account + "|" + it.id;
                it.name = ch.optString("name");
                it.text = (ch.optBoolean("lastFromMe") ? "You: " : "") + ch.optString("lastText");
                it.unread = ch.optInt("unread");
                it.avatar = ch.optLong("avatar");
                out.add(it); // o servidor já manda da mais recente para a mais antiga
            }
        } catch (Exception ignored) {
            // O app ainda não abriu o servidor: o widget mostra a lista vazia.
        }
        // Não lidas sempre no topo; dentro de cada grupo, a mais recente primeiro
        // (a ordenação é estável e o servidor já manda da mais recente para a mais antiga).
        out.sort((a, b) -> Boolean.compare(b.unread > 0, a.unread > 0));
        return out.size() > 20 ? new ArrayList<>(out.subList(0, 20)) : out;
    }

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static Runnable scheduled;

    /** Pede uma atualização daqui a 1 segundo (várias mensagens seguidas viram uma só). */
    static void refreshSoon(Context ctx) {
        Context app = ctx.getApplicationContext();
        synchronized (UnreadWidget.class) {
            if (scheduled != null) main.removeCallbacks(scheduled);
            scheduled = () -> refresh(app);
            main.postDelayed(scheduled, 1000);
        }
    }

    /** Atualiza o cabeçalho (total) e pede para a lista ler os dados de novo. */
    static void refresh(Context ctx) {
        Context app = ctx.getApplicationContext();
        AppWidgetManager mgr = AppWidgetManager.getInstance(app);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(app, UnreadWidget.class));
        if (ids.length == 0) return;
        new Thread(() -> {
            for (int id : ids) {
                String tab = tabOf(app, id);
                mgr.updateAppWidget(id, build(app, id, tab));
            }
            mgr.notifyAppWidgetViewDataChanged(ids, R.id.list);
        }, "widget").start();
    }

    @SuppressWarnings("deprecation")
    private static RemoteViews build(Context ctx, int widgetId, String tab) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        Intent svc = new Intent(ctx, WidgetService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        v.setRemoteAdapter(R.id.list, svc);
        // Todo toque numa linha (aba, conversa ou nota) passa pela WidgetClickActivity.
        Intent click = new Intent(ctx, WidgetClickActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        PendingIntent pi = PendingIntent.getActivity(ctx, 100 + widgetId, click,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        v.setPendingIntentTemplate(R.id.list, pi);
        return v;
    }


}
