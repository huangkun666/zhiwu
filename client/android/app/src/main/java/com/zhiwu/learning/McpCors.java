package com.zhiwu.learning;

import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelOutboundHandlerAdapter;
import io.netty.channel.ChannelPromise;
import io.netty.handler.codec.http.HttpHeaders;
import io.netty.handler.codec.http.HttpResponse;
import java.util.Locale;

/** One request per socket. Only the admission handler may set the validated origin. */
final class McpCors extends ChannelOutboundHandlerAdapter {
    private static final String STANDARD_HEADERS = "Authorization, Accept, Content-Type, MCP-Protocol-Version, MCP-Session-Id, MCP-Method, MCP-Name";
    String origin;
    boolean preflight;
    private String allowedHeaders;

    boolean permitsPreflight(HttpHeaders headers) {
        if (origin == null || headers.getAll("Access-Control-Request-Method").size() != 1
            || !"POST".equals(headers.get("Access-Control-Request-Method"))) return false;
        StringBuilder supported = new StringBuilder(STANDARD_HEADERS);
        for (String line : headers.getAll("Access-Control-Request-Headers")) {
            for (String raw : line.split(",", -1)) {
                String name = raw.trim().toLowerCase(Locale.ROOT);
                switch (name) {
                    case "authorization": case "accept": case "content-type": case "mcp-protocol-version":
                    case "mcp-session-id": case "mcp-method": case "mcp-name":
                        break;
                    default:
                        if (!name.matches("mcp-param-[a-z0-9._-]+")) return false;
                        supported.append(", ").append(name);
                }
            }
        }
        allowedHeaders = supported.toString();
        return true;
    }

    @Override public void write(ChannelHandlerContext ctx, Object message, ChannelPromise promise) throws Exception {
        if (message instanceof HttpResponse) {
            HttpResponse response = (HttpResponse) message;
            HttpHeaders headers = response.headers();
            headers.set("Vary", preflight ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" : "Origin");
            if (origin != null) {
                headers.set("Access-Control-Allow-Origin", origin);
                if (preflight && response.status().code() == 204 && allowedHeaders != null) {
                    headers.set("Access-Control-Allow-Methods", "POST").set("Access-Control-Allow-Headers", allowedHeaders);
                } else {
                    StringBuilder exposed = new StringBuilder("WWW-Authenticate, Allow, MCP-Protocol-Version, MCP-Session-Id");
                    for (String name : headers.names()) {
                        String lower = name.toLowerCase(Locale.ROOT);
                        if (lower.startsWith("mcp-") && !lower.equals("mcp-protocol-version") && !lower.equals("mcp-session-id")) {
                            exposed.append(", ").append(name);
                        }
                    }
                    headers.set("Access-Control-Expose-Headers", exposed.toString());
                }
            }
        }
        super.write(ctx, message, promise);
    }
}
