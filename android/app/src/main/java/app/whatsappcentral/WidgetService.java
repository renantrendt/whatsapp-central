package app.whatsappcentral;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Shader;
import android.appwidget.AppWidgetManager;
import android.net.Uri;
import android.text.format.DateUtils;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import android.content.pm.ResolveInfo;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Fornece as linhas da lista do widget (uma por conversa não lida). */
public class WidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0);
        return new Factory(getApplicationContext(), widgetId);
    }

    static class Factory implements RemoteViewsFactory {
        private final Context ctx;
        private final int widgetId;
        private boolean notesTab = false;
        private List<UnreadWidget.Item> items = new ArrayList<>();
        private List<UnreadWidget.Note> notes = new ArrayList<>();
        /** Link to each chat's round picture file, by chat key. */
        private final Map<String, Uri> photos = new HashMap<>();

        Factory(Context ctx, int widgetId) {
            this.ctx = ctx;
            this.widgetId = widgetId;
        }

        @Override
        public void onCreate() {
        }

        @Override
        public void onDataSetChanged() {
            // Roda fora da linha principal: pode ler o servidor e baixar as fotos.
            notesTab = UnreadWidget.TAB_NOTES.equals(UnreadWidget.tabOf(ctx, widgetId));
            if (notesTab) {
                notes = UnreadWidget.loadNotes();
                return;
            }
            items = UnreadWidget.loadUnread();
            File dir = AvatarProvider.dir(ctx);
            Set<String> keep = new HashSet<>();
            List<String> hosts = homeApps();
            photos.clear();
            for (UnreadWidget.Item it : items) {
                if (it.avatar <= 0) continue;
                String name = fileName(it);
                File f = new File(dir, name);
                if (!f.isFile() && !savePhoto(it, f)) continue;
                keep.add(name);
                Uri uri = AvatarProvider.uriFor(name);
                for (String pkg : hosts) {
                    ctx.grantUriPermission(pkg, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                photos.put(it.key, uri);
            }
            // Old versions and chats no longer in the list.
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) if (!keep.contains(f.getName())) f.delete();
        }

        /** The chat and the picture version, so a new picture gets a new link. */
        private static String fileName(UnreadWidget.Item it) {
            try {
                byte[] h = MessageDigest.getInstance("SHA-1").digest(it.key.getBytes(StandardCharsets.UTF_8));
                StringBuilder s = new StringBuilder();
                for (byte b : h) s.append(String.format("%02x", b));
                return s + "_" + it.avatar + ".png";
            } catch (Exception e) {
                return Integer.toHexString(it.key.hashCode()) + "_" + it.avatar + ".png";
            }
        }

        /** Home-screen apps that show the widget and must read the pictures. */
        private List<String> homeApps() {
            List<String> out = new ArrayList<>();
            Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
            for (ResolveInfo r : ctx.getPackageManager().queryIntentActivities(home, 0)) {
                out.add(r.activityInfo.packageName);
            }
            return out;
        }

        private boolean savePhoto(UnreadWidget.Item it, File f) {
            try {
                HttpURLConnection c = NodeService.open("/api/avatar?account=" + Uri.encode(it.account)
                        + "&chat=" + Uri.encode(it.id));
                c.setReadTimeout(5000);
                Bitmap src;
                try (InputStream in = c.getInputStream()) {
                    src = BitmapFactory.decodeStream(in);
                }
                if (src == null) return false;
                File tmp = new File(f.getPath() + ".tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    circle(src, 108).compress(Bitmap.CompressFormat.PNG, 100, out);
                }
                return tmp.renameTo(f);
            } catch (Exception e) {
                return false;
            }
        }

        /** O widget não recorta imagens: a foto já vai redonda. */
        private static Bitmap circle(Bitmap src, int size) {
            Bitmap scaled = Bitmap.createScaledBitmap(src, size, size, true);
            Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setShader(new BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
            new Canvas(out).drawCircle(size / 2f, size / 2f, size / 2f, p);
            return out;
        }

        // Linha 0: as abas. Depois, as conversas ou as notas (ou um aviso de lista vazia).
        private int contentCount() {
            return notesTab ? notes.size() : items.size();
        }

        private RemoteViews tabsView() {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_tabs_row);
            v.setTextColor(R.id.tab_inbox, notesTab ? 0xFF6F6C66 : 0xFFFFFFFF);
            v.setTextColor(R.id.tab_notes, notesTab ? 0xFFFFFFFF : 0xFF6F6C66);
            v.setInt(R.id.tab_inbox, "setBackgroundResource", notesTab ? R.drawable.tab_off : R.drawable.tab_on);
            v.setInt(R.id.tab_notes, "setBackgroundResource", notesTab ? R.drawable.tab_on : R.drawable.tab_off);
            v.setOnClickFillInIntent(R.id.tab_inbox, new Intent().putExtra("tab", UnreadWidget.TAB_INBOX));
            v.setOnClickFillInIntent(R.id.tab_notes, new Intent().putExtra("tab", UnreadWidget.TAB_NOTES));
            return v;
        }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position == 0) return tabsView();
            if (contentCount() == 0) {
                RemoteViews e = new RemoteViews(ctx.getPackageName(), R.layout.widget_empty_row);
                e.setTextViewText(R.id.row, notesTab ? "No notes yet" : "No conversations yet");
                e.setOnClickFillInIntent(R.id.row, new Intent());
                return e;
            }
            position -= 1;
            if (notesTab) return noteView(position);
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);
            if (position >= items.size()) return v;
            UnreadWidget.Item it = items.get(position);
            v.setTextViewText(R.id.name, it.name);
            v.setTextViewText(R.id.text, it.text);
            v.setTextViewText(R.id.count, String.valueOf(it.unread));
            v.setViewVisibility(R.id.count, it.unread > 0 ? View.VISIBLE : View.GONE);
            String first = it.name.trim().isEmpty() ? "?" : it.name.trim().substring(0, 1).toUpperCase();
            v.setTextViewText(R.id.letter, first);
            Uri photo = photos.get(it.key);
            if (photo != null) {
                v.setImageViewUri(R.id.avatar, photo);
                v.setViewVisibility(R.id.avatar, View.VISIBLE);
            } else {
                v.setViewVisibility(R.id.avatar, View.GONE);
            }
            v.setOnClickFillInIntent(R.id.row, new Intent().putExtra("chat", it.key));
            return v;
        }

        private RemoteViews noteView(int position) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_note_row);
            if (position >= notes.size()) return v;
            UnreadWidget.Note n = notes.get(position);
            v.setTextViewText(R.id.name, n.title);
            v.setTextViewText(R.id.text, n.summary);
            long ms = n.updated * 1000;
            v.setTextViewText(R.id.time, DateUtils.isToday(ms)
                    ? DateUtils.formatDateTime(ctx, ms, DateUtils.FORMAT_SHOW_TIME)
                    : DateUtils.formatDateTime(ctx, ms, DateUtils.FORMAT_SHOW_DATE | DateUtils.FORMAT_ABBREV_MONTH | DateUtils.FORMAT_NO_YEAR));
            v.setOnClickFillInIntent(R.id.row, new Intent().putExtra("note", n.id));
            return v;
        }

        @Override
        public int getCount() {
            return 1 + Math.max(1, contentCount());
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 4; // abas, conversa, nota e lista vazia
        }

        @Override
        public long getItemId(int position) {
            if (position == 0) return Long.MIN_VALUE;
            if (contentCount() == 0) return Long.MIN_VALUE + 1;
            position -= 1;
            if (notesTab) return position < notes.size() ? -notes.get(position).id - 1 : position;
            return position < items.size() ? items.get(position).key.hashCode() : position;
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }

        @Override
        public void onDestroy() {
            photos.clear();
        }
    }
}
