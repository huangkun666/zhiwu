package com.zhiwu.learning;

import static org.junit.Assert.*;

import java.io.ByteArrayOutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class McpHttpServerTest {
    private final BlockingQueue<String> events = new LinkedBlockingQueue<>();
    private McpHttpServer server;
    private McpHttpServer.Grant grant;

    @Before public void start() throws Exception {
        server = new McpHttpServer(0, events::add);
        grant = McpHttpServer.Grant.create("read", "https://notes.example/team/mcp", null, null);
        server.authorize(grant);
    }

    @After public void stop() {
        if (server != null) server.close();
    }

    private String host() {
        return "127.0.0.1:" + server.port();
    }

    private Socket request(String method, String path, String host, String headers, String body) throws Exception {
        Socket socket = new Socket("127.0.0.1", server.port());
        socket.setSoTimeout(3000);
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        String head = method + " " + path + " HTTP/1.1\r\nHost: " + host
            + "\r\nContent-Type: application/json\r\nContent-Length: " + content.length + "\r\n" + headers + "\r\n";
        socket.getOutputStream().write(head.getBytes(StandardCharsets.US_ASCII));
        socket.getOutputStream().write(content);
        return socket;
    }

    private String response(Socket socket) throws Exception {
        try (Socket closing = socket) {
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int length;
            while ((length = closing.getInputStream().read(buffer)) != -1) data.write(buffer, 0, length);
            return data.toString("UTF-8");
        }
    }

    private String auth() {
        return "Authorization: Bearer " + grant.token + "\r\n";
    }

    @Test public void validatesOriginHostBearerPathAndMethodBeforeDispatch() throws Exception {
        assertTrue(response(request("POST", "/mcp", host(), "", "{}")).startsWith("HTTP/1.1 401"));
        assertTrue(response(request("GET", "/mcp", host(), "", "")).contains("WWW-Authenticate"));
        assertTrue(response(request("POST", "/mcp", "elsewhere.example", auth(), "{}")).startsWith("HTTP/1.1 403"));
        assertTrue(response(request("POST", "/mcp", host(), auth() + "Origin: https://elsewhere.example\r\n", "{}")).startsWith("HTTP/1.1 403"));
        assertTrue(response(request("POST", "/mcp", host(), auth() + "Authorization: Bearer other\r\n", "{}")).startsWith("HTTP/1.1 401"));
        assertTrue(response(request("POST", "/other", host(), auth(), "{}")).startsWith("HTTP/1.1 404"));
        assertTrue(response(request("GET", "/mcp", host(), auth(), "")).startsWith("HTTP/1.1 405"));
        assertNull(events.poll());
    }

    @Test public void onlyClaimedRequestsReturnLibraryResultsAndProtocolHeaders() throws Exception {
        String headers = auth() + "Origin: https://notes.example\r\nMCP-Protocol-Version: 2025-11-25\r\n"
            + "Cookie: private\r\nAccept: application/json, text/event-stream\r\n";
        Socket pending = request("POST", "/mcp", "notes.example", headers, "{\"note\":\"测试\"}");
        String id = events.poll(2, TimeUnit.SECONDS);
        assertNotNull(id);
        McpHttpServer.Request request = server.take(id);
        assertEquals("read", request.access);
        assertEquals("{\"note\":\"测试\"}", request.body);
        assertEquals("2025-11-25", request.headers.get("mcp-protocol-version"));
        assertEquals("application/json, text/event-stream", request.headers.get("accept"));
        assertEquals("application/json", request.headers.get("content-type"));
        assertEquals(3, request.headers.size());
        assertNull(server.take(id));
        server.respond(id, 200, "{\"saved\":true}", Collections.singletonMap("MCP-Protocol-Version", "2025-11-25"));
        String result = response(pending);
        assertTrue(result.startsWith("HTTP/1.1 200"));
        assertTrue(result.toLowerCase(java.util.Locale.ROOT).contains("mcp-protocol-version: 2025-11-25"));
        assertTrue(result.endsWith("{\"saved\":true}"));

        Socket notification = request("POST", "/team/mcp", host(), headers, "{}");
        String next = events.poll(2, TimeUnit.SECONDS);
        assertNotNull(server.take(next));
        server.respond(next, 202, "", Collections.emptyMap());
        String accepted = response(notification);
        assertTrue(accepted.startsWith("HTTP/1.1 202"));
        assertTrue(accepted.endsWith("\r\n\r\n"));
    }

    @Test public void revokingAnOutstandingRequestPreventsLaterClaimsAndOldKeyUse() throws Exception {
        Socket pending = request("POST", "/mcp", host(), auth(), "{}");
        String id = events.poll(2, TimeUnit.SECONDS);
        assertNotNull(id);
        McpHttpServer.Grant changed = McpHttpServer.Grant.create("edit", null, null, grant);
        assertNotEquals(grant.token, changed.token);
        server.authorize(changed);
        assertNull(server.take(id));
        assertTrue(response(pending).startsWith("HTTP/1.1 503"));
        assertTrue(response(request("POST", "/mcp", host(), auth(), "{}")).startsWith("HTTP/1.1 401"));
        assertEquals(changed.token, McpHttpServer.Grant.create("edit", "https://edge.example/mcp", null, changed).token);
        assertNotEquals(changed.token, McpHttpServer.Grant.create("edit", null, null, null).token);
    }

    @Test public void rejectsOversizedInputWithoutRunningLibraryCode() throws Exception {
        try (Socket socket = new Socket("127.0.0.1", server.port())) {
            socket.setSoTimeout(3000);
            String head = "POST /mcp HTTP/1.1\r\nHost: " + host() + "\r\n" + auth()
                + "Content-Type: application/json\r\nContent-Length: 20000000\r\n\r\n";
            socket.getOutputStream().write(head.getBytes(StandardCharsets.US_ASCII));
            assertTrue(response(socket).startsWith("HTTP/1.1 413"));
        }
        assertNull(events.poll());
    }

    @Test public void neverSubstitutesMalformedUtf8InNoteContent() throws Exception {
        try (Socket socket = new Socket("127.0.0.1", server.port())) {
            socket.setSoTimeout(3000);
            String head = "POST /mcp HTTP/1.1\r\nHost: " + host() + "\r\n" + auth()
                + "Content-Type: application/json\r\nContent-Length: 3\r\n\r\n";
            socket.getOutputStream().write(head.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().write(new byte[] { '"', (byte) 0xff, '"' });
            assertNull(events.poll(500, TimeUnit.MILLISECONDS));
            assertTrue(response(socket).startsWith("HTTP/1.1 400"));
        }
    }

    @Test public void supportsReachableIpv6AndConfiguredProxyAuthorities() throws Exception {
        InetSocketAddress address = new InetSocketAddress(InetAddress.getByName("2001:db8::9"), 37821);
        assertTrue(McpEndpoint.allowedHost("[2001:db8::9]:37821", address, null));
        assertTrue(McpEndpoint.allowedOrigin("http://[2001:0db8:0:0:0:0:0:9]:37821", address, null, null));
        assertFalse(McpEndpoint.allowedHost("localhost:37821", address, null));
        assertFalse(McpEndpoint.allowedHost("notes.example:444", address, grant.publicUrl));
        assertTrue(McpEndpoint.allowedHost("NOTES.example:443", address, grant.publicUrl));
        assertFalse(McpEndpoint.allowedOrigin("http://notes.example", address, grant.publicUrl, null));
        assertThrows(IllegalArgumentException.class, () -> McpEndpoint.publicUrl("https://user@notes.example/mcp"));
        assertThrows(IllegalArgumentException.class, () -> McpEndpoint.publicUrl("https://notes.example/mcp?token=example"));
    }

    @Test public void acceptsTheExactCustomProxyPathIncludingRootAndTrailingSlash() throws Exception {
        String[][] routes = { { "https://notes.example/ai/tools", "/ai/tools" },
            { "https://notes.example/relay/", "/relay/" }, { "https://notes.example", "/" } };
        for (String[] route : routes) {
            server.authorize(McpHttpServer.Grant.create("read", route[0], null, grant));
            Socket pending = request("POST", route[1], "notes.example", auth(), "{}");
            String id = events.poll(2, TimeUnit.SECONDS);
            assertNotNull(server.take(id));
            server.respond(id, 202, "", Collections.emptyMap());
            assertTrue(response(pending).startsWith("HTTP/1.1 202"));
            assertTrue(response(request("POST", "/different", "notes.example", auth(), "{}")).startsWith("HTTP/1.1 404"));
        }
        assertThrows(IllegalArgumentException.class, () -> McpEndpoint.publicUrl("https://notes.example/ai/tools#fragment"));
    }

    @Test public void preflightChecksMethodAndProtocolHeadersWithoutReadingNotes() throws Exception {
        String headers = "Origin: https://notes.example\r\nAccess-Control-Request-Method: POST\r\n"
            + "Access-Control-Request-Headers: authorization, content-type, mcp-method, mcp-protocol-version\r\n";
        String result = response(request("OPTIONS", "/mcp", host(), headers, "")).toLowerCase(java.util.Locale.ROOT);
        assertTrue(result.startsWith("http/1.1 204"));
        assertTrue(result.contains("access-control-allow-origin: https://notes.example"));
        assertTrue(result.contains("access-control-allow-methods: post"));
        assertTrue(result.contains("access-control-allow-headers:") && result.contains("mcp-protocol-version"));
        assertFalse(result.contains("access-control-allow-credentials"));
        assertTrue(result.contains("vary:") && result.contains("access-control-request-headers"));
        assertTrue(result.endsWith("\r\n\r\n"));
        assertTrue(response(request("OPTIONS", "/mcp", host(), headers.replace("POST", "PUT"), "")).startsWith("HTTP/1.1 403"));
        assertTrue(response(request("OPTIONS", "/mcp", host(), headers.replace("mcp-method", "x-unrelated"), "")).startsWith("HTTP/1.1 403"));
        assertTrue(response(request("OPTIONS", "/other", host(), headers, "")).startsWith("HTTP/1.1 404"));
        assertNull(events.poll());
    }

    @Test public void trustedBrowserReadsAuthenticatedRepliesAndExplicitErrors() throws Exception {
        String origin = "Origin: https://client.example\r\n";
        assertTrue(response(request("POST", "/mcp", host(), origin + auth(), "{}")).startsWith("HTTP/1.1 403"));
        McpHttpServer.Grant browser = McpHttpServer.Grant.create("read", null, "https://CLIENT.example:443/", grant);
        assertEquals("https://client.example", browser.clientOrigin.toASCIIString());
        server.authorize(browser);
        String denied = response(request("POST", "/mcp", host(), origin, "{}")).toLowerCase(java.util.Locale.ROOT);
        assertTrue(denied.startsWith("http/1.1 401") && denied.contains("access-control-allow-origin: https://client.example"));
        assertFalse(denied.contains("access-control-allow-credentials"));
        String unrelated = response(request("OPTIONS", "/mcp", host(),
            "Origin: https://another.example\r\nAccess-Control-Request-Method: POST\r\n", ""));
        assertTrue(unrelated.startsWith("HTTP/1.1 403"));
        assertFalse(unrelated.toLowerCase(java.util.Locale.ROOT).contains("access-control-allow-origin:"));
        Socket pending = request("POST", "/mcp", host(), origin + auth(), "{}");
        String id = events.poll(2, TimeUnit.SECONDS);
        assertNotNull(server.take(id));
        server.respond(id, 200, "{}", Collections.singletonMap("Mcp-Session-Id", "example"));
        String result = response(pending).toLowerCase(java.util.Locale.ROOT);
        assertTrue(result.startsWith("http/1.1 200") && result.contains("access-control-allow-origin: https://client.example"));
        assertTrue(result.contains("access-control-expose-headers:") && result.contains("mcp-session-id"));

        Socket outstanding = request("POST", "/mcp", host(), origin + auth(), "{}");
        String revoked = events.poll(2, TimeUnit.SECONDS);
        server.authorize(McpHttpServer.Grant.create("read", null, null, browser));
        assertNull(server.take(revoked));
        assertTrue(response(outstanding).startsWith("HTTP/1.1 503"));
        assertTrue(response(request("POST", "/mcp", host(), origin + auth(), "{}")).startsWith("HTTP/1.1 403"));
        assertThrows(IllegalArgumentException.class, () -> McpEndpoint.clientOrigin("https://client.example/some/path"));
        assertThrows(IllegalArgumentException.class, () -> McpEndpoint.clientOrigin("https://user@client.example"));
        assertThrows(IllegalArgumentException.class, () -> McpEndpoint.clientOrigin("https://client.example?param=1"));
    }
}
