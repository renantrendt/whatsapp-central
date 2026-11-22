package app.whatsappcentral;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;

/**
 * Recebe os toques do widget, sem mostrar nada na tela. Um toque numa aba troca
 * a aba; um toque numa conversa ou nota abre o app nela. Fecha na hora.
 */
public class WidgetClickActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Intent in = getIntent();
        String tab = in.getStringExtra("tab");
        if (tab != null) {
            int id = in.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0);
            getSharedPreferences("widget", MODE_PRIVATE).edit().putString("tab" + id, tab).commit();
            UnreadWidget.refresh(this);
        } else {
            Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (in.hasExtra("chat")) open.putExtra("chat", in.getStringExtra("chat"));
            if (in.hasExtra("note")) open.putExtra("note", in.getLongExtra("note", 0));
            startActivity(open);
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
