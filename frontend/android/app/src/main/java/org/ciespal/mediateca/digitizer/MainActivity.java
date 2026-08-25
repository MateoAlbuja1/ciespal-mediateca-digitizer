package org.ciespal.mediateca.digitizer;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends BridgeActivity {

    private static final String CHANNEL_ID = "ciespal_downloads";
    private static final int NOTIF_PERMISSION_CODE = 1001;
    private int notifId = 1000;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Crear el canal de notificaciones (obligatorio en Android 8+)
        createNotificationChannel();

        // Solicitar permiso de notificaciones en Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIF_PERMISSION_CODE);
            }
        }

        // Registrar la interfaz JavaScript → Java
        this.bridge.getWebView().addJavascriptInterface(new WebAppInterface(this), "AndroidDownloadManager");
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Descargas CIESPAL",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Notificaciones de archivos descargados");
            channel.enableLights(true);
            channel.enableVibration(true);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    public class WebAppInterface {
        Context mContext;

        WebAppInterface(Context c) {
            mContext = c;
        }

        @JavascriptInterface
        public void downloadFile(String base64Data, String filename, String mimeType) {
            try {
                byte[] fileBytes = Base64.decode(base64Data, Base64.DEFAULT);
                Uri fileUri = null;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // Android 10+ (API 29+): MediaStore con scoped storage
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                    values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    fileUri = mContext.getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, values
                    );

                    if (fileUri != null) {
                        OutputStream os = mContext.getContentResolver().openOutputStream(fileUri);
                        if (os != null) {
                            os.write(fileBytes);
                            os.flush();
                            os.close();
                        }
                    }
                } else {
                    // Android 9 e inferior: escritura directa
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloadsDir.exists()) downloadsDir.mkdirs();
                    File destFile = new File(downloadsDir, filename);
                    FileOutputStream fos = new FileOutputStream(destFile);
                    fos.write(fileBytes);
                    fos.flush();
                    fos.close();

                    // Construir Uri compatible con FileProvider para abrir el archivo
                    fileUri = Uri.fromFile(destFile);
                }

                // Lanzar notificación con acción para abrir el archivo
                final Uri finalUri = fileUri;
                runOnUiThread(() -> showDownloadNotification(filename, mimeType, finalUri));

            } catch (Exception e) {
                e.printStackTrace();
                runOnUiThread(() ->
                    Toast.makeText(mContext,
                        "Error al guardar: " + e.getMessage(),
                        Toast.LENGTH_LONG).show()
                );
            }
        }
    }

    private void showDownloadNotification(String filename, String mimeType, Uri fileUri) {
        // Intent para abrir el archivo al tocar la notificación
        Intent openIntent = new Intent(Intent.ACTION_VIEW);
        openIntent.setDataAndType(fileUri, mimeType);
        openIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        PendingIntent pendingOpen = PendingIntent.getActivity(
            this, notifId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Construir la notificación
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("✅ Descarga completa")
            .setContentText(filename + " — Toque para abrir")
            .setSubText("Guardado en Descargas")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)           // Se descarta al tocarla
            .setContentIntent(pendingOpen) // Abre el archivo al tocar
            .addAction(android.R.drawable.ic_menu_view, "Abrir", pendingOpen);

        // Mostrar la notificación
        NotificationManagerCompat notifManager = NotificationManagerCompat.from(this);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            notifManager.notify(notifId++, builder.build());
        }

        // Toast rápido adicional de confirmación
        Toast.makeText(this,
            "⬇ " + filename + "\nGuardado en Descargas",
            Toast.LENGTH_SHORT).show();
    }
}
