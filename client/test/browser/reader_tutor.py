"""Run against a standalone Vite dev server in a fresh Chromium context."""
import base64
import json
import os
import unittest

from playwright.sync_api import expect, sync_playwright


class ReaderTutorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH") or cls.playwright.chromium.executable_path,
        )
        page = cls.browser.new_page()
        page.set_content("".join(
            f'<section style="break-after:page">Page {n}. ' +
            ("Contrast ratio: use fixture PQ-81." if n == 81 else "General specifications.") + "</section>"
            for n in range(1, 82)
        ))
        cls.pdf = base64.b64encode(page.pdf()).decode()
        page.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                                service_workers="block")
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.goto(os.environ.get("ZHIWU_TEST_ORIGIN", "http://127.0.0.1:5173"))
        expect(self.page.get_by_role("button", name="助教", exact=True)).to_be_visible()
        self.page.evaluate("""async () => {
            const {api, IS_STANDALONE_MODE} = await import('/src/api/client.ts');
            if (!IS_STANDALONE_MODE) throw Error('Start Vite with VITE_STANDALONE=true');
            window.testApi = api;
        }""")

    def import_pdf(self):
        return self.page.evaluate("""async (encoded) => {
            const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
            const result = await testApi.importFiles([new File([bytes], 'reader.pdf', {type:'application/pdf'})]);
            return result.imported[0].id;
        }""", self.pdf)

    def configure_model(self, reply):
        self.page.route("**/chat/completions", lambda route: route.fulfill(
            json={"choices": [{"message": {"content": reply}}]}))
        self.page.evaluate("""async () => {
            const settings = await testApi.getSettings();
            settings.providers.find(p => p.id === 'local').baseUrl = location.origin + '/mock';
            await testApi.saveSettings({...settings, activeProviderId:'local'});
        }""")

    def test_late_pdf_page_in_offline_chat(self):
        note_id = self.import_pdf()
        self.configure_model("ok")
        with self.page.expect_request(lambda req: req.url.endswith("/chat/completions") and
                                      not req.post_data_json["messages"][0]["content"].startswith("ZHIWU_")) as request:
            self.page.evaluate("""async (id) => {
                const session = await testApi.createTutorSession({mode:'qa',noteIds:[id]});
                await testApi.sendTutorMessageStream(session.id, {message:'contrast ratio?'}, () => {});
            }""", note_id)
        self.assertIn("PQ-81", request.value.post_data_json["messages"][0]["content"])

    def test_page_turn_preserves_reader(self):
        note_id = self.import_pdf()
        self.page.goto(f"{self.page.url.split('?')[0]}?note={note_id}")
        self.page.get_by_text("查看原文", exact=True).click()
        canvas = self.page.get_by_role("img", name="PDF 第 1 页", exact=True)
        expect(canvas).to_be_visible()
        self.page.get_by_role("button", name="放大", exact=True).click()
        self.page.get_by_role("button", name="下一页").scroll_into_view_if_needed()
        position = canvas.evaluate("""c => {
            window.scrollTo(0, Math.max(0, c.getBoundingClientRect().top + scrollY - 200));
            c.parentElement.scrollTo(45, 130);
            return [scrollY, c.parentElement.scrollLeft, c.parentElement.scrollTop];
        }""")
        for offset in position:
            self.assertGreater(offset, 0)
        for button, number in [("下一页", 2), ("上一页", 1)]:
            self.page.get_by_role("button", name=button).click()
            canvas = self.page.get_by_role("img", name=f"PDF 第 {number} 页", exact=True)
            expect(canvas).to_be_visible()
            after = canvas.evaluate("c => [scrollY, c.parentElement.scrollLeft, c.parentElement.scrollTop]")
            for before, current in zip(position, after):
                self.assertAlmostEqual(before, current, delta=2)

    def test_scanned_page_read_sends_the_requested_page_image(self):
        sheet = self.context.new_page()
        sheet.set_content('<style>@page {size:100mm 100mm;margin:0}body {margin:0} '
                          'section {width:80mm;height:80mm} section + section {break-before:page}</style>'
                          '<section style="background:cyan"></section><section style="background:magenta"></section>')
        encoded = base64.b64encode(sheet.pdf(print_background=True, prefer_css_page_size=True)).decode()
        sheet.close()
        images, evidence = [], []

        def model(route):
            messages = route.request.post_data_json['messages']
            prompt = messages[0]['content']
            if isinstance(prompt, list):
                images.append(prompt[1]['image_url']['url'])
                answer = json.dumps({'text': 'Observed value MAG-17'})
            elif prompt.startswith('ZHIWU_RETRIEVE'):
                action = {'action': 'finish'} if images else {'action': 'read', 'source': 'N1', 'page': 2}
                answer = json.dumps(action)
            else:
                evidence.append(prompt)
                answer = 'MAG-17 [S1]'
            route.fulfill(json={'choices': [{'message': {'content': answer}}]})

        self.page.route("**/chat/completions", model)
        final = self.page.evaluate("""async encoded => {
            const settings = await testApi.getSettings();
            const provider = settings.providers.find(p => p.id === 'local');
            provider.baseUrl = location.origin + '/mock'; provider.supportsVision = true;
            await testApi.saveSettings({...settings, activeProviderId: 'local'});
            const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
            const {imported:[note]} = await testApi.importFiles([new File([bytes], 'scan.pdf', {type:'application/pdf'})]);
            const chat = await testApi.createTutorSession({mode:'qa', noteIds:[note.id]});
            const result = await testApi.sendTutorMessage(chat.id, {message:'读取扫描件的第 2 页。'});
            return {note: await testApi.getNote(note.id), reply: result.assistantMessage.content};
        }""", encoded)
        self.assertEqual([p['status'] for p in final['note']['source_pages']], ['empty', 'empty'])
        self.assertEqual(final['note']['source_content'], '')
        self.assertEqual(len(images), 1)
        self.assertTrue(any('Observed value MAG-17' in context for context in evidence))
        self.assertIn('page=2', final['reply'])
        pixel = self.page.evaluate("""async url => {
            const img = new Image(); img.src = url; await img.decode();
            const c = document.createElement('canvas'); c.width = c.height = 1;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, img.width / 2, img.height / 2, 1, 1, 0, 0, 1, 1);
            return Array.from(ctx.getImageData(0,0,1,1).data);
        }""", images[0])
        self.assertEqual(pixel, [255, 0, 255, 255])

    def test_chat_toolbar_uses_the_system_top_inset_once(self):
        for native in (False, True):
            with self.subTest(android_app=native):
                context = self.browser.new_context(viewport={"width": 360, "height": 764}, is_mobile=True, has_touch=True,
                                                   service_workers="block")
                self.addCleanup(context.close)
                if native:
                    # MainActivity has already placed the WebView below the system status bar.
                    context.add_init_script("window.androidBridge = {}")
                page = context.new_page()
                cdp = context.new_cdp_session(page)
                cdp.send("Emulation.setSafeAreaInsetsOverride", {"insets": {"top": 36}})
                page.goto(os.environ.get("ZHIWU_TEST_ORIGIN", "http://127.0.0.1:5173"))
                page.get_by_role("button", name="助教", exact=True).click()
                history = page.get_by_role("button", name="历史对话", exact=True)
                expect(history).to_be_visible()
                toolbar = history.locator("../..")
                self.assertAlmostEqual(toolbar.bounding_box()["y"], 0 if native else 36, delta=1)
                page.set_viewport_size({"width": 844, "height": 390})
                self.assertAlmostEqual(toolbar.bounding_box()["y"], 0 if native else 36, delta=1)

    def test_mobile_chat_content_starts_below_toolbar(self):
        self.page.get_by_role("button", name="助教", exact=True).click()
        messages = self.page.get_by_role("region", name="对话消息")
        welcome = messages.get_by_role("heading")
        new_chat = self.page.get_by_role("button", name="新建对话", exact=True)

        def check_position(content, max_gap, state):
            expect(content).to_be_visible()
            for width, height in [(320, 568), (390, 844), (844, 390)]:
                with self.subTest(state=state, width=width):
                    self.page.set_viewport_size({"width": width, "height": height})
                    panel_top = messages.bounding_box()["y"]
                    button = new_chat.bounding_box()
                    self.assertLessEqual(button["y"], 40 if width >= 768 else 16)
                    self.assertLessEqual(panel_top - (button["y"] + button["height"]), 16)
                    gap = content.bounding_box()["y"] - panel_top
                    self.assertGreaterEqual(gap, 0)
                    self.assertLessEqual(gap, max_gap)

        check_position(welcome, 64, "empty library")
        new_chat.click()
        dialog = self.page.get_by_role("dialog", name="新建对话", exact=True)
        dialog.get_by_role("button", name="创建对话", exact=True).click()
        expect(dialog).to_be_hidden()
        check_position(welcome, 64, "new general chat")

        self.configure_model("布局测试回答")
        self.page.locator("textarea").fill("布局测试问题")
        self.page.get_by_role("button", name="发送消息").click()
        expect(messages.get_by_text("布局测试回答", exact=True)).to_be_visible()
        self.page.reload()
        question = messages.get_by_text("布局测试问题", exact=True)
        check_position(question, 32, "saved chat")

    def test_mobile_chat_space(self):
        self.page.get_by_role("button", name="助教", exact=True).click()
        self.page.get_by_role("button", name="新建对话", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="新建对话", exact=True)
        dialog.get_by_role("radio", name="深度答疑", exact=True).check()
        dialog.get_by_role("button", name="创建对话", exact=True).click()
        for width, height in [(390, 844), (320, 568)]:
            self.page.set_viewport_size({"width": width, "height": height})
            box = self.page.locator("textarea")
            expect(box).to_be_visible()
            rect = box.bounding_box()
            nav = self.page.get_by_role("button", name="助教", exact=True).bounding_box()
            self.assertLessEqual(rect["y"] + rect["height"], nav["y"])
            messages = self.page.get_by_role("region", name="对话消息")
            self.assertGreaterEqual(messages.bounding_box()["width"], width - 4)
            self.assertGreaterEqual(messages.bounding_box()["height"], height * 0.58)
            self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
        self.page.get_by_role("button", name="参考笔记").click()
        expect(self.page.get_by_text("笔记库暂无可参考的笔记。")).to_be_visible()
        self.page.get_by_role("button", name="参考笔记").click()
        self.configure_model("阅读段落。 " * 500 + "回答结束。")
        box.fill("解释这份笔记")
        self.page.get_by_role("button", name="发送消息").click()
        expect(messages.get_by_role("button", name="存为闪卡")).to_be_visible()
        self.assertGreater(messages.evaluate("e => e.scrollHeight"), messages.bounding_box()["height"])
        self.assertEqual(self.page.evaluate("window.scrollY"), 0)
        box.focus()
        self.page.evaluate("""() => {
            Object.defineProperty(visualViewport, 'height', {configurable:true, value:300});
            visualViewport.dispatchEvent(new Event('resize'));
        }""")
        expect(self.page.get_by_role("button", name="助教", exact=True)).to_be_hidden()
        self.assertLessEqual(box.bounding_box()["y"] + box.bounding_box()["height"], 300)


if __name__ == "__main__":
    unittest.main()
