"""Verify imported knowledge in disposable desktop and Android offline browser libraries."""
import json
import re
import unittest

from playwright.sync_api import expect
from tutor_retrieval import TutorBrowserTest


CLAUSE = "Below 10 C, preheat for 30 minutes before measuring."
TITLE = "低温测量准备"
ALIAS = "通电啥时候能测"


class KnowledgeModel:
    def __init__(self):
        self.errors = []

    def extract(self, body):
        blocks = json.loads(body["messages"][1]["content"])["blocks"]
        return json.dumps(dict(points=[
            dict(title=TITLE, aliases=[ALIAS], answer="预热 30 分钟后开始测量。",
                 conditions="环境温度低于 10°C。", sources=[block["id"]])
            for block in blocks if CLAUSE in block["text"]
        ]))

    def respond(self, body):
        system = body["messages"][0]["content"]
        if system.startswith("ZHIWU_RETRIEVE"):
            return '{"action":"finish"}'
        found = re.search(r"(?m)^\[(S\d+)\][^\n]*\n[^\n]*" + re.escape(CLAUSE), system)
        assert found, "the model should receive the original clause in its numbered evidence"
        return "环境温度低于 10°C 时，预热 30 分钟。 [" + found[1] + "]"


class KnowledgeImportBrowserTest(TutorBrowserTest):
    def run_import(self, mode, viewport):
        model = KnowledgeModel()
        self.model.witness = model
        self.model.extract_knowledge = model.extract
        with self.browser.new_context(viewport=viewport, service_workers="block", is_mobile=mode == "standalone") as context:
            document = context.new_page()
            sections = [
                f"<section><p>{'Instrument setup sheet ' + str(page) if page < 100 else CLAUSE}</p></section>"
                for page in range(1, 101)
            ]
            document.set_content("<style>section + section{break-before:page}</style>" + "".join(sections))
            pdf = document.pdf()
            document.close()
            page = context.new_page()
            page.set_default_timeout(30000)
            page.goto(self.origins[mode])
            page.evaluate("""async (baseUrl) => {
                const { api } = await import('/src/api/client.ts');
                const settings = await api.getSettings();
                settings.providers.find(p => p.id === 'local').baseUrl = baseUrl;
                await api.saveSettings({...settings, activeProviderId: 'local'});
            }""", self.model_origin)
            page.get_by_role("button", name=re.compile(r"^导入(笔记)?$")).first.click()
            page.locator('input[type="file"]').first.set_input_files(
                {"name": "验收手册.pdf", "mimeType": "application/pdf", "buffer": pdf})
            page.get_by_role("button", name="确认导入").click()
            panel = page.get_by_role("region", name="知识点")
            expect(panel.get_by_text(TITLE, exact=True)).to_be_visible(timeout=60000)
            if mode == "desktop":
                page.keyboard.press("Control+k")
            else:
                page.get_by_role("button", name="搜索", exact=True).click()
            dialog = page.get_by_role("dialog", name="全局搜索")
            dialog.get_by_role("textbox").fill(ALIAS)
            expect(dialog.get_by_text("环境温度低于 10°C。", exact=False)).to_be_visible()
            dialog.get_by_role("link", name=re.compile("PDF 第 100 页")).click()
            expect(page.get_by_role("img", name="PDF 第 100 页", exact=True)).to_be_visible(timeout=30000)

            page.get_by_role("button", name="助教", exact=True).click()
            page.locator("textarea").fill("查我的笔记，" + ALIAS)
            page.get_by_role("button", name="发送消息").click()
            messages = page.get_by_role("region", name="对话消息")
            expect(messages.get_by_text("预热 30 分钟", exact=False)).to_be_visible(timeout=30000)
            messages.get_by_role("link", name=re.compile("PDF 第 100 页")).click()
            expect(page.get_by_role("img", name="PDF 第 100 页", exact=True)).to_be_visible(timeout=30000)
            self.assertEqual(model.errors, [])

    def test_desktop_sqlite(self):
        self.run_import("desktop", {"width": 1440, "height": 960})

    def test_standalone_indexeddb(self):
        self.run_import("standalone", {"width": 390, "height": 844})


if __name__ == "__main__":
    unittest.main()
