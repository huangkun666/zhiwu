package com.zhiwu.learning;

import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.ByteBufUtil;
import io.netty.buffer.Unpooled;
import io.netty.buffer.UnpooledByteBufAllocator;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.ChannelOption;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.channel.group.ChannelGroup;
import io.netty.channel.group.DefaultChannelGroup;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.FullHttpResponse;
import io.netty.handler.codec.http.HttpHeaders;
import io.netty.handler.codec.http.HttpMethod;
import io.netty.handler.codec.http.HttpObjectAggregator;
import io.netty.handler.codec.http.HttpRequest;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.HttpServerCodec;
import io.netty.handler.codec.http.HttpUtil;
import io.netty.handler.codec.http.HttpVersion;
import io.netty.handler.timeout.WriteTimeoutHandler;
import io.netty.util.ReferenceCountUtil;
import io.netty.util.concurrent.DefaultThreadFactory;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

final class McpHttpServer implements AutoCloseable {
    private static final int MAX_CONNECTIONS = 16;
    private static final int MAX_BODY = 1024 * 1024;
    private static final int LIBRARY_TIMEOUT_SECONDS = 20;
    private static final String UNAVAILABLE = "请在手机打开知悟并确认 MCP 连接已启用";
    private final NioEventLoopGroup io = new NioEventLoopGroup(1, new DefaultThreadFactory("ZhiwuMcp", true));
    private final ChannelGroup connections = new DefaultChannelGroup(io.next(), true);
    private final Map<String, Pending> pending = new HashMap<>();
    private final Channel listener;
    private final Consumer<String> dispatch;
    private volatile Grant grant;

    static final class Grant {
        final String access;
        final String token;
        final URI publicUrl;
        final URI clientOrigin;

        Grant(String access, String token, String endpoint, String origin) {
            if (!"edit".equals(access) && !"read".equals(access)) throw new IllegalArgumentException("请选择有效的笔记权限");
            if (token == null || !token.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("连接密钥无效");
            this.access = access;
            this.token = token;
            this.publicUrl = McpEndpoint.publicUrl(endpoint);
            this.clientOrigin = McpEndpoint.clientOrigin(origin);
        }

        static Grant create(String access, String publicUrl, String clientOrigin, Grant old) {
            String token = old != null && old.access.equals(access) ? old.token
                : (UUID.randomUUID().toString() + UUID.randomUUID()).replace("-", "");
            return new Grant(access, token, publicUrl, clientOrigin);
        }
    }

    static final class Request {
        final String body;
        final Map<String, String> headers;
        final String access;

        Request(FullHttpRequest message, String access) {
            this.body = message.content().toString(StandardCharsets.UTF_8);
            this.headers = new HashMap<>();
            for (Map.Entry<String, String> entry : message.headers()) {
                String key = entry.getKey().toLowerCase(Locale.ROOT);
                if (protocolHeader(key) || key.equals("accept")) {
                    headers.merge(key, entry.getValue(), (first, next) -> first + ", " + next);
                }
            }
            this.access = access;
        }
    }

    private static final class Pending {
        final ChannelHandlerContext channel;
        final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(LIBRARY_TIMEOUT_SECONDS);
        final ScheduledFuture<?> timeout;
        Request request;

        Pending(ChannelHandlerContext channel, Request request, Runnable expire) {
            this.channel = channel;
            this.request = request;
            this.timeout = channel.executor().schedule(expire, LIBRARY_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }
    }

