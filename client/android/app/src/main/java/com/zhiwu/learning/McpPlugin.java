package com.zhiwu.learning;

import android.Manifest;
import android.os.Build;
import android.os.Bundle;
import android.os.ResultReceiver;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONObject;

@CapacitorPlugin(name = "ZhiwuMcp", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class McpPlugin extends Plugin {
    private static volatile McpPlugin current;

    @Override public void load() {
        current = this;
    }

    @Override protected void handleOnResume() {
        McpService.restoreOnOpen(getContext());
    }

    @Override protected void handleOnDestroy() {
        if (current != this) return;
        current = null;
        McpHttpServer server = McpService.currentServer();
        if (server != null) server.cancelRequests();
        McpService.libraryClosed();
    }

    static boolean hasLibrary() { return current != null; }

    private static JSObject state() {
        McpHttpServer server = McpService.currentServer();
        McpHttpServer.Grant grant = server == null ? null : server.grant();
        JSObject state = new JSObject().put("running", grant != null).put("access", grant == null ? "read" : grant.access)
            .put("localUrl", McpEndpoint.LOCAL_URL).put("lanUrls", grant == null ? new JSArray() : new JSArray(McpEndpoint.networkUrls()));
        if (grant != null) {
            state.put("token", grant.token);
            if (grant.publicUrl != null) state.put("publicUrl", grant.publicUrl.toASCIIString());
            if (grant.clientOrigin != null) state.put("clientOrigin", grant.clientOrigin.toASCIIString());
        }
        return state;
    }

    @PluginMethod public void getState(PluginCall call) { call.resolve(state()); }

    @PluginMethod public void start(PluginCall call) {
        String access = call.getString("access");
        if (!"read".equals(access) && !"edit".equals(access)) {
            call.reject("请选择有效的笔记权限");
            return;
        }
        try {
            McpEndpoint.publicUrl(call.getString("publicUrl"));
            McpEndpoint.clientOrigin(call.getString("clientOrigin"));
        }
        catch (IllegalArgumentException invalid) {
            call.reject(invalid.getMessage());
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "notificationChoice");
            return;
        }
        command(call, McpService.START);
    }

    @PermissionCallback private void notificationChoice(PluginCall call) {
        // Android also exposes an active foreground service in its task manager when notifications are declined.
        if (call != null) command(call, McpService.START);
    }

    @PluginMethod public void stop(PluginCall call) { command(call, McpService.STOP); }

    private void command(PluginCall call, String action) {
        try {
            McpService.command(getContext(), action, call.getString("access"), call.getString("publicUrl"), call.getString("clientOrigin"),
                new ResultReceiver(null) {
                    @Override protected void onReceiveResult(int code, Bundle data) {
                        if (code == 0) call.resolve(state());
                        else call.reject(data.getString("error"));
                    }
                });
        } catch (RuntimeException unavailable) {
            call.reject("无法启动或关闭 MCP 前台服务，请打开知悟后重试");
        }
    }

    static void dispatch(String id) {
        McpPlugin plugin = current;
        McpHttpServer server = McpService.currentServer();
        if (server == null) return;
        if (plugin == null) { server.unavailable(id); return; }
        plugin.bridge.execute(() -> {
            if (plugin != current || !plugin.hasListeners("mcpRequest")) server.unavailable(id);
            else plugin.notifyListeners("mcpRequest", new JSObject().put("id", id));
        });
    }

    static void stateChanged() {
        McpPlugin plugin = current;
        if (plugin != null) plugin.bridge.execute(() -> {
            if (plugin == current && plugin.hasListeners("mcpStateChanged")) plugin.notifyListeners("mcpStateChanged", state());
        });
    }

    @PluginMethod public void takeRequest(PluginCall call) {
        McpHttpServer server = McpService.currentServer();
        McpHttpServer.Request request = server == null || current != this ? null : server.take(call.getString("id"));
        JSObject result = new JSObject().put("request", JSONObject.NULL);
        if (request != null) result.put("request", new JSObject().put("body", request.body)
            .put("headers", new JSONObject(request.headers)).put("access", request.access));
        call.resolve(result);
    }

    @PluginMethod public void respond(PluginCall call) {
        McpHttpServer server = McpService.currentServer();
        if (server != null && current == this) {
            Map<String, String> headers = new HashMap<>();
            JSObject values = call.getObject("headers", new JSObject());
            for (Iterator<String> keys = values.keys(); keys.hasNext();) {
                String key = keys.next();
                String value = values.getString(key);
                if (value != null) headers.put(key, value);
            }
            server.respond(call.getString("id"), call.getInt("status", 500), call.getString("body", ""), headers);
        }
        call.resolve();
    }
}
