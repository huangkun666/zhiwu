"""After building the server, run python client/test/browser/tutor_pending.py -v.

The tests start separate desktop SQLite and standalone IndexedDB browser origins,
and exercise navigation while the loopback model is still holding a response.
After npm run build, set ZHIWU_PENDING_BUILT=1 to check production bundles.
"""
import json
import os
import re
from threading import Event
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect

from tutor_retrieval import TutorBrowserTest


class PendingAnswer:
    def __init__(self, question, reply, *, previous=(), block=False):
        self.question = question
        self.reply = reply
        self.previous = previous
        self.started = Event()
        self.release = Event()
        if not block:
            self.release.set()
        self.calls = []
        self.errors = []

    def respond(self, body):
        messages = [(message["role"], message["content"]) for message in body["messages"][1:]]
        assert messages == [*self.previous, ("user", self.question)], messages
        self.calls.append(bool(body.get("stream")))
        self.started.set()
        assert self.release.wait(40), "Test did not release the model response"
        return self.reply


class TutorPendingTest(TutorBrowserTest):
    fixture_args = ("--built-history",) if os.environ.get("ZHIWU_PENDING_BUILT") else ()

    @staticmethod
    def wait_for_saved_reply(page, mobile, session_id, reply):
        page.wait_for_function("""async ({mobile, sessionId, reply}) => {
            if (!mobile) {
                const response = await fetch(`/api/tutor/sessions/${sessionId}/messages`);
                return response.ok && (await response.json()).messages.some(message => message.content === reply);
            }
            const open = indexedDB.open('zhiwu_on_device_db');
            const db = await new Promise((resolve, reject) => {
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error);
            });
            try {
                const read = db.transaction('kv').objectStore('kv').get('zhiwu_state_v1');
                const state = await new Promise((resolve, reject) => {
                    read.onsuccess = () => resolve(read.result);
                    read.onerror = () => reject(read.error);
                });
                return state.tutorMessages[sessionId]?.some(message => message.content === reply);
            } finally { db.close(); }
        }""", arg=dict(mobile=mobile, sessionId=session_id, reply=reply), polling=100, timeout=10000)

    def exercise(self, page, mobile):
        page.goto(self.origins["standalone" if mobile else "desktop"])
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("button", name=re.compile("^本地模型")).click()
        page.locator("label", has_text="API Base URL").locator("..").locator("input").fill(self.model_origin)
        page.get_by_role("button", name="保存并启用", exact=True).click()
        expect(page.get_by_text("已保存", exact=True)).to_be_visible()

        def nav_button(name):
            return page.get_by_role("navigation").get_by_role("button", name=name, exact=True)

        def navigate(name):
            nav_button(name).click()

        def active_id():
            return parse_qs(urlparse(page.url).query).get("chat", [None])[0]

        def open_chat(title, session_id):
            if mobile:
                page.get_by_role("button", name="历史对话", exact=True).click()
            page.get_by_role("list", name="对话列表").get_by_role("button", name=title, exact=True).click()
            expect(page).to_have_url(re.compile(r"[?&]chat=" + re.escape(session_id) + r"$"))

        def new_chat():
            page.get_by_role("button", name="新建对话", exact=True).click()
            dialog = page.get_by_role("dialog", name="新建对话")
            expect(dialog.get_by_role("radio", name="普通对话")).to_be_checked()
            dialog.get_by_role("button", name="创建对话", exact=True).click()
            expect(dialog).to_be_hidden()
            expect(page.get_by_role("button", name="对话设置")).to_be_visible()
            return active_id()

        def prepare(question, reply, **kwargs):
            turn = self.model.witness = PendingAnswer(question, reply, **kwargs)
            self.addCleanup(turn.release.set)
            return turn

        def await_model(turn):
            self.assertTrue(turn.started.wait(8), f"The model did not receive {turn.question}: {turn.errors}")

        def answer(question, reply, **kwargs):
            turn = prepare(question, reply, **kwargs)
            composer.fill(turn.question)
            send.click()
            await_model(turn)
            return turn

        def visible_once(text):
            message = chat.get_by_text(text, exact=True)
            expect(message).to_be_visible()
            expect(message).to_have_count(1)

        def complete(turn, count):
            visible_once(turn.question)
            visible_once(turn.reply)
            expect(chat.get_by_role("button", name="存为闪卡")).to_have_count(count)
            self.assertEqual(turn.errors, [])
            self.assertEqual(turn.calls, [not mobile])

        def away(name):
            navigate(name)
            expect(chat).to_be_hidden()

        notes, home = ("笔记", "首页") if mobile else ("笔记库", "概览与图谱")
        navigate("助教")
        chat = page.get_by_role("region", name="对话消息")
        composer = page.get_by_placeholder("输入你的问题…")
        send = page.get_by_role("button", name="发送消息", exact=True)
        thinking = chat.get_by_text("思考中…", exact=True)
        expect(chat.get_by_text("有什么想了解的？")).to_be_visible()

        # Both clicks run in the same browser task, before SQLite or IndexedDB can return the new session.
        original = prepare("第一问：天色为什么变化？", "第一答：光线散射随角度变化。", block=True)
        composer.fill(original.question)
        chat_before_leaving = send.evaluate("""(send, notes) => {
            send.click();
            const chat = new URLSearchParams(location.search).get('chat');
            notes.click();
            return chat;
        }""", nav_button(notes).element_handle())
        self.assertFalse(chat_before_leaving)
        expect(chat).to_be_hidden()
        await_model(original)
        navigate("助教")
        visible_once(original.question)
        expect(thinking).to_be_visible()
        first_id = active_id()
        first_title = original.question
        self.assertIsNotNone(first_id)
        original.release.set()
        complete(original, 1)
        original_pair = (("user", original.question), ("assistant", original.reply))

        other_id = new_chat()
        self.assertNotEqual(first_id, other_id)
        other = answer("另一个对话：潮汐受什么影响？", "另一个回答：以月球引力为主。")
        complete(other, 1)
        # The second session was updated last and is first in history.
        open_chat(first_title, first_id)
        visible_once(original.reply)

        pending = answer("接着说，晚霞为何偏红？", "待定回答：较长路径会散去更多短波光。",
                         previous=original_pair, block=True)
        visible_once(pending.question)
        expect(thinking).to_be_visible()
        away(notes)
        navigate("助教")
        visible_once(pending.question)
        expect(thinking).to_be_visible()
        self.assertEqual(active_id(), first_id)

        composer.fill(pending.question)
        expect(send).to_be_disabled()
        composer.press("Enter")
        visible_once(pending.question)
        self.assertEqual(pending.calls, [not mobile])
        composer.fill("")

        open_chat("普通对话", other_id)
        visible_once(other.reply)
        expect(chat.get_by_text(pending.question, exact=True)).to_have_count(0)
        expect(thinking).to_be_hidden()
        other_followup = answer("潮差最大的周期是什么？", "潮汐续答：看月相对应的大潮周期。",
                                previous=(("user", other.question), ("assistant", other.reply)))
        complete(other_followup, 2)
        open_chat(first_title, first_id)
        visible_once(pending.question)
        expect(chat.get_by_text(other_followup.reply, exact=True)).to_have_count(0)
        expect(thinking).to_be_visible()

        away(home)
        pending.release.set()
        self.wait_for_saved_reply(page, mobile, first_id, pending.reply)
        navigate("助教")
        complete(pending, 2)
        self.assertEqual(active_id(), first_id)
        first_history = (*original_pair, ("user", pending.question), ("assistant", pending.reply))
        followup = answer("再举一个类似的例子。", "追问回答：日出时也有相似现象。", previous=first_history)
        complete(followup, 3)
        self.assertEqual(active_id(), first_id)

        followup_history = (*first_history, ("user", followup.question), ("assistant", followup.reply))
        failed = answer("阴天还能看到同样的颜色吗？", "", previous=followup_history, block=True)
        away(notes)
        chat_endpoint = "/chat/completions" if mobile else "/chat-stream"
        with page.expect_request_finished(lambda request: request.url.endswith(chat_endpoint)
                                          and request.method == "POST", timeout=10000):
            failed.release.set()
        navigate("助教")
        visible_once(failed.question)
        expect(chat.get_by_text(re.compile("模型返回了空内容"))).to_be_visible()
        retry = page.get_by_role("button", name="重试", exact=True)
        expect(retry).to_be_visible()
        self.assertEqual(failed.calls, [not mobile])
        self.assertEqual(failed.errors, [])
        retried = prepare(failed.question, "重试回答：云层会改变光线的传播。", previous=followup_history)
        retry.click()
        await_model(retried)
        complete(retried, 4)
        expect(retry).to_be_hidden()

        # Reopening reads the latest saved conversation and keeps the unsent draft.
        draft = "我正在整理一个还没发送的追问。"
        composer.fill(draft)
        away(notes)
        if mobile:
            updated_question = "备份中的追问：日落后仍有散射吗？"
            updated_reply = "备份中的回答：暮光仍有散射。"
            backup = dict(notes=[], tutorMessages={first_id: [
                dict(id="backup-question", role="user", content=updated_question, created_at="2099-01-01T00:00:00Z"),
                dict(id="backup-reply", role="assistant", content=updated_reply, created_at="2099-01-01T00:00:01Z"),
            ]})
            page.get_by_role("button", name="设置", exact=True).click()
            panel = page.get_by_role("region", name="完整备份", exact=True)
            with page.expect_file_chooser() as chooser:
                panel.get_by_role("button", name="选择备份恢复", exact=True).click()
            chooser.value.set_files(dict(name="tutor-update.json", mimeType="application/json",
                                         buffer=json.dumps(backup).encode()))
            panel.get_by_role("button", name="确认恢复", exact=True).click()
            expect(panel.get_by_role("status")).to_contain_text("恢复完成")
        else:
            updated_question = "从另一窗口追加：日落后仍有散射吗？"
            updated_reply = "另一窗口回答：暮光仍有散射。"
            external = prepare(updated_question, updated_reply,
                               previous=(*followup_history, ("user", retried.question), ("assistant", retried.reply)))
            result = page.request.post(f"{self.origins['desktop']}/api/tutor/sessions/{first_id}/chat",
                                       data={"message": external.question, "mode": "general"})
            self.assertTrue(result.ok, result.text())
            self.assertEqual(result.json()["assistantMessage"]["content"], external.reply)
            self.assertEqual(external.errors, [])
        navigate("助教")
        visible_once(updated_question)
        visible_once(updated_reply)
        expect(composer).to_have_value(draft)
        self.assertEqual(active_id(), first_id)

        # Reload through the real entry point to check persistent history, including both sessions.
        page.reload()
        complete(original, 5)
        complete(pending, 5)
        complete(followup, 5)
        complete(retried, 5)
        visible_once(updated_question)
        visible_once(updated_reply)
        open_chat("普通对话", other_id)
        complete(other, 2)
        complete(other_followup, 2)
        expect(chat.get_by_text(pending.reply, exact=True)).to_have_count(0)

    def test_desktop_sqlite(self):
        with self.browser.new_context(viewport={"width": 1440, "height": 960}, service_workers="block") as context:
            self.exercise(context.new_page(), mobile=False)

    def test_standalone_indexeddb(self):
        with self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                      service_workers="block") as context:
            self.exercise(context.new_page(), mobile=True)


if __name__ == "__main__":
    unittest.main()
