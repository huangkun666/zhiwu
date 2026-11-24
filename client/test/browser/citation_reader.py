"""Run against a standalone Vite server. Each test uses a temporary IndexedDB."""
import base64
import os
import unittest

from playwright.sync_api import expect, sync_playwright


class CitationReaderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH") or playwright.chromium.executable_path)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
        self.addCleanup(context.close)
        self.page = context.new_page()
        self.origin = os.environ.get("ZHIWU_TEST_ORIGIN", "http://127.0.0.1:5173")
        self.page.goto(self.origin)
        self.data = self.page.evaluate(r"""async () => {
          const {api, IS_STANDALONE_MODE} = await import('/src/api/client.ts');
          if (!IS_STANDALONE_MODE) throw Error('Use an empty standalone library');
          const filler = Array.from({length:140}, (_, i) => 'Section ' + i + '. ' + 'Context. '.repeat(12)).join('\n\n');
          const sample = 'Repeatable **wording** and punctuation.';
          const note = await api.createNote({title:'Reader fixture', content: sample + '\n\n' + filler + '\n\n' + sample});
          const file = new File([filler + '\n\nEnd of file.'], 'long.txt', {type:'text/plain'});
          const source = (await api.importFiles([file])).imported[0];
          const old = await api.createTutorSession({mode:'qa', title:'Older conversation', noteIds:[note.id]});
          const latest = await api.createTutorSession({mode:'qa', title:'Latest conversation'});
          const backup = JSON.parse(await api.exportJsonBackup());
          const excerpt = {id:'saved-excerpt', content:filler + '\n\nEnd of excerpt.', created_at:new Date().toISOString()};
          const stored = backup.notes.find(item => item.id === note.id);
          stored.chat_excerpts = [excerpt];
          stored.updated_at = new Date(Date.now() + 1000).toISOString();
          // Frozen fixture links exercise the format stored in earlier conversations.
          const body = '?note=' + note.id + '&part=body&at=142&sig=1a-y58d7d';
          const original = '?note=' + source.id + '&part=source&at=141&sig=l-1ic8acm';
          const chat = '?note=' + note.id + '&part=excerpt&at=141&sig=12-1n6cxcu';
          backup.tutorMessages[old.id].push({id:'cited-message', session_id:old.id, role:'assistant',
            content:'[重复的段落](' + body + ')', created_at:new Date().toISOString()});
          await api.importJsonBackup(JSON.stringify(backup));
          return {body, original, chat, noteId:note.id, sessionId:old.id, latestId:latest.id};
        }""")

    def test_return_to_older_chat_after_reload(self):
        page = self.page
        page.goto(self.origin + '?chat=' + self.data["sessionId"])
        link = page.get_by_role("link", name="重复的段落")
        link.click()
        mark = page.locator("mark[data-source-target]").filter(has_text="wording")
        expect(mark).to_be_in_viewport()
        self.assertGreater(page.evaluate("scrollY"), 1000)
        page.reload()
        expect(mark).to_be_in_viewport()
        page.get_by_role("button", name="返回对话").click()
        expect(link).to_be_visible()
        link.click()
        page.go_back()
        expect(link).to_be_visible()

    def test_switching_chat_during_retrieval(self):
        page = self.page
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(self.origin + '?chat=' + self.data["sessionId"])
        expect(page.get_by_role("link", name="重复的段落")).to_be_visible()
        page.evaluate("""async () => {
          const {api} = await import('/src/api/client.ts');
          api.sendTutorMessageStream = (_id, _payload, delta, status) => new Promise((_resolve, reject) => {
            window.finishOldSearch = () => {
              status('旧会话的检索进度'); delta('旧会话的正文'); reject(Error('旧会话的错误'));
            };
          });
        }""")
        page.locator("textarea").fill("检索旧会话的参考资料")
        page.get_by_role("button", name="发送消息").click()
        page.wait_for_function("typeof window.finishOldSearch === 'function'")
        page.get_by_text("Latest conversation", exact=True).click()
        expect(page.get_by_role("link", name="重复的段落")).to_have_count(0)
        page.evaluate("window.finishOldSearch()")
        expect(page.get_by_text("旧会话的错误", exact=False)).to_have_count(0)
        expect(page.get_by_text("旧会话的正文", exact=False)).to_have_count(0)
        page.locator("textarea").fill("新会话的问题")
        expect(page.get_by_role("button", name="发送消息")).to_be_enabled()
        self.assertEqual(page.evaluate("new URL(location.href).searchParams.get('chat')"), self.data["latestId"])
        page.reload()
        expect(page.get_by_role("button", name="Latest conversation", exact=True)).to_be_visible()
        expect(page.get_by_role("link", name="重复的段落")).to_have_count(0)

    def test_file_and_excerpt_positions(self):
        for name, phrase in [("original", "End of file."), ("chat", "End of excerpt.")]:
            with self.subTest(name=name):
                self.page.goto(self.origin + self.data[name])
                mark = self.page.locator("mark[data-source-target]")
                expect(mark).to_have_text(phrase)
                expect(mark).to_be_in_viewport()

    def test_image_only_pdf_opens_at_cited_page(self):
        sheet = self.page.context.new_page()
        sheet.set_content('<div style="height:80px;background:blue"></div>'
                          '<div style="break-before:page;height:80px;background:red"></div>')
        pdf = base64.b64encode(sheet.pdf(print_background=True)).decode()
        sheet.close()
        href = self.page.evaluate("""async encoded => {
          const {api} = await import('/src/api/client.ts');
          const module = performance.getEntriesByType('resource').find(e =>
            new URL(e.name).pathname.endsWith('/server/src/shared/tutorSources.ts'));
          const {unreadPdfPage} = await import(module.name);
          const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
          const note = (await api.importFiles([new File([bytes], 'scans.pdf', {type:'application/pdf'})])).imported[0];
          if (note.source_content) throw Error('Expected an image-only PDF');
          const block = unreadPdfPage(note, 2);
          return '?' + new URLSearchParams({note:note.id, part:block.field, at:block.index, page:block.page, sig:block.sig});
        }""", pdf)
        self.page.goto(self.origin + href)
        canvas = self.page.get_by_role("img", name="PDF 第 2 页", exact=True)
        expect(canvas).to_be_visible()
        expect(canvas).to_be_in_viewport()

    def test_stale_trashed_and_restored_links(self):
        page = self.page
        link = self.origin + self.data["body"]
        page.goto(link + '&page=2')
        expect(page.get_by_role("status").filter(has_text="定位信息无效")).to_be_visible()
        expect(page.locator("mark")).to_have_count(0)
        page.evaluate("""async id => (await import('/src/api/client.ts')).api.deleteNote(id)""", self.data["noteId"])
        page.goto(link)
        expect(page.get_by_role("status").filter(has_text="无法打开这篇笔记")).to_be_visible()
        page.evaluate("""async id => (await import('/src/api/client.ts')).api.restoreNote(id)""", self.data["noteId"])
        page.reload()
        expect(page.locator("mark").first).to_be_in_viewport()
        page.evaluate("""async id => (await import('/src/api/client.ts')).api.updateNote(id, {content:'replacement'})""",
                      self.data["noteId"])
        page.reload()
        expect(page.get_by_role("status").filter(has_text="引用段落已变更")).to_be_visible()
        expect(page.locator("mark")).to_have_count(0)

    def test_unavailable_selection_stays_explicit_until_cleared(self):
        page = self.page
        page.goto(self.origin + '?chat=' + self.data["sessionId"])
        expect(page.get_by_role("button", name="对话设置", exact=True)).to_contain_text("深度答疑")
        expect(page.get_by_role("link", name="重复的段落")).to_be_visible()
        page.evaluate("""async id => (await import('/src/api/client.ts')).api.deleteNote(id)""", self.data["noteId"])
        page.reload()
        expect(page.get_by_role("link", name="重复的段落")).to_be_visible()
        page.evaluate("""async () => {
          const {api} = await import('/src/api/client.ts');
          window.selections = [];
          api.sendTutorMessageStream = async (_, payload) => {
            window.selections.push([payload.noteIds, payload.discardedNoteIds]);
            throw Error('Test captured the query scope');
          };
        }""")
        page.get_by_role("button", name="参考笔记 (0)").click()
        clear = page.get_by_role("button", name="移除失效选择")
        expect(clear).to_be_visible()
        for cleared in [False, True]:
            if cleared:
                clear.click()
            page.locator("textarea").fill("仍然使用所选范围")
            page.get_by_role("button", name="发送消息").click()
        self.assertEqual(page.evaluate("window.selections"), [[[self.data["noteId"]], []], [[], [self.data["noteId"]]]])


if __name__ == "__main__":
    unittest.main()
