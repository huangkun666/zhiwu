"""Run after building the server. Uses disposable desktop and offline libraries."""
import json
import re

from playwright.sync_api import expect
from tutor_retrieval import TutorBrowserTest


class McpSettingsTest(TutorBrowserTest):
    def phone_panel(self, *, available=True, lan_urls=(), fail_state=False):
        ctx = self.browser.new_context(viewport={"width": 390, "height": 820},
                                       permissions=["clipboard-read", "clipboard-write"])
        self.addCleanup(ctx.close)
        options = json.dumps(dict(available=available, lanUrls=lan_urls, failState=fail_state))
        ctx.add_init_script("""(options => {
            window.androidBridge = {};
            const state = {running: false, access: 'read', localUrl: 'http://127.0.0.1:34652/mcp', lanUrls: []};
            const fixture = window.mcpFixture = {state, changes: [], failNext: '', failState: options.failState};
            const listeners = new Map();
            fixture.notify = () => {
                for (const {eventName, callback} of listeners.values()) {
                    if (eventName === 'mcpStateChanged') callback({...state});
                }
            };
            window.Capacitor = {
                PluginHeaders: options.available ? [{name: 'ZhiwuMcp', methods: [
                    ...['getState', 'start', 'stop', 'removeListener'].map(name => ({name, rtype: 'promise'})),
                    {name: 'addListener', rtype: 'callback'}
                ]}] : [],
                nativeCallback: (_plugin, _method, {eventName}, callback) => {
                    const id = crypto.randomUUID();
                    listeners.set(id, {eventName, callback});
                    return id;
                },
                nativePromise: async (plugin, method, args) => {
                    if (plugin !== 'ZhiwuMcp') throw new Error('unexpected plugin ' + plugin);
                    if ((method === 'getState' && fixture.failState) || fixture.failNext === method) {
                        fixture.failNext = '';
                        throw new Error('测试设备暂时忙碌');
                    }
                    if (method === 'start') {
                        fixture.changes.push({method, ...args});
                        if (!state.running || state.access !== args.access) state.token = crypto.randomUUID();
                        Object.assign(state, {running: true, access: args.access, publicUrl: args.publicUrl || undefined,
                            clientOrigin: args.clientOrigin || undefined, lanUrls: options.lanUrls});
                    } else if (method === 'stop') {
                        fixture.changes.push({method});
                        Object.assign(state, {running: false, token: undefined, publicUrl: undefined,
                            clientOrigin: undefined, access: 'read', lanUrls: []});
                    } else if (method === 'removeListener') listeners.delete(args.callbackId);
                    return {...state};
                }
            };
        })(""" + options + ")")
        page = ctx.new_page()
        page.goto(self.origins["standalone"])
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("button", name="MCP 配置", exact=True).click()
        return page

    def test_phone_connection_and_permissions(self):
        lan = "http://192.0.2.7:34652/mcp"
        vpn = "http://100.64.0.9:34652/mcp"
        page = self.phone_panel(lan_urls=[lan, vpn])
        open_button = page.get_by_role("button", name="开启 MCP", exact=True)
        expect(open_button).to_be_visible()
        expect(page.get_by_label("适配器脚本路径")).to_have_count(0)
        expect(page.get_by_label("服务器 URL")).to_have_count(0)
        self.assertEqual(page.evaluate("mcpFixture.changes"), [])
        permission = page.get_by_label("笔记权限", exact=True)
        expect(permission).to_have_value("read")
        open_button.click()
        url = page.get_by_label("服务器 URL")
        expect(url).to_have_value("http://127.0.0.1:34652/mcp")
        address = page.get_by_label("连接地址", exact=True)
        for target in [lan, vpn]:
            address.select_option(target)
            expect(url).to_have_value(target)
        page.get_by_role("button", name="复制网址").click()
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), vpn)

        token = page.evaluate("mcpFixture.state.token")
        credential = page.get_by_label("Bearer 令牌", exact=True)
        self.assertNotIn(token, page.locator("body").inner_html())
        page.get_by_role("button", name="显示令牌").click()
        expect(credential).to_have_value(token)
        page.get_by_role("button", name="复制令牌").click()
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), token)

        page.evaluate("mcpFixture.failNext = 'start'")
        permission.select_option("edit")
        expect(page.get_by_role("alert")).to_contain_text("测试设备暂时忙碌")
        expect(permission).to_have_value("read")
        permission.select_option("edit")
        expect(permission).to_have_value("edit")
        self.assertEqual(page.evaluate("mcpFixture.state.access"), "edit")
        new_token = page.evaluate("mcpFixture.state.token")
        self.assertNotEqual(token, new_token)
        self.assertNotIn(new_token, page.locator("body").inner_html())
        page.get_by_role("button", name="复制 JSON 配置").click()
        result = json.loads(page.evaluate("navigator.clipboard.readText()"))["mcpServers"]["zhiwu"]
        self.assertEqual(result, {"type": "http", "url": vpn, "headers": {"Authorization": "Bearer " + new_token}})

        page.get_by_role("button", name="关闭 MCP").click()
        expect(open_button).to_be_visible()
        expect(credential).to_have_count(0)
        expect(page.get_by_role("button", name="复制网址")).to_have_count(0)
        self.assertFalse(page.evaluate("mcpFixture.state.running"))

    def test_phone_custom_endpoint_and_refresh(self):
        page = self.phone_panel()
        page.get_by_role("button", name="开启 MCP", exact=True).click()
        expect(page.get_by_text("当前未检测到其他网络地址。", exact=False)).to_be_visible()
        page.get_by_text("自定义连接地址", exact=True).click()
        public = page.get_by_label("完整 MCP 网址")
        public.fill("https://notes.example.test/api/mcp?token=unsafe")
        save = page.get_by_role("button", name="保存地址")
        expect(save).to_be_disabled()
        private = "http://zhiwu.internal:8080/ai/tools"
        public.fill(private)
        expect(save).to_be_enabled()
        save.click()
        url = page.get_by_label("服务器 URL")
        expect(url).to_have_value(private)
        public.fill("https://笔记.example.test:443/api/mcp/")
        target = "https://" + "笔记".encode("idna").decode() + ".example.test/api/mcp/"
        save.click()
        expect(url).to_have_value(target)
        self.assertEqual(page.evaluate("mcpFixture.state.publicUrl"), target)
        panel = page.get_by_role("button", name="MCP 配置", exact=True)
        panel.click()
        panel.click()
        expect(url).to_have_value(target)
        page.get_by_role("button", name="复制网址").click()
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), target)
        page.evaluate("""() => {
            Object.assign(mcpFixture.state, {running: false, token: undefined});
            window.dispatchEvent(new Event('focus'));
        }""")
        expect(page.get_by_role("button", name="开启 MCP", exact=True)).to_be_visible()
        expect(url).to_have_count(0)

    def test_optional_trusted_web_origin(self):
        page = self.phone_panel()
        page.get_by_role("button", name="开启 MCP", exact=True).click()
        page.get_by_text("自定义连接地址", exact=True).click()
        source = page.get_by_label("网页客户端来源", exact=True)
        expect(source).to_have_value("")
        save = page.get_by_role("button", name="保存地址")
        for invalid in ["https://ai.example.test/chat", "https://*.example.test", "https://user@ai.example.test"]:
            source.fill(invalid)
            expect(save).to_be_disabled()
        origin = "https://" + "工具".encode("idna").decode() + ".example.test:8443"
        source.fill("https://工具.example.test:8443/")
        save.click()
        expect(source).to_have_value(origin)
        expect(page.get_by_label("服务器 URL")).to_have_value("http://127.0.0.1:34652/mcp")

        page.get_by_label("笔记权限", exact=True).select_option("edit")
        expect(page.get_by_label("笔记权限", exact=True)).to_have_value("edit")
        self.assertEqual(page.evaluate("mcpFixture.state.clientOrigin"), origin)
        public = "https://notes.example.test/tools"
        page.get_by_label("完整 MCP 网址").fill(public)
        save.click()
        expect(page.get_by_label("服务器 URL")).to_have_value(public)
        self.assertEqual(page.evaluate("mcpFixture.state.clientOrigin"), origin)
        source.fill("")
        save.click()
        expect(save).to_be_disabled()
        self.assertFalse(page.evaluate("mcpFixture.state.clientOrigin"))
        self.assertEqual(page.evaluate("mcpFixture.state.publicUrl"), public)

    def test_phone_cannot_read_state(self):
        page = self.phone_panel(fail_state=True)
        expect(page.get_by_role("alert")).to_contain_text("测试设备暂时忙碌")
        expect(page.get_by_role("button", name="开启 MCP", exact=True)).to_have_count(0)
        page.evaluate("mcpFixture.failState = false")
        page.get_by_role("button", name="重新读取状态").click()
        expect(page.get_by_role("button", name="开启 MCP", exact=True)).to_be_visible()
        self.assertEqual(page.evaluate("mcpFixture.changes"), [])

    def test_restored_phone_service_after_panel_open(self):
        page = self.phone_panel()
        expect(page.get_by_role("button", name="开启 MCP", exact=True)).to_be_visible()
        page.evaluate("""() => {
            Object.assign(mcpFixture.state, {running: true, access: 'edit', token: crypto.randomUUID()});
            mcpFixture.notify();
        }""")
        expect(page.get_by_role("button", name="关闭 MCP")).to_be_visible()
        expect(page.get_by_label("笔记权限", exact=True)).to_have_value("edit")
        self.assertEqual(page.evaluate("mcpFixture.changes"), [])

    def test_webview_clipboard_fallback(self):
        page = self.phone_panel()
        page.get_by_role("button", name="开启 MCP", exact=True).click()
        page.evaluate("() => { navigator.clipboard.writeText = async () => { throw Error('clipboard unavailable'); }; }")
        page.get_by_role("button", name="复制令牌").click()
        expect(page.get_by_role("status")).to_contain_text("已复制 Bearer 令牌")
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), page.evaluate("mcpFixture.state.token"))
        self.assertNotIn(page.evaluate("mcpFixture.state.token"), page.locator("body").inner_html())

    def test_older_android_requires_new_apk(self):
        page = self.phone_panel(available=False)
        expect(page.get_by_text(re.compile("安装新版.*APK"))).to_be_visible()
        expect(page.get_by_role("link", name="下载新版 APK")).to_have_attribute(
            "href", "https://github.com/huangkun666/zhiwu/releases/download/latest-ota/zhiwu-android.apk")
        expect(page.get_by_label("适配器脚本路径")).to_have_count(0)
        expect(page.get_by_role("button", name="开启 MCP", exact=True)).to_have_count(0)

    def exercise(self, platform):
        ctx = self.browser.new_context(viewport={"width": 390 if platform == "standalone" else 1280, "height": 820},
                                       permissions=["clipboard-read", "clipboard-write"])
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        page.goto(self.origins[platform])
        page.get_by_role("button", name="设置", exact=True).click()
        panel = page.get_by_role("button", name="MCP 配置", exact=True)
        expect(panel).to_be_visible()
        panel.click()
        path = page.get_by_label("适配器脚本路径")
        url = page.get_by_label("桌面知悟服务地址")
        access = page.get_by_label("笔记权限")
        config = page.get_by_label("MCP JSON 配置")
        if platform == "desktop":
            expect(url).to_have_value(self.origins[platform])
            expect(path).to_have_value(re.compile(r'server[/\\]mcp\.mjs$'))
        else:
            expect(url).to_have_value("")
            expect(page.get_by_text(re.compile("安卓 APK.*手机笔记"))).to_be_visible()
            expect(page.get_by_role("button", name="复制配置")).to_be_disabled()
        path.fill(r"C:\Learning\知悟\server\mcp.mjs")
        url.fill("https://notes.example.test/zhiwu")
        access.select_option("edit")
        result = json.loads(config.input_value())["mcpServers"]["zhiwu"]
        self.assertEqual(result, {"command": "node", "args": [r"C:\Learning\知悟\server\mcp.mjs"],
                                 "env": {"ZHIWU_URL": "https://notes.example.test/zhiwu", "ZHIWU_ALLOW_READ": "1", "ZHIWU_ALLOW_EDIT": "1"}})
        page.get_by_role("button", name="复制配置").click()
        self.assertEqual(json.loads(page.evaluate("navigator.clipboard.readText()"))["mcpServers"]["zhiwu"], result)
        access.select_option("read")
        self.assertNotIn("ZHIWU_ALLOW_EDIT", json.loads(config.input_value())["mcpServers"]["zhiwu"]["env"])
        access.select_option("create")
        self.assertNotIn("ZHIWU_ALLOW_READ", json.loads(config.input_value())["mcpServers"]["zhiwu"]["env"])

    def test_desktop(self):
        self.exercise("desktop")

    def test_offline(self):
        self.exercise("standalone")


if __name__ == "__main__":
    import unittest
    unittest.main()
