package org.ciespal.mediateca.digitizer;

import android.Manifest;
import android.annotation.TargetApi;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.BridgeActivity;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String DOWNLOAD_CHANNEL_ID = "ciespal_downloads";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4041;
    private static final int MAX_SCAN_PAGES = 50;
    private static final int MAX_SCAN_IMAGE_DIMENSION = 2200;
    private static final int SCAN_IMAGE_JPEG_QUALITY = 88;
    private ActivityResultLauncher<IntentSenderRequest> documentScannerLauncher;
    private boolean documentScanInProgress = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerDocumentScannerLauncher();
        createDownloadNotificationChannel();
        requestNotificationPermissionIfNeeded();
        
        WebAppInterface webAppInterface = new WebAppInterface(this);
        this.bridge.getWebView().addJavascriptInterface(webAppInterface, "AndroidDownloadManager");
        this.bridge.getWebView().addJavascriptInterface(webAppInterface, "CiespalDocumentScanner");
    }

    private void registerDocumentScannerLauncher() {
        documentScannerLauncher = registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> {
                documentScanInProgress = false;

                if (result.getResultCode() != RESULT_OK) {
                    emitDocumentScanResult("{\"success\":false,\"cancelled\":true}");
                    return;
                }

                try {
                    GmsDocumentScanningResult scanResult =
                        GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
                    List<GmsDocumentScanningResult.Page> pages =
                        scanResult == null ? null : scanResult.getPages();

                    if (pages == null || pages.isEmpty()) {
                        emitDocumentScanError("El escáner no devolvió páginas.");
                        return;
                    }

                    File scanDir = new File(getCacheDir(), "ciespal_mlkit_scans");
                    if (!scanDir.exists() && !scanDir.mkdirs()) {
                        throw new IOException("No se pudo crear la carpeta temporal del escáner.");
                    }

                    StringBuilder pagesJson = new StringBuilder("[");
                    int savedCount = 0;
                    for (int i = 0; i < pages.size(); i++) {
                        Uri sourceUri = pages.get(i).getImageUri();
                        if (sourceUri == null) continue;
                        Uri localUri = saveNormalizedScanImage(sourceUri, scanDir, i);
                        if (savedCount > 0) pagesJson.append(",");
                        pagesJson
                            .append("{\"uri\":\"")
                            .append(escapeJson(localUri.toString()))
                            .append("\"}");
                        savedCount++;
                    }
                    pagesJson.append("]");

                    if (savedCount == 0) {
                        emitDocumentScanError("No se pudieron guardar las imágenes escaneadas.");
                        return;
                    }

                    emitDocumentScanResult(
                        "{\"success\":true,\"pageCount\":" + savedCount + ",\"pages\":" + pagesJson + "}"
                    );
                } catch (Exception e) {
                    e.printStackTrace();
                    emitDocumentScanError(e.getMessage() == null ? e.toString() : e.getMessage());
                }
            }
        );
    }

    private void startDocumentScanner(int requestedPageLimit) {
        try {
            int pageLimit = Math.max(1, Math.min(requestedPageLimit, MAX_SCAN_PAGES));
            GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
                .setGalleryImportAllowed(true)
                .setPageLimit(pageLimit)
                .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
                .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                .build();

            GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
            scanner.getStartScanIntent(this)
                .addOnSuccessListener(intentSender -> {
                    documentScannerLauncher.launch(
                        new IntentSenderRequest.Builder(intentSender).build()
                    );
                })
                .addOnFailureListener(e -> {
                    documentScanInProgress = false;
                    emitDocumentScanError(e.getMessage() == null ? e.toString() : e.getMessage());
                });
        } catch (Exception e) {
            documentScanInProgress = false;
            emitDocumentScanError(e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    private Uri saveNormalizedScanImage(Uri sourceUri, File scanDir, int pageIndex) throws IOException {
        cleanupOldScanFiles(scanDir);

        File destination = new File(
            scanDir,
            "ciespal_scan_" + System.currentTimeMillis() + "_" + pageIndex + ".jpg"
        );
        byte[] imageBytes = readCompressedImageBytes(sourceUri);
        try (FileOutputStream output = new FileOutputStream(destination)) {
            output.write(imageBytes);
            output.flush();
        }
        return Uri.fromFile(destination);
    }

    private void cleanupOldScanFiles(File scanDir) {
        File[] files = scanDir.listFiles();
        if (files == null) return;

        long cutoff = System.currentTimeMillis() - (24L * 60L * 60L * 1000L);
        for (File file : files) {
            if (file.isFile() && file.lastModified() < cutoff) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    private byte[] readCompressedImageBytes(Uri uri) throws IOException {
        BitmapFactory.Options boundsOptions = new BitmapFactory.Options();
        boundsOptions.inJustDecodeBounds = true;
        try (InputStream input = openUriInputStream(uri)) {
            BitmapFactory.decodeStream(input, null, boundsOptions);
        }

        if (boundsOptions.outWidth <= 0 || boundsOptions.outHeight <= 0) {
            return readUriBytes(uri);
        }

        int sampleSize = 1;
        while (
            boundsOptions.outWidth / sampleSize > MAX_SCAN_IMAGE_DIMENSION ||
            boundsOptions.outHeight / sampleSize > MAX_SCAN_IMAGE_DIMENSION
        ) {
            sampleSize *= 2;
        }

        BitmapFactory.Options decodeOptions = new BitmapFactory.Options();
        decodeOptions.inSampleSize = sampleSize;
        Bitmap bitmap;
        try (InputStream input = openUriInputStream(uri)) {
            bitmap = BitmapFactory.decodeStream(input, null, decodeOptions);
        }

        if (bitmap == null) {
            return readUriBytes(uri);
        }

        Bitmap outputBitmap = bitmap;
        int maxSide = Math.max(bitmap.getWidth(), bitmap.getHeight());
        if (maxSide > MAX_SCAN_IMAGE_DIMENSION) {
            float scale = (float) MAX_SCAN_IMAGE_DIMENSION / (float) maxSide;
            int targetW = Math.max(1, Math.round(bitmap.getWidth() * scale));
            int targetH = Math.max(1, Math.round(bitmap.getHeight() * scale));
            outputBitmap = Bitmap.createScaledBitmap(bitmap, targetW, targetH, true);
        }

        ByteArrayOutputStream output = new ByteArrayOutputStream();
        outputBitmap.compress(Bitmap.CompressFormat.JPEG, SCAN_IMAGE_JPEG_QUALITY, output);

        if (outputBitmap != bitmap) outputBitmap.recycle();
        bitmap.recycle();
        return output.toByteArray();
    }

    private byte[] readUriBytes(Uri uri) throws IOException {
        try (InputStream input = openUriInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int bytesRead;
            while ((bytesRead = input.read(buffer)) != -1) {
                output.write(buffer, 0, bytesRead);
            }
            return output.toByteArray();
        }
    }

    private InputStream openUriInputStream(Uri uri) throws IOException {
        if ("file".equalsIgnoreCase(uri.getScheme())) {
            String path = uri.getPath();
            if (path == null) throw new IOException("Ruta de imagen inválida.");
            return new FileInputStream(new File(path));
        }

        InputStream input = getContentResolver().openInputStream(uri);
        if (input == null) {
            throw new IOException("No se pudo abrir la imagen escaneada.");
        }
        return input;
    }

    private void emitDocumentScanError(String message) {
        emitDocumentScanResult(
            "{\"success\":false,\"error\":\"" + escapeJson(message == null ? "Error desconocido" : message) + "\"}"
        );
    }

    private void emitDocumentScanResult(String json) {
        runOnUiThread(() -> {
            if (bridge == null || bridge.getWebView() == null) return;
            String script =
                "window.dispatchEvent(new CustomEvent('ciespal-document-scan-result',{detail:" +
                json +
                "}));";
            bridge.getWebView().evaluateJavascript(script, null);
        });
    }

    private String escapeJson(String value) {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r");
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                NOTIFICATION_PERMISSION_REQUEST
            );
        }
    }

    private void createDownloadNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager notificationManager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (notificationManager == null) return;

        NotificationChannel channel = new NotificationChannel(
            DOWNLOAD_CHANNEL_ID,
            "Descargas CIESPAL",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Avisos cuando se guardan PDF, CSV o MARCXML.");
        notificationManager.createNotificationChannel(channel);
    }

    @SuppressWarnings("deprecation")
    private void showDownloadNotification(String filename, String mimeType, Uri fileUri) {
        NotificationManager notificationManager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (notificationManager == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Intent openIntent = new Intent(Intent.ACTION_VIEW);
        openIntent.setDataAndType(fileUri, mimeType);
        openIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            Math.abs(filename.hashCode()),
            openIntent,
            flags
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, DOWNLOAD_CHANNEL_ID)
            : new Notification.Builder(this);

        builder
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Archivo guardado en Descargas")
            .setContentText(filename)
            .setStyle(new Notification.BigTextStyle().bigText(filename))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true);

        notificationManager.notify(Math.abs((filename + System.currentTimeMillis()).hashCode()), builder.build());
    }

    public class WebAppInterface {
        Context mContext;

        WebAppInterface(Context c) {
            mContext = c;
        }

        @JavascriptInterface
        public String scanDocuments(int pageLimit) {
            if (documentScanInProgress) {
                return "{\"success\":false,\"error\":\"Ya hay un escaneo abierto.\"}";
            }

            documentScanInProgress = true;
            runOnUiThread(() -> startDocumentScanner(pageLimit));
            return "{\"success\":true,\"started\":true}";
        }

        @JavascriptInterface
        public String readImageAsBase64(String uriString) {
            try {
                Uri uri = Uri.parse(uriString);
                byte[] imageBytes = readUriBytes(uri);
                String imageBase64 = Base64.encodeToString(imageBytes, Base64.NO_WRAP);
                return "{\"success\":true,\"imageBase64\":\"" + imageBase64 + "\"}";
            } catch (Exception e) {
                e.printStackTrace();
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                return "{\"success\":false,\"error\":\"" + escapeJson(message) + "\"}";
            }
        }

        @JavascriptInterface
        public String downloadFile(String base64Data, String filename, String mimeType) {
            try {
                byte[] fileBytes = Base64.decode(base64Data, Base64.DEFAULT);
                Uri savedUri = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? saveWithMediaStore(fileBytes, filename, mimeType)
                    : saveLegacyDownload(fileBytes, filename, mimeType);
                showDownloadNotification(filename, mimeType, savedUri);

                runOnUiThread(() -> {
                    Toast.makeText(mContext, "Guardado en Descargas: " + filename, Toast.LENGTH_LONG).show();
                });
                return "{\"success\":true,\"path\":\"" + escapeJson(savedUri.toString()) + "\"}";
            } catch (Exception e) {
                e.printStackTrace();
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                runOnUiThread(() -> {
                    Toast.makeText(mContext, "Error en descarga: " + message, Toast.LENGTH_LONG).show();
                });
                return "{\"success\":false,\"error\":\"" + escapeJson(message) + "\"}";
            }
        }

        @TargetApi(Build.VERSION_CODES.Q)
        private Uri saveWithMediaStore(byte[] fileBytes, String filename, String mimeType) throws IOException {
            ContentResolver resolver = mContext.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.SIZE, fileBytes.length);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);

            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IOException("No se pudo crear el archivo en Descargas");
            }

            try (OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) {
                    throw new IOException("No se pudo abrir el archivo en Descargas");
                }
                output.write(fileBytes);
            }

            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return uri;
        }

        @SuppressWarnings("deprecation")
        private Uri saveLegacyDownload(byte[] fileBytes, String filename, String mimeType) throws IOException {
            File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!downloadsDir.exists() && !downloadsDir.mkdirs()) {
                throw new IOException("No se pudo acceder a Descargas");
            }

            File destinationFile = new File(downloadsDir, filename);
            try (FileOutputStream fos = new FileOutputStream(destinationFile)) {
                fos.write(fileBytes);
                fos.flush();
            }

            DownloadManager downloadManager = (DownloadManager) mContext.getSystemService(Context.DOWNLOAD_SERVICE);
            if (downloadManager != null) {
                downloadManager.addCompletedDownload(
                    filename,
                    "Documento CIESPAL: " + filename,
                    true,
                    mimeType,
                    destinationFile.getAbsolutePath(),
                    destinationFile.length(),
                    true
                );
            }

            return Uri.fromFile(destinationFile);
        }

        private String escapeJson(String value) {
            return value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
        }
    }
}
