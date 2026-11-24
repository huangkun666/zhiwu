"""Exercise saved edit proposals in a fresh standalone library on a Vite dev server."""
import os
import unittest
from playwright.sync_api import expect, sync_playwright


TITLE = "步进电机校准"
BEFORE = "电流为 1.7 安。"
AFTER = "电流为 1.9 安。"
BODY = "第一段\n\n" + BEFORE + "\n\n保留这段批注。"
REPLY = "请核对下面的修改建议。"


class TutorNoteEditTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH") or playwright.chromium.executable_path)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844},
                                           is_mobile=True, service_workers="block")
        self.addCleanup(context.close)
        self.page = context.new_page()
        self.origin = os.environ.get("ZHIWU_TEST_ORIGIN", "http://127.0.0.1:5173")
        self.page.goto(self.origin)

    def open_proposal(self, operation, before, after, reply=REPLY):
        fixture = self.page.evaluate("""async ({title, body, reply, operation, before, after}) => {
          const {api, IS_STANDALONE_MODE} = await import('/src/api/client.ts');
          if (!IS_STANDALONE_MODE) throw Error('Use a temporary standalone library');
          const source = performance.getEntriesByType('resource').find(e =>
            new URL(e.name).pathname.endsWith('/shared/tutorSources.ts'));
          const {tutorNoteEditMarker} = await import(new URL('tutorNoteEdit.ts', source.name).href);
          const note = await api.createNote({title, content: body});
          const session = await api.createTutorSession({mode:'general', title:'校准讨论'});
          const proposal = {noteId:note.id, title, updatedAt:note.updated_at, operation, before, after};
          const backup = JSON.parse(await api.exportJsonBackup());
          backup.tutorMessages[session.id] = [
            {id:'edit-question', session_id:session.id, role:'user', content:'请修改笔记。', created_at:note.created_at},
            {id:'edit-reply', session_id:session.id, role:'assistant',
             content:reply + '\\n\\n<!--zhiwu-scan:test-->\\n\\n' + tutorNoteEditMarker(proposal),
             created_at:new Date(Date.now() + 1000).toISOString()}
          ];
          await api.importJsonBackup(JSON.stringify(backup));
          return {id:note.id, chat:session.id};
        }""", dict(title=TITLE, body=BODY, reply=reply, operation=operation, before=before, after=after))
        self.note_id = fixture["id"]
        self.page.goto(f"{self.origin}/?chat={fixture['chat']}")
        self.card = self.page.get_by_role("region", name="修改建议", exact=True)
        self.apply = self.card.get_by_role("button", name="应用修改", exact=True)
        expect(self.apply).to_be_enabled()
        expect(self.card.get_by_role("link")).to_contain_text(TITLE)
        if before:
            expect(self.card.locator("dd").filter(has_text=before)).to_be_visible()
        expect(self.card.locator("dd").filter(has_text=after)).to_be_visible()

    def note(self):
        return self.page.evaluate("async id => (await import('/src/api/client.ts')).api.getNote(id)", self.note_id)

    def test_replace_confirms_once_and_keeps_metadata_out_of_saved_text(self):
        self.open_proposal("replace", BEFORE, AFTER)
        self.assertEqual(self.note()["content"], BODY)
        self.apply.click()
        expect(self.card.get_by_role("status")).to_have_text("已应用修改")
        applied = self.note()
        self.assertEqual(applied["content"], BODY.replace(BEFORE, AFTER))
        self.page.reload()
        expect(self.card.get_by_role("status")).to_have_text("已应用修改")
        expect(self.apply).to_have_count(0)
        self.assertEqual(self.note()["updated_at"], applied["updated_at"])

        self.card.get_by_role("link").click()
        self.page.get_by_role("button", name="返回对话").click()
        expect(self.card.get_by_role("status")).to_have_text("已应用修改")
        self.page.get_by_role("button", name="存为闪卡").click()
        expect(self.page.get_by_role("status").filter(has_text="已一键存为记忆闪卡")).to_be_visible()
        self.page.get_by_role("button", name="存为新笔记").click()
        expect(self.page.get_by_role("status").filter(has_text="已保存为新笔记")).to_be_visible()
        stored = self.page.evaluate("""async id => {
          const {api} = await import('/src/api/client.ts');
          return [(await api.getFlashcards())[0].back, (await api.getNotes()).find(n => n.id !== id).content];
        }""", self.note_id)
        self.assertEqual(stored, [REPLY, REPLY])
        self.page.evaluate("""async id => (await import('/src/api/client.ts')).api.updateNote(id,
            {isPinned:true})""", self.note_id)
        self.page.reload()
        expect(self.card.get_by_role("status")).to_contain_text("曾应用")
        expect(self.apply).to_have_count(0)

    def test_stale_rename_preserves_concurrent_edit(self):
        self.open_proposal("rename", TITLE, "实测电流记录")
        self.page.evaluate("""async id => (await import('/src/api/client.ts')).api.updateNote(id,
            {title:'后来手工改的标题'})""", self.note_id)
        self.apply.click()
        expect(self.card.get_by_role("status")).to_contain_text("笔记已变更")
        expect(self.apply).to_have_count(0)
        self.page.reload()
        expect(self.card.get_by_role("status")).to_contain_text("笔记已变更")
        self.assertEqual(self.note()["title"], "后来手工改的标题")

    def test_rename_without_answer_text_only_offers_the_proposed_edit(self):
        self.open_proposal("rename", TITLE, "实测电流记录", reply="")
        expect(self.page.get_by_role("button", name="存为闪卡")).to_have_count(0)
        expect(self.page.get_by_role("button", name="存为新笔记")).to_have_count(0)
        self.apply.click()
        expect(self.card.get_by_role("status")).to_have_text("已应用修改")
        note = self.note()
        self.assertEqual((note["title"], note["content"]), ("实测电流记录", BODY))

    def test_retry_append_after_lost_response(self):
        self.open_proposal("append", "", AFTER)
        self.assertEqual(self.note()["chat_excerpts"], [])
        self.page.evaluate("""async () => {
          const {api} = await import('/src/api/client.ts');
          const append = api.appendNoteChat;
          api.appendNoteChat = async (...args) => {
            api.appendNoteChat = append;
            await append(...args);
            throw Error('连接中断，请重试');
          };
        }""")
        self.apply.click()
        expect(self.card.get_by_role("alert")).to_contain_text("连接中断")
        self.apply.click()
        expect(self.card.get_by_role("status")).to_have_text("已应用修改")
        self.page.reload()
        expect(self.card.get_by_role("status")).to_have_text("已应用修改")
        note = self.note()
        self.assertEqual(note["content"], BODY)
        self.assertEqual([(e["id"], e["content"]) for e in note["chat_excerpts"]],
                         [("tutor-edit-edit-reply", AFTER)])


if __name__ == "__main__":
    unittest.main()
