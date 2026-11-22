package app.whatsappcentral;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Shader;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Fornece as linhas da lista do widget (uma por conversa não lida). */
public class WidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static class Factory implements RemoteViewsFactory {
        private final Context ctx;
        private List<UnreadWidget.Item> items = new ArrayList<>();
        /** Fotos já baixadas, pela chave da conversa + versão da foto. */
        private final Map<String, Bitmap> photos = new HashMap<>();

        Factory(Context ctx) {
            this.ctx = ctx;
        }

        @Override
        public void onCreate() {
        }

        @Override
        public void onDataSetChanged() {
            // Roda fora da linha principal: pode ler o servidor e baixar as fotos.
            items = UnreadWidget.loadUnread();
            for (UnreadWidget.Item it : items) {
                String k = it.key + "#" + it.avatar;
                if (it.avatar > 0 && !photos.containsKey(k)) photos.put(k, loadPhoto(it));
            }
        }

        private Bitmap loadPhoto(UnreadWidget.Item it) {
            try {
                HttpURLConnection c = NodeService.open("/api/avatar?account=" + Uri.encode(it.account)
                        + "&chat=" + Uri.encode(it.id));
                c.setReadTimeout(5000);
                Bitmap src;
                try (InputStream in = c.getInputStream()) {
                    src = BitmapFactory.decodeStream(in);
                }
                return src == null ? null : circle(src, 108);
            } catch (Exception e) {
                return null;
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

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);
            if (position >= items.size()) return v;
            UnreadWidget.Item it = items.get(position);
            v.setTextViewText(R.id.name, it.name);
            v.setTextViewText(R.id.text, it.text);
            v.setTextViewText(R.id.count, String.valueOf(it.unread));
            v.setViewVisibility(R.id.count, it.unread > 0 ? View.VISIBLE : View.GONE);
            String first = it.name.trim().isEmpty() ? "?" : it.name.trim().substring(0, 1).toUpperCase();
            v.setTextViewText(R.id.letter, first);
            Bitmap photo = photos.get(it.key + "#" + it.avatar);
            if (photo != null) {
                v.setImageViewBitmap(R.id.avatar, photo);
                v.setViewVisibility(R.id.avatar, View.VISIBLE);
            } else {
                v.setViewVisibility(R.id.avatar, View.GONE);
            }
            v.setOnClickFillInIntent(R.id.row, new Intent().putExtra("chat", it.key));
            return v;
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
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
