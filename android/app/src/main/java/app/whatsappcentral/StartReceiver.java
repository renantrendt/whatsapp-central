package app.whatsappcentral;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Liga o app de novo sozinho depois de uma atualização e quando o celular reinicia.
 * Sem isso, o widget e os avisos param até alguém abrir o app.
 */
public class StartReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(a) || Intent.ACTION_BOOT_COMPLETED.equals(a)) {
            try {
                ctx.startForegroundService(new Intent(ctx, NodeService.class));
            } catch (Exception ignored) {
                // O Android pode recusar; nesse caso o app volta quando for aberto.
            }
        }
    }
}
