package com.zhiwu.learning;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.ResultReceiver;
import android.util.AtomicFile;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class McpService extends Service {
    static final String START = "com.zhiwu.learning.mcp.START";
    static final String STOP = "com.zhiwu.learning.mcp.STOP";
    private static final String RESTORE = "com.zhiwu.learning.mcp.RESTORE";
    private static final String CHANNEL = "zhiwu_mcp";
    private static final int NOTIFICATION = 37821;
    // Serialize start, revoke, and teardown even when Android replaces the Service instance.
    private static final ExecutorService commands = Executors.newSingleThreadExecutor();
    private static volatile McpService active;
    private volatile McpHttpServer server;
    private volatile boolean suspending;
    private int lastStartId;
    private ConnectivityManager.NetworkCallback networks;

    private static AtomicFile config(Context context) {
        return new AtomicFile(new File(context.getNoBackupFilesDir(), "mcp-connection.properties"));
    }

    private McpHttpServer.Grant savedGrant() throws IOException {
        try (FileInputStream in = config(this).openRead()) {
            Properties saved = new Properties();
            saved.load(in);
            return new McpHttpServer.Grant(saved.getProperty("access"), saved.getProperty("token"),
                saved.getProperty("publicUrl"), saved.getProperty("clientOrigin"));
        } catch (FileNotFoundException | IllegalArgumentException invalid) {
            return null;
        }
    }

    private void save(McpHttpServer.Grant grant) throws IOException {
        AtomicFile file = config(this);
        Properties saved = new Properties();
        saved.setProperty("access", grant.access);
        saved.setProperty("token", grant.token);
        if (grant.publicUrl != null) saved.setProperty("publicUrl", grant.publicUrl.toASCIIString());
        if (grant.clientOrigin != null) saved.setProperty("clientOrigin", grant.clientOrigin.toASCIIString());
        FileOutputStream out = file.startWrite();
        try {
            saved.store(out, null);
            file.finishWrite(out);
        } catch (IOException | RuntimeException failure) {
            file.failWrite(out);
            throw failure;
        }
    }

    static void command(Context context, String action, String access, String url, String clientOrigin, ResultReceiver reply) {
        Intent intent = new Intent(context, McpService.class).setAction(action)
            .putExtra("access", access).putExtra("publicUrl", url).putExtra("clientOrigin", clientOrigin).putExtra("reply", reply);
        if (STOP.equals(action)) context.startService(intent);
        else ContextCompat.startForegroundService(context, intent);
    }

    static void restoreOnOpen(Context context) {
        McpService service = active;
        if ((service == null || service.suspending) && config(context).getBaseFile().isFile()) {
            try { command(context, RESTORE, null, null, null, null); }
            catch (IllegalStateException | SecurityException unavailable) {
                // The activity can retry when Android next allows it to start a foreground service.
            }
        }
    }

    static void libraryClosed() {
        McpService service = active;
        if (service == null) return;
        service.suspending = true;
        int startId = service.lastStartId;
        commands.execute(() -> {
            if (active != service || McpPlugin.hasLibrary()) return;
            service.closeServer();
            service.stopSelfResult(startId);
        });
    }

    static McpHttpServer currentServer() {
        McpService service = active;
        return service == null ? null : service.server;
    }

    @Override public void onCreate() {
        super.onCreate();
        active = this;
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        networks = new ConnectivityManager.NetworkCallback() {
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) { McpPlugin.stateChanged(); }
            @Override public void onLost(Network network) { McpPlugin.stateChanged(); }
        };
        try { manager.registerNetworkCallback(new NetworkRequest.Builder().clearCapabilities().build(), networks); }
        catch (RuntimeException unavailable) { networks = null; }
    }

    private Notification notification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "MCP 连接", NotificationManager.IMPORTANCE_LOW));
        }
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), flags);
        PendingIntent stop = PendingIntent.getService(this, 0, new Intent(this, McpService.class).setAction(STOP), flags);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("知悟 MCP 连接").setContentText("已授权的 AI 可连接此设备的笔记库")
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "关闭连接", stop).build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        String action = intent == null ? null : intent.getAction();
        ResultReceiver reply = intent == null ? null : intent.getParcelableExtra("reply");
        if (START.equals(action) || RESTORE.equals(action)) {
            suspending = false;
            try { startForeground(NOTIFICATION, notification()); }
            catch (RuntimeException denied) {
                complete(reply, "无法启动前台连接，请在知悟界面重新启用");
                stopSelfResult(startId);
                return START_NOT_STICKY;
            }
        }
        commands.execute(() -> {
            String failure = null;
            try {
                if (STOP.equals(action)) {
                    closeServer();
                    AtomicFile file = config(this);
                    file.delete();
                    if (file.getBaseFile().exists()) throw new IOException("无法移除已保存的连接授权");
                } else if (START.equals(action) || RESTORE.equals(action)) {
                    McpHttpServer.Grant saved = savedGrant();
                    McpHttpServer.Grant grant = RESTORE.equals(action) ? saved
                        : McpHttpServer.Grant.create(intent.getStringExtra("access"), intent.getStringExtra("publicUrl"),
                            intent.getStringExtra("clientOrigin"), saved);
                    if (grant != null) {
                        if (server == null) server = new McpHttpServer(McpEndpoint.PORT, McpPlugin::dispatch);
                        if (START.equals(action)) save(grant);
                        server.authorize(grant);
                    }
                }
            } catch (Exception error) {
                failure = error.getMessage() == null ? "无法启用手机 MCP 连接" : error.getMessage();
            }
            // Switching apps leaves the Activity and library alive. Finishing it releases both
            // the socket and notification until the next open, while keeping the user's grant.
            if (!McpPlugin.hasLibrary()) {
                suspending = true;
                closeServer();
            }
            if (server == null || server.grant() == null) {
                closeServer();
                stopSelfResult(startId);
            }
            McpPlugin.stateChanged();
            complete(reply, failure);
        });
        return START_NOT_STICKY;
    }

    private static void complete(ResultReceiver reply, String message) {
        if (reply == null) return;
        Bundle result = new Bundle();
        result.putString("error", message);
        reply.send(message == null ? 0 : 1, result);
    }

    private void closeServer() {
        McpHttpServer closing = server;
        server = null;
        if (closing != null) closing.close();
    }

    @Override public void onDestroy() {
        if (active == this) active = null;
        if (networks != null) getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networks);
        commands.execute(this::closeServer);
        stopForeground(STOP_FOREGROUND_REMOVE);
        McpPlugin.stateChanged();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
