package org.ciespal.mediateca.digitizer;

import android.app.DownloadManager;
import android.content.Context;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Registrar interfaz nativa para la barra de notificaciones de Android
        this.bridge.getWebView().addJavascriptInterface(new WebAppInterface(this), "AndroidDownloadManager");
    }

    public class WebAppInterface {
        Context mContext;

        WebAppInterface(Context c) {
            mContext = c;
        }

        @JavascriptInterface
        public void downloadFile(String base64Data, String filename, String mimeType) {
            try {
                // 1. Escribir el archivo directamente en la carpeta pública /Download/ del almacenamiento del celular
                File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloadsDir.exists()) {
                    downloadsDir.mkdirs();
                }

                File destinationFile = new File(downloadsDir, filename);
                byte[] fileBytes = Base64.decode(base64Data, Base64.DEFAULT);

                FileOutputStream fos = new FileOutputStream(destinationFile);
                fos.write(fileBytes);
                fos.flush();
                fos.close();

                // 2. Registrar en el sistema DownloadManager de Android para activar la NOTIFICACIÓN EN LA BARRA SUPERIOR
                DownloadManager downloadManager = (DownloadManager) mContext.getSystemService(Context.DOWNLOAD_SERVICE);
                if (downloadManager != null) {
                    downloadManager.addCompletedDownload(
                        filename,
                        "Documento CIESPAL: " + filename,
                        true,
                        mimeType,
                        destinationFile.getAbsolutePath(),
                        destinationFile.length(),
                        true // Muestra la notificación en la barra superior de Android
                    );
                }

                runOnUiThread(() -> {
                    Toast.makeText(mContext, "⬇ Descargando " + filename + "\nRevise la barra de notificaciones arriba", Toast.LENGTH_LONG).show();
                });
            } catch (Exception e) {
                e.printStackTrace();
                runOnUiThread(() -> {
                    Toast.makeText(mContext, "Error en descarga: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                });
            }
        }
    }
}
