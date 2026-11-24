"""Exercise the installed APK with an external MCP SDK client and an HTTPS reverse proxy."""
import http.client
import io
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from PIL import Image
from playwright.sync_api import expect, sync_playwright


@unittest.skipUnless(os.environ.get("ANDROID_SERIAL"), "Requires a disposable Android test device")
class PhoneMcpTest(unittest.TestCase):
    def adb(self, *args):
        return subprocess.check_output([os.environ.get("ADB", "adb"), "-s", os.environ["ANDROID_SERIAL"], *args],
                                       text=True, encoding="utf-8", timeout=25).strip()

    def setUp(self):
        self.pw = sync_playwright().start()
        self.addCleanup(self.pw.stop)
        self.extra_env = {}
        self.attach_to_app()

    def attach_to_app(self):
        pid = self.adb("shell", "pidof", "com.zhiwu.learning").split()[0]
        port = self.adb("forward", "tcp:0", "localabstract:webview_devtools_remote_" + pid)
        self.addCleanup(self.adb, "forward", "--remove", "tcp:" + port)
        browser = self.pw.chromium.connect_over_cdp("http://127.0.0.1:" + port, no_defaults=True)
        self.page = next(page for page in browser.contexts[0].pages
                         if page.evaluate("document.visibilityState==='visible' && innerHeight > 0"))
        self.assertEqual(self.page.evaluate("Capacitor.getPlatform()"), "android")
        self.page.set_default_timeout(13000)

    def open_settings(self):
        self.page.get_by_role("button", name="首页", exact=True).click()
        self.page.get_by_role("button", name="设置", exact=True).click()
        panel = self.page.get_by_role("button", name="MCP 配置", exact=True)
        if panel.get_attribute("aria-expanded") != "true":
            panel.click()

    def external(self, url, token, tool=None, **args):
        call = json.dumps(dict(url=url, token=token, tool=tool, args=args), ensure_ascii=False)
        res = subprocess.run(["node", str(Path(__file__).with_name("phone_mcp_client.mjs"))], input=call,
                             text=True, encoding="utf-8", capture_output=True, timeout=35,
                             env={**os.environ, **self.extra_env})
        if res.returncode:
            self.fail(res.stderr.replace(token, "[redacted]")[-800:])
        result = json.loads(res.stdout)
        self.assertFalse(result.get("isError"), result.get("content"))
        return result.get("structuredContent", result)

    def expose_https(self, target):
        folder = tempfile.TemporaryDirectory(prefix="zhiwu-mcp-tls-")
        self.addCleanup(folder.cleanup)
        cert, private = (Path(folder.name) / name for name in ("cert.pem", "key.pem"))
        config = Path(folder.name) / "test.cnf"
        config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n"
                          "[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n", encoding="ascii")
        subprocess.run([os.environ.get("OPENSSL", "openssl"), "req", "-new", "-x509", "-nodes", "-newkey", "rsa:2048",
                        "-config", str(config), "-days", "1",
                        "-keyout", str(private), "-out", str(cert)], check=True, capture_output=True)
        self.extra_env["NODE_EXTRA_CA_CERTS"] = str(cert)
        backend = urlsplit(target)

        class Proxy(BaseHTTPRequestHandler):
            def forward(self):
                if self.path != "/phone/tools/":
                    return self.send_error(404)
                upstream = http.client.HTTPConnection(backend.hostname, backend.port, timeout=25)
                try:
                    data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                    headers = {k: v for k, v in self.headers.items() if k.lower() not in ("connection", "transfer-encoding")}
                    upstream.request(self.command, self.path, body=data, headers=headers)
                    res = upstream.getresponse()
                    self.send_response(res.status)
                    for k, v in res.getheaders():
                        if k.lower() not in ("connection", "transfer-encoding"):
                            self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(res.read())
                finally:
                    upstream.close()

            do_POST = do_GET = do_DELETE = do_OPTIONS = forward

            def log_message(self, *_):
                pass

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        self.addCleanup(proxy.server_close)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, private)
        proxy.socket = tls.wrap_socket(proxy.socket, server_side=True)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        self.addCleanup(proxy.shutdown)
        return f"https://localhost:{proxy.server_port}/phone/tools/"

    def token(self):
        self.page.get_by_role("button", name="显示令牌", exact=True).click()
        value = self.page.get_by_label("Bearer 令牌", exact=True).input_value()
        self.assertTrue(len(value) >= 32)
        self.page.get_by_role("button", name="隐藏令牌", exact=True).click()
        return value

    def verify_device_network(self, token, device_url):
        network_url = os.environ.get("ZHIWU_MCP_NETWORK_URL")
        if network_url:
            self.assertIn("read_zhiwu_note", self.external(network_url, token)["tools"])
            return network_url
        if not os.environ["ANDROID_SERIAL"].startswith("emulator-"):
            return device_url
        addresses = self.page.get_by_label("连接地址", exact=True).locator("option").evaluate_all(
            "options => options.filter(o => o.textContent.startsWith('网络地址')).map(o => o.value)")
        self.assertTrue(addresses, "The emulator must have a network interface")
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            port = available.getsockname()[1]
        self.assertEqual(self.adb("emu", "redir", "add", f"tcp:{port}:{urlsplit(device_url).port}"), "OK")
        self.addCleanup(self.adb, "emu", "redir", "del", f"tcp:{port}")
        message = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "network-test", "version": "1"}}})
        for address in addresses:
            endpoint = urlsplit(address)
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            try:
                conn.request("POST", endpoint.path, body=message, headers={"Host": endpoint.netloc,
                    "Authorization": "Bearer " + token, "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream"})
                response = conn.getresponse()
                if response.status == 200:
                    self.assertEqual(json.loads(response.read())["result"]["serverInfo"]["name"], "zhiwu-phone")
                    print("MCP handshake through the emulator network interface passed.")
                    return f"http://127.0.0.1:{port}{endpoint.path}"
            finally:
                conn.close()
        self.fail("The emulator network destination did not match any advertised address")

    def test_chat_toolbar_touches_android_status_bar(self):
        if os.environ.get("ZHIWU_CHAT_SCREENSHOT"):
            self.page.get_by_role("button", name="首页", exact=True).click()
            self.page.get_by_role("button", name="设置", exact=True).click()
            self.page.get_by_text("冰雾浅灰磨砂", exact=True).click()
        self.page.get_by_role("button", name="助教", exact=True).click()
        toolbar = self.page.get_by_role("button", name="历史对话", exact=True).locator("../..")
        expect(toolbar).to_be_visible()
        self.page.get_by_role("button", name="新建对话", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="新建对话", exact=True)
        dialog.get_by_role("button", name="创建对话", exact=True).click()
        expect(dialog).to_be_hidden()
        self.page.wait_for_function("new URLSearchParams(location.search).get('chat')")
        session = parse_qs(urlsplit(self.page.url).query)["chat"][0]
        # Populate only this test conversation. Its long answer permits the same mid-scroll view as the report.
        items = ["记录使用的画面模式、亮度设定和测试图。",
                 "保存仪器位置、环境光和测量时间。",
                 "将每次测量的原始值和对应页码记在同一份笔记里。"]
        content = "\n\n".join(f"**第 {n} 次测量记录**\n\n" + "\n".join("- " + item for item in items)
                              for n in range(1, 7))
        self.page.evaluate("""async ({session, content}) => {
            const db = await new Promise((resolve, reject) => {
                const open = indexedDB.open('zhiwu_on_device_db');
                open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
            });
            try {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('kv', 'readwrite');
                    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
                    const store = tx.objectStore('kv'), read = store.get('zhiwu_state_v1');
                    read.onsuccess = () => {
                        const state = read.result;
                        if (!state?.tutorSessions.some(s => s.id === session)) { tx.abort(); return; }
                        state.tutorMessages[session].push({ id: crypto.randomUUID(), session_id: session,
                            created_at: new Date().toISOString(), role: 'assistant', content });
                        store.put(state, 'zhiwu_state_v1');
                    };
                });
            } finally { db.close(); }
        }""", {"session": session, "content": content})
        self.page.reload()
        messages = self.page.get_by_role("region", name="对话消息")
        expect(messages.get_by_text("第 6 次测量记录", exact=True)).to_be_attached()
        messages.evaluate("e => { e.scrollTop = (e.scrollHeight - e.clientHeight) / 2; }")
        self.assertGreater(messages.evaluate("e => e.scrollTop"), 0)
        frames = self.adb("shell", "dumpsys", "window", "displays")
        match = re.search(r"type=statusBars frame=\[0,0\]\[\d+,(\d+)\] visible=true", frames)
        self.assertIsNotNone(match, "Expected a visible status bar on the test device")
        status_bottom = int(match[1])
        scale = self.page.evaluate("devicePixelRatio")
        # Mark the exact DOM edge, then measure it in the same physical pixels as Android's frame.
        toolbar.evaluate("""bar => {
            const marker = document.createElement('i');
            marker.id = 'status-bar-geometry-test';
            marker.style.cssText = 'position:fixed;left:8px;width:6px;height:3px;background:#17fb7f;z-index:2147483647;pointer-events:none';
            marker.style.top = bar.getBoundingClientRect().top + 'px';
            document.body.append(marker);
        }""")
        self.addCleanup(self.page.evaluate, "document.getElementById('status-bar-geometry-test')?.remove()")
        self.page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        capture = subprocess.check_output([os.environ.get("ADB", "adb"), "-s", os.environ["ANDROID_SERIAL"],
                                           "exec-out", "screencap", "-p"])
        with Image.open(io.BytesIO(capture)) as shot:
            pixels = shot.convert("RGB")
            rows = [y for y in range(shot.height // 3) if pixels.getpixel((round(10 * scale), y)) == (23, 251, 127)]
        self.assertTrue(rows, "Could not locate the toolbar edge in the physical screenshot")
        self.assertGreaterEqual(rows[0], status_bottom - 1)
        self.assertLessEqual(rows[0] - status_bottom, scale + 1, "Extra space between system bar and toolbar")
        print(f"Android status bar bottom {status_bottom}px, toolbar starts {rows[0]}px, scale {scale}.")
        if os.environ.get("ZHIWU_CHAT_SCREENSHOT"):
            self.page.evaluate("document.getElementById('status-bar-geometry-test').remove()")
            self.page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            screenshot = Path(os.environ["ZHIWU_CHAT_SCREENSHOT"])
            screenshot.parent.mkdir(parents=True, exist_ok=True)
            screenshot.write_bytes(subprocess.check_output([os.environ.get("ADB", "adb"), "-s", os.environ["ANDROID_SERIAL"],
                                                           "exec-out", "screencap", "-p"]))

    def test_external_client_on_phone_and_forwarded_https(self):
        self.open_settings()
        self.page.get_by_role("button", name="开启 MCP", exact=True).click()
        stop = self.page.get_by_role("button", name="关闭 MCP", exact=True)
        expect(stop).to_be_visible()
        self.addCleanup(lambda: self.page.evaluate("Capacitor.Plugins.ZhiwuMcp.stop()"))
        self.page.get_by_label("连接地址", exact=True).select_option(label="本机应用")
        url = self.page.get_by_label("服务器 URL", exact=True).input_value()
        port = urlsplit(url).port
        self.adb("forward", "--no-rebind", f"tcp:{port}", f"tcp:{port}")
        self.addCleanup(self.adb, "forward", "--remove", f"tcp:{port}")
        read_token = self.token()
        self.assertIn("read_zhiwu_note", self.external(url, read_token)["tools"])
        self.assertNotIn("update_zhiwu_note", self.external(url, read_token)["tools"])
        network_target = self.verify_device_network(read_token, url)
        if os.environ.get("ZHIWU_MCP_UPGRADE_NOTE"):
            old = self.external(url, read_token, "search_zhiwu_notes", query=os.environ["ZHIWU_MCP_UPGRADE_NOTE"])["notes"]
            self.assertEqual(len(old), 1)
            stored = self.external(url, read_token, "read_zhiwu_note", noteId=old[0]["id"])
            self.assertIn(os.environ["ZHIWU_MCP_UPGRADE_NOTE"], (stored["sourceContent"] or "") + stored["content"])
        self.page.get_by_label("笔记权限", exact=True).select_option("edit")
        expect(self.page.get_by_text("权限已更新", exact=False)).to_be_visible()
        edit_token = self.token()
        self.assertTrue(edit_token != read_token, "Permission change must revoke the old credential")
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
        try:
            conn.request("POST", "/mcp", body=b"{}", headers={"Authorization": "Bearer " + read_token})
            self.assertEqual(conn.getresponse().status, 401)
        finally:
            conn.close()
        https = self.expose_https(network_target)
        self.page.get_by_text("自定义连接地址", exact=True).click()
        self.page.get_by_label("完整 MCP 网址", exact=True).fill(https)
        origin = "https://ai.example.test"
        self.page.get_by_label("网页客户端来源", exact=True).fill(origin)
        self.page.get_by_role("button", name="保存地址", exact=True).click()
        expect(self.page.get_by_label("服务器 URL", exact=True)).to_have_value(https)
        endpoint = urlsplit(https)
        tls = ssl.create_default_context(cafile=self.extra_env["NODE_EXTRA_CA_CERTS"])
        for website, status in [(origin, 204), ("https://unused.example.test", 403)]:
            browser_request = http.client.HTTPSConnection(endpoint.hostname, endpoint.port, context=tls, timeout=5)
            try:
                browser_request.request("OPTIONS", endpoint.path, headers={"Origin": website,
                    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
                res = browser_request.getresponse()
                self.assertEqual(res.status, status)
                self.assertEqual(res.getheader("Access-Control-Allow-Origin"), website if status == 204 else None)
            finally:
                browser_request.close()

        # Leave the app, as the user would when switching to an external AI client.
        self.adb("shell", "input", "keyevent", "KEYCODE_HOME")
        note_id = str(uuid.uuid4())
        title = "MCP device test " + note_id[:8]
        created = self.external(https, edit_token, "save_to_zhiwu", title=title, content="First draft",
                                requestId=note_id)
        row = self.external(url, edit_token, "read_zhiwu_note", noteId=created["id"])
        self.assertEqual(row["editableContent"], "First draft")
        self.external(https, edit_token, "update_zhiwu_note", noteId=row["id"],
                      expectedUpdatedAt=row["updatedAt"], content="Saved on this phone")
        self.external(https, edit_token, "append_to_zhiwu_note", noteId=row["id"], content="Remember this",
                      excerptId="mobile-test")
        reread = self.external(https, edit_token, "read_zhiwu_note", noteId=row["id"])
        self.assertEqual(reread["editableContent"], "Saved on this phone")
        self.assertEqual(reread["chatExcerpts"][0]["content"], "Remember this")
        self.adb("shell", "am", "start", "-n", "com.zhiwu.learning/.MainActivity")
        self.page.get_by_role("button", name="笔记", exact=True).click()
        self.page.get_by_text(title, exact=True).first.click()
        rendered = self.page.locator(".zhiwu-prose")
        expect(rendered.get_by_text("Saved on this phone", exact=True)).to_be_visible()
        expect(self.page.get_by_role("region", name="聊天追加").get_by_text("Remember this", exact=True)).to_be_visible()
        self.external(https, edit_token, "update_zhiwu_note", noteId=row["id"],
                      expectedUpdatedAt=reread["updatedAt"], content="Updated while open")
        expect(rendered.get_by_text("Updated while open", exact=True)).to_be_visible()
        self.open_settings()
        stop.click()
        expect(self.page.get_by_role("button", name="开启 MCP", exact=True)).to_be_visible()
        with self.assertRaises((OSError, http.client.HTTPException)):
            closed = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            try:
                closed.request("POST", "/mcp", body=b"{}", headers={"Authorization": "Bearer " + edit_token})
                closed.getresponse()
            finally:
                closed.close()

    def test_reopens_previously_enabled_connection(self):
        self.open_settings()
        self.page.get_by_role("button", name="开启 MCP", exact=True).click()
        expect(self.page.get_by_role("button", name="关闭 MCP", exact=True)).to_be_visible()
        self.addCleanup(lambda: self.page.evaluate("Capacitor.Plugins.ZhiwuMcp.stop()"))
        self.page.get_by_label("连接地址", exact=True).select_option(label="本机应用")
        url = self.page.get_by_label("服务器 URL", exact=True).input_value()
        port = urlsplit(url).port
        self.adb("forward", "--no-rebind", f"tcp:{port}", f"tcp:{port}")
        self.addCleanup(self.adb, "forward", "--remove", f"tcp:{port}")
        token = self.token()
        self.adb("shell", "am", "force-stop", "com.zhiwu.learning")
        self.adb("shell", "am", "start", "-W", "-n", "com.zhiwu.learning/.MainActivity")
        self.attach_to_app()
        self.open_settings()
        expect(self.page.get_by_role("button", name="关闭 MCP", exact=True)).to_be_visible()
        self.assertTrue(self.token() == token, "Reopening the app must preserve an active grant")
        self.assertIn("read_zhiwu_note", self.external(url, token)["tools"])
        self.page.get_by_role("button", name="关闭 MCP", exact=True).click()
        expect(self.page.get_by_role("button", name="开启 MCP", exact=True)).to_be_visible()


if __name__ == "__main__":
    unittest.main()
