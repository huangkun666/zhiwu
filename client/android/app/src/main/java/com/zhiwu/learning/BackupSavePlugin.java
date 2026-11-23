package com.zhiwu.learning;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ZhiwuBackupSave")
public class BackupSavePlugin extends Plugin {
    private static final int MAX_CHUNK_BYTES = 512 * 1024;
    private static final int MAX_ENCODED_CHUNK_LENGTH = ((MAX_CHUNK_BYTES + 2) / 3) * 4;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private boolean choosingFile;
    private SaveSession active;

    private static final class SaveSession {
        final String id = UUID.randomUUID().toString();
        final Uri uri;
        final OutputStream stream;
        final long expectedBytes;
        long writtenBytes;

        SaveSession(Uri uri, OutputStream stream, long expectedBytes) {
            this.uri = uri;
            this.stream = stream;
            this.expectedBytes = expectedBytes;
        }
    }

    @PluginMethod
    public void chooseFile(PluginCall call) {
        io.execute(() -> {
            if (choosingFile || active != null) {
                call.reject("已有文件正在保存");
                return;
            }
            String filename = call.getString("filename", "zhiwu-backup.zip")
                .replace('/', '_').replace('\\', '_').replaceAll("\\p{Cntrl}", "_").trim();
            String mimeType = call.getString("mimeType", "application/octet-stream");
            if (filename.isEmpty() || call.getData().optLong("size", -1) < 0) {
                call.reject("文件名或大小无效");
                return;
            }

            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mimeType)
                .putExtra(Intent.EXTRA_TITLE, filename);
            choosingFile = true;
            getActivity().runOnUiThread(() -> {
                try {
                    startActivityForResult(call, intent, "fileChosen");
                } catch (RuntimeException error) {
                    io.execute(() -> {
                        choosingFile = false;
                        call.reject("无法打开系统文件保存窗口");
                    });
                }
            });
        });
    }

    @ActivityCallback
    private void fileChosen(PluginCall call, ActivityResult result) {
        io.execute(() -> {
            choosingFile = false;
            Intent data = result.getData();
            Uri uri = data == null ? null : data.getData();
            if (result.getResultCode() != Activity.RESULT_OK) {
                if (call != null) call.resolve(new JSObject());
                return;
            }
            if (uri == null || !"content".equals(uri.getScheme())) {
                if (call != null) call.reject("系统未返回可写入的文件");
                return;
            }
            if (call == null || PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId())) {
                discardDocument(uri);
                return;
            }
            try {
                OutputStream stream = getContext().getContentResolver().openOutputStream(uri);
                if (stream == null) throw new IOException("Missing output stream");
                active = new SaveSession(uri, stream, call.getData().optLong("size"));
                call.resolve(new JSObject().put("id", active.id));
            } catch (IOException | RuntimeException error) {
                discardDocument(uri);
                call.reject("无法写入所选文件，请选择其他位置");
            }
        });
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        io.execute(() -> {
            if (!isActive(call)) {
                call.reject("文件保存已结束");
                return;
            }
            try {
                String encoded = call.getString("base64", "");
                if (encoded.isEmpty() || encoded.length() > MAX_ENCODED_CHUNK_LENGTH) throw new IOException("Invalid chunk");
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (bytes.length == 0 || bytes.length > MAX_CHUNK_BYTES || bytes.length > active.expectedBytes - active.writtenBytes) {
                    throw new IOException("Invalid chunk size");
                }
                active.stream.write(bytes);
                active.writtenBytes += bytes.length;
                call.resolve();
            } catch (IOException | RuntimeException error) {
                discardActive();
                call.reject("文件未写入完成，请检查存储空间或保存位置");
            }
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        io.execute(() -> {
            if (!isActive(call)) {
                call.reject("文件保存已结束");
                return;
            }
            try {
                if (active.writtenBytes != active.expectedBytes) throw new IOException("Incomplete file");
                active.stream.close();
                active = null;
                call.resolve();
            } catch (IOException | RuntimeException error) {
                discardActive();
                call.reject("文件未保存完整，请重新导出");
            }
        });
    }

    @PluginMethod
    public void abort(PluginCall call) {
        io.execute(() -> {
            if (isActive(call)) discardActive();
            call.resolve();
        });
    }

    private boolean isActive(PluginCall call) {
        return active != null && active.id.equals(call.getString("id"));
    }

    private void discardActive() {
        SaveSession abandoned = active;
        active = null;
        if (abandoned == null) return;
        try {
            abandoned.stream.close();
        } catch (IOException | RuntimeException ignored) {
            // Closing a failed provider stream can fail too. Try removing the partial file anyway.
        }
        discardDocument(abandoned.uri);
    }

    private void discardDocument(Uri uri) {
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
        } catch (IOException | RuntimeException ignored) {
            // Some storage providers do not support deleting via the create-document grant.
        }
    }

    @Override
    protected void handleOnDestroy() {
        io.execute(this::discardActive);
        io.shutdown();
    }
}
