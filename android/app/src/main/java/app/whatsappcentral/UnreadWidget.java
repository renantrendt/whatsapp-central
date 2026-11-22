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
 * Widget 4x2 da tela inicial com as conversas que têm mensagens não lidas.
 * Os dados vêm do servidor que roda dentro do app (o mesmo da tela).
 */
public class UnreadWidget extends AppWidgetProvider {

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
            List<Item> items = loadUnread();
            int total = 0;
            for (Item it : items) total += it.unread;
            for (int id : ids) mgr.updateAppWidget(id, build(app, id, total));
            mgr.notifyAppWidgetViewDataChanged(ids, R.id.list);
        }, "widget").start();
    }

    @SuppressWarnings("deprecation")
    private static RemoteViews build(Context ctx, int widgetId, int total) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);

        Intent svc = new Intent(ctx, WidgetService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        v.setRemoteAdapter(R.id.list, svc);
        v.setEmptyView(R.id.list, R.id.empty);

        // Tocar na área vazia abre o app.
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent openPi = PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        v.setOnClickPendingIntent(R.id.empty, openPi);

        // Tocar numa conversa abre essa conversa (cada linha completa o "chat").
        Intent row = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent rowPi = PendingIntent.getActivity(ctx, 2, row, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        v.setPendingIntentTemplate(R.id.list, rowPi);
        return v;
    }
}
