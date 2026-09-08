package ai.lifementor.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * FCM message handler for the LifeMentor Android shell (docs/08 §5, docs/11 §8).
 *
 * Extends the Capacitor push-notifications {@link MessagingService} so that, in addition to the
 * plugin's JS bridge behaviour, we get a real OS notification when the app is NOT in the
 * foreground. The division of labour (matches the server's FcmMessage design):
 *
 *  - **foreground**: the webview is alive, so the plugin forwards the message to JavaScript
 *    (`pushNotificationReceived`) and the app's local gate (budget / quiet hours / per-type
 *    switches, req. 86) decides what to show. We do NOT double-post here.
 *  - **background / app closed**: the webview is gone, so we render the message as a system
 *    notification ourselves. Only URGENT messages carry a `notification` payload from the
 *    server, so this path never wakes the user for a non-important item.
 *
 * The plugin's own manifest already declares {@code MessagingService} with the FCM intent
 * filter; we simply register this subclass in OUR manifest so it takes the message first.
 */
public class LifeMentorFcmService extends MessagingService {

    private static final String CHANNEL_ID = "lifementor_push";
    private static final int NOTIFICATION_ID = 0x4C4D; // stable id → new message replaces the old

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        // Let the plugin do its thing (fires `pushNotificationReceived` to JS when the
        // webview is alive, and stashes lastMessage otherwise).
        super.onMessageReceived(remoteMessage);

        // Show an OS notification only when the app is not in the foreground and the server
        // marked the message as visible (it has a `notification` payload, i.e. it was urgent).
        if (!isForeground() && remoteMessage.getNotification() != null) {
            showNotification(remoteMessage);
        }
    }

    /**
     * The webview bridge is alive ⇔ the app is effectively in the foreground (the JS handler
     * is running and the local gate will show whatever it should). The plugin exposes its
     * active instance, so this is an exact check, not a process-state heuristic.
     */
    private boolean isForeground() {
        try {
            return com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin
                    .getPushNotificationsInstance() != null;
        } catch (Exception ignored) {
            return false; // bridge down → treat as background; the queue is the fallback
        }
    }

    private void showNotification(RemoteMessage remoteMessage) {
        try {
            Context context = getApplicationContext();
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
                if (channel == null) {
                    channel = new NotificationChannel(CHANNEL_ID, "LifeMentor", NotificationManager.IMPORTANCE_HIGH);
                    channel.setDescription("Уведомления LifeMentor");
                    manager.createNotificationChannel(channel);
                }
            }

            // Tapping the notification opens the app (singleTask activity brings it to front).
            Intent intent = new Intent(context, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent content = PendingIntent.getActivity(context, 0, intent, flags);

            RemoteMessage.Notification note = remoteMessage.getNotification();
            String title = note.getTitle() != null ? note.getTitle() : "LifeMentor";
            String body = note.getBody() != null ? note.getBody() : "";

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(content);

            manager.notify(NOTIFICATION_ID, builder.build());
        } catch (Exception ignored) {
            // Never let push display crash the app; the server queue is the guaranteed fallback.
        }
    }
}
