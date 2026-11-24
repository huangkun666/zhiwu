"""Run after building the server. Uses disposable desktop and offline libraries."""
import json
import re

from playwright.sync_api import expect
from tutor_retrieval import TutorBrowserTest


class McpSettingsTest(TutorBrowserTest):
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
