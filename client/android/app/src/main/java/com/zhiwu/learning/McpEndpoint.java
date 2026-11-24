package com.zhiwu.learning;

import io.netty.util.NetUtil;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/** The socket's actual destination and the explicit public endpoint are the only trusted authorities. */
final class McpEndpoint {
    static final int PORT = 37821;
    static final String LOCAL_URL = "http://127.0.0.1:" + PORT + "/mcp";

    static URI publicUrl(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        try {
            URI url = URI.create(value.trim()).normalize();
            if (validHttpUrl(url)) return url.getRawPath().isEmpty() ? url.resolve("/") : url;
        } catch (IllegalArgumentException ignored) {}
        throw new IllegalArgumentException("自定义地址须为 HTTP(S) 网址，且不含凭据、查询或片段");
    }

    static URI clientOrigin(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        try {
            URI url = URI.create(value.trim());
            if (validHttpUrl(url) && (url.getRawPath().isEmpty() || "/".equals(url.getRawPath()))) {
                String scheme = url.getScheme().toLowerCase(Locale.ROOT);
                int port = url.getPort();
                String suffix = port == -1 || port == ("https".equals(scheme) ? 443 : 80) ? "" : ":" + port;
                return URI.create(scheme + "://" + url.getHost().toLowerCase(Locale.ROOT) + suffix);
            }
        } catch (IllegalArgumentException ignored) {}
        throw new IllegalArgumentException("网页客户端来源须为 HTTP(S) 的协议、主机和可选端口，且不含路径、凭据、查询或片段");
    }

    private static boolean validHttpUrl(URI url) {
        return ("http".equalsIgnoreCase(url.getScheme()) || "https".equalsIgnoreCase(url.getScheme()))
            && url.getHost() != null && url.getRawUserInfo() == null && url.getRawQuery() == null
            && url.getRawFragment() == null && url.getPort() != 0 && url.getPort() <= 65535;
    }

    static boolean allowedHost(String host, InetSocketAddress local, URI external) {
        if (host == null) return false;
        try {
            URI authority = URI.create("http://" + host);
            return validHttpUrl(authority) && authority.getRawPath().isEmpty()
                && (localAuthority(authority, local) || (external != null && sameAuthority(authority, external)));
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    static boolean allowedOrigin(String origin, InetSocketAddress local, URI external, URI clientOrigin) {
        if (origin == null) return true;
        try {
            URI uri = URI.create(origin);
            if (!validHttpUrl(uri) || !uri.getRawPath().isEmpty()) return false;
            return ("http".equalsIgnoreCase(uri.getScheme()) && localAuthority(uri, local))
                || matchesOrigin(uri, external) || matchesOrigin(uri, clientOrigin);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private static boolean matchesOrigin(URI candidate, URI expected) {
        return expected != null && expected.getScheme().equalsIgnoreCase(candidate.getScheme()) && sameAuthority(candidate, expected);
    }

    private static boolean localAuthority(URI uri, InetSocketAddress local) {
        return effectivePort(uri, 80) == local.getPort() && (
            Arrays.equals(NetUtil.createByteArrayFromIpAddressString(uri.getHost()), local.getAddress().getAddress())
            || (local.getAddress().isLoopbackAddress() && "localhost".equalsIgnoreCase(uri.getHost()))
        );
    }

    private static boolean sameAuthority(URI candidate, URI expected) {
        int defaultPort = "https".equalsIgnoreCase(expected.getScheme()) ? 443 : 80;
        if (effectivePort(candidate, defaultPort) != effectivePort(expected, defaultPort)) return false;
        if (expected.getHost().equalsIgnoreCase(candidate.getHost())) return true;
        byte[] expectedIp = NetUtil.createByteArrayFromIpAddressString(expected.getHost());
        return expectedIp != null && Arrays.equals(expectedIp, NetUtil.createByteArrayFromIpAddressString(candidate.getHost()));
    }

    private static int effectivePort(URI uri, int defaultPort) {
        return uri.getPort() == -1 ? defaultPort : uri.getPort();
    }

    static List<String> networkUrls() {
        Set<String> urls = new TreeSet<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return Collections.emptyList();
            for (NetworkInterface network : Collections.list(interfaces)) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isAnyLocalAddress() || address.isMulticastAddress()) continue;
                    urls.add("http://" + NetUtil.toSocketAddressString(new InetSocketAddress(address, PORT)) + "/mcp");
                }
            }
        } catch (SocketException | SecurityException ignored) {
            // Loopback and the explicit endpoint still work if Android withholds interface details.
        }
        return new ArrayList<>(urls);
    }
}