    McpHttpServer(int port, Consumer<String> dispatch) throws IOException {
        this.dispatch = dispatch;
        try {
            ChannelFuture binding = new ServerBootstrap().group(io).channel(NioServerSocketChannel.class)
                .option(ChannelOption.SO_REUSEADDR, true).childOption(ChannelOption.ALLOCATOR, UnpooledByteBufAllocator.DEFAULT)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    @Override protected void initChannel(SocketChannel socket) {
                        if (connections.size() >= MAX_CONNECTIONS + 1) {
                            socket.close();
                            return;
                        }
                        connections.add(socket);
                        Admission admission = new Admission();
                        socket.pipeline().addLast(new WriteTimeoutHandler(10), new HttpServerCodec(4096, 8192, 8192), admission.cors, admission,
                            new HttpObjectAggregator(MAX_BODY, true), new SimpleChannelInboundHandler<FullHttpRequest>() {
                                @Override protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest message) {
                                    admission.headerDeadline.cancel(false);
                                    if (!message.decoderResult().isSuccess()) {
                                        error(ctx, 400, "无效的 HTTP 请求");
                                        return;
                                    }
                                    if (!ByteBufUtil.isText(message.content(), StandardCharsets.UTF_8)) {
                                        error(ctx, 400, "MCP 消息须使用 UTF-8 编码");
                                        return;
                                    }
                                    accept(ctx, message, admission.authorized);
                                }

                                @Override public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
                                    ctx.close();
                                }
                            });
                    }
                }).bind(port).awaitUninterruptibly();
            if (!binding.isSuccess()) throw new IOException("无法监听 MCP 端口 " + port, binding.cause());
            listener = binding.channel();
            connections.add(listener);
        } catch (IOException | RuntimeException failure) {
            io.shutdownGracefully(0, 1, TimeUnit.SECONDS);
            throw failure;
        }
    }

    private final class Admission extends ChannelInboundHandlerAdapter {
        private final McpCors cors = new McpCors();
        private Grant authorized;
        private boolean discard;
        private ScheduledFuture<?> headerDeadline;

        @Override public void channelActive(ChannelHandlerContext ctx) throws Exception {
            headerDeadline = ctx.executor().schedule(() -> ctx.close(), 10, TimeUnit.SECONDS);
            super.channelActive(ctx);
        }

        @Override public void channelRead(ChannelHandlerContext ctx, Object message) {
            if (!discard && message instanceof HttpRequest) {
                // This endpoint closes after each response. Never dispatch pipelined requests on the same socket.
                if (authorized != null) discard = true;
                else {
                    authorized = grant;
                    discard = !allow(ctx, (HttpRequest) message, authorized, cors);
                }
            }
            if (discard) ReferenceCountUtil.release(message);
            else ctx.fireChannelRead(message);
        }

        @Override public void channelInactive(ChannelHandlerContext ctx) throws Exception {
            if (headerDeadline != null) headerDeadline.cancel(false);
            super.channelInactive(ctx);
        }
    }

    private static boolean allow(ChannelHandlerContext ctx, HttpRequest request, Grant grant, McpCors cors) {
        HttpHeaders headers = request.headers();
        InetSocketAddress local = (InetSocketAddress) ctx.channel().localAddress();
        cors.preflight = HttpMethod.OPTIONS.equals(request.method());
        if (!request.decoderResult().isSuccess()) return error(ctx, 400, "无效的 HTTP 请求");
        if (grant == null) return error(ctx, 503, UNAVAILABLE);
        if (headers.getAll("Host").size() != 1 || !McpEndpoint.allowedHost(headers.get("Host"), local, grant.publicUrl)
            || headers.getAll("Origin").size() > 1 || !McpEndpoint.allowedOrigin(headers.get("Origin"), local, grant.publicUrl, grant.clientOrigin)) {
            return error(ctx, 403, "访问地址或来源未经授权");
        }
        boolean route = "/mcp".equals(request.uri()) || (grant.publicUrl != null && grant.publicUrl.getRawPath().equals(request.uri()));
        if (route) cors.origin = headers.get("Origin");
        if (cors.preflight) {
            if (!route) return error(ctx, 404, "MCP 地址不存在");
            if (!cors.permitsPreflight(headers)) return error(ctx, 403, "网页预检方法、来源或请求头未经授权");
            send(ctx, 204, "", Collections.emptyMap());
            return false;
        }
        String bearer = headers.get("Authorization");
        if (headers.getAll("Authorization").size() != 1 || !bearer.regionMatches(true, 0, "Bearer ", 0, 7)
            || !MessageDigest.isEqual(grant.token.getBytes(StandardCharsets.UTF_8), bearer.substring(7).getBytes(StandardCharsets.UTF_8))) {
            return error(ctx, 401, "需要有效的 Bearer 连接密钥");
        }
        if (!route) return error(ctx, 404, "MCP 地址不存在");
        if (!HttpMethod.POST.equals(request.method())) return error(ctx, 405, "请使用 POST 发送 MCP 消息");
        if (HttpUtil.getContentLength(request, -1) > MAX_BODY) return error(ctx, 413, "MCP 请求超过 1 MiB");
        return true;
    }

    synchronized void authorize(Grant next) {
        if (next != null && grant != null && next.token.equals(grant.token)
            && Objects.equals(next.publicUrl, grant.publicUrl) && Objects.equals(next.clientOrigin, grant.clientOrigin)) return;
        grant = next;
        cancelRequests();
    }

    Grant grant() { return grant; }

    int port() { return ((InetSocketAddress) listener.localAddress()).getPort(); }

    private synchronized void accept(ChannelHandlerContext ctx, FullHttpRequest message, Grant authorized) {
        if (authorized == null || authorized != grant) {
            error(ctx, 503, UNAVAILABLE);
            return;
        }
        String id = UUID.randomUUID().toString();
        Pending item = new Pending(ctx, new Request(message, authorized.access), () -> fail(id, 504, "等待手机笔记库处理超时，请打开知悟核对结果"));
        pending.put(id, item);
        ctx.channel().closeFuture().addListener(future -> remove(id));
        try {
            dispatch.accept(id);
        } catch (RuntimeException unavailable) {
            unavailable(id);
        }
    }

    synchronized Request take(String id) {
        Pending item = live(id);
        if (item == null) return null;
        Request request = item.request;
        item.request = null;
        return request;
    }

    synchronized void respond(String id, int status, String body, Map<String, String> headers) {
        Pending item = live(id);
        if (item == null || item.request != null) return;
        remove(id);
        if (status < 200 || status > 599) {
            error(item.channel, 500, "笔记库返回无效的 HTTP 状态");
            return;
        }
        send(item.channel, status, body, headers);
    }

    private Pending live(String id) {
        Pending item = pending.get(id);
        if (item != null && (System.nanoTime() - item.deadline >= 0 || !item.channel.channel().isActive())) {
            fail(id, 504, "手机笔记库请求已过期");
            return null;
        }
        return item;
    }

    synchronized void cancelRequests() {
        for (String id : pending.keySet().toArray(new String[0])) unavailable(id);
    }

    void unavailable(String id) { fail(id, 503, UNAVAILABLE); }

    private synchronized void fail(String id, int status, String message) {
        Pending item = remove(id);
        if (item != null) error(item.channel, status, message);
    }

    private synchronized Pending remove(String id) {
        Pending item = pending.remove(id);
        if (item != null) item.timeout.cancel(false);
        return item;
    }

    private static boolean protocolHeader(String name) {
        return name.equals("content-type") || name.startsWith("mcp-");
    }

    private static boolean error(ChannelHandlerContext ctx, int status, String message) {
        send(ctx, status, message, Collections.singletonMap("content-type", "text/plain; charset=utf-8"));
        return false;
    }

    private static void send(ChannelHandlerContext ctx, int status, String body, Map<String, String> headers) {
        byte[] data = status == 202 || status == 204 ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        FullHttpResponse response = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.valueOf(status), Unpooled.wrappedBuffer(data));
        if (data.length > 0) response.headers().set("Content-Type", "application/json");
        for (Map.Entry<String, String> h : headers.entrySet()) {
            if (protocolHeader(h.getKey().toLowerCase(Locale.ROOT))) {
                try { response.headers().set(h.getKey(), h.getValue()); }
                catch (IllegalArgumentException ignored) {}
            }
        }
        if (status == 401) response.headers().set("WWW-Authenticate", "Bearer realm=\"Zhiwu MCP\"");
        if (status == 405) response.headers().set("Allow", "POST");
        response.headers().set("Cache-Control", "no-store").set("Connection", "close").setInt("Content-Length", data.length);
        ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
    }

    @Override public void close() {
        authorize(null);
        connections.close().awaitUninterruptibly();
        io.shutdownGracefully(0, 1, TimeUnit.SECONDS);
    }
}
