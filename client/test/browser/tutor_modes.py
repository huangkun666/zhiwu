"""After npm run build, run python client/test/browser/tutor_modes.py -v.

Desktop uses client/dist and temporary SQLite. The browser standalone build is placed
in the disposable fixture. ZHIWU_MODES_DEV=1 selects the quicker Vite dev servers.
Set ZHIWU_APK_CDP, ANDROID_SERIAL and ADB to drive a disposable Android debug APK.
ZHIWU_MODES_UPGRADE=1 requires the exact original seed from the previous APK.
"""
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect

from tutor_retrieval import TutorBrowserTest


PLAIN, QA, FEYNMAN = "普通对话", "深度答疑", "费曼考官"
NOTE_ID, EXPIRED = "mode-study-file", "mode-recycled-file"
TITLE, SECRET = "密封的校准记录", "MODE-PRIVATE-91B3"
TOKEN = "CHAT-MEMO-763"
NO_LOOKUP = "不用查我的笔记，只凭常识说说光学校准的目的。"
BOOK = "\n\n".join([f"日常记录 {n}，按顺序完成普通检查并登记。" * 8 for n in range(85)] +
                    [f"lumenscope optical calibration reference: {SECRET}"])
DATE = "2025-02-15T12:00:00.000Z"
SESSIONS = [dict(id="old-qa", title="升级前答疑", mode="qa", note_ids=[EXPIRED],
                 created_at=DATE, updated_at=DATE),
            dict(id="old-feynman", title="升级前费曼", mode="feynman", note_ids=[NOTE_ID],
                 created_at=DATE, updated_at=DATE)]
MESSAGES = {s["id"]: [dict(id=s["id"] + "-reply", session_id=s["id"], role="assistant",
                            content=s["title"] + "的历史消息。", created_at=DATE)] for s in SESSIONS}
NOTES = [dict(id=key, title=title, content=content, deleted_at=deleted, source_type="markdown",
              tags=[], is_pinned=False, chat_excerpts=[], word_count=len(content), created_at=DATE, updated_at=DATE)
         for key, title, content, deleted in [(NOTE_ID, TITLE, BOOK, None), (EXPIRED, "已回收测试笔记", "旧数据", DATE)]]


class RecordingModel:
    def __init__(self, mode, question, previous, reply, previous_citation):
        self.mode, self.question, self.previous, self.reply = mode, question, previous, reply
        self.previous_citation = previous_citation
        self.calls = []
        self.errors = []

    def respond(self, body):
        messages = body["messages"]
        system = messages[0]["content"]
        text = "\n".join(m["content"] for m in messages)
        if "ZHIWU_RETRIEVE" in system:
            assert self.mode != PLAIN, "Plain mode requested a retrieval plan"
            action = {"action":"finish"} if self.calls else {"action":"search", "query":"lumenscope"}
            self.calls.append(action["action"])
            return json.dumps(action)
        assert messages[-1]["content"] == self.question
        for role, expected in self.previous:
            assert any(m["role"] == role and expected in m["content"] for m in messages), (role, expected)
        if self.mode == PLAIN:
            assert self.calls == [], self.calls
            for source in (SECRET, NOTE_ID, "日常记录", "ZHIWU_SCAN"):
                assert source not in text, f"Plain mode received library material: {source}"
            # A label already visible in an older answer can remain in that conversation.
            assert TITLE not in system
            if not self.previous_citation:
                assert TITLE not in text
            if self.question == NO_LOOKUP:
                assert "[[SEARCH_NOTES]]" not in system, "Model was offered a search the user declined"
        else:
            assert self.calls == ["search", "finish"], self.calls
            assert SECRET in system and TITLE in system, "Learning mode did not receive the original"
            assert ("费曼" if self.mode == FEYNMAN else "助教") in system
            assert ("费曼" in system) == (self.mode == FEYNMAN)
        self.calls.append("answer")
        return self.reply


class TutorModesTest(TutorBrowserTest):
    fixture_args = () if os.environ.get("ZHIWU_MODES_DEV") else ("--built-history",)

    def sqlite_path(self):
        path = Path(self.origins["database"]).resolve()
        self.assertTrue(path.parent.parent.name.startswith(".tutor-browser-"))
        return path.as_uri() + "?mode=rw"

    def seed_sqlite(self):
        with closing(sqlite3.connect(self.sqlite_path(), uri=True)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM tutor_sessions").fetchone()[0], 0)
            db.executemany("INSERT INTO notes(id,title,content,deleted_at,created_at,updated_at) "
                           "VALUES(:id,:title,:content,:deleted_at,:created_at,:updated_at)", NOTES)
            db.executemany("INSERT INTO tutor_sessions(id,title,mode,note_ids,created_at,updated_at) "
                           "VALUES(:id,:title,:mode,:note_ids,:created_at,:updated_at)",
                           [dict(s, note_ids=json.dumps(s["note_ids"])) for s in SESSIONS])
            db.executemany("INSERT INTO tutor_messages(id,session_id,role,content,created_at) "
                           "VALUES(:id,:session_id,:role,:content,:created_at)",
                           [m for row in MESSAGES.values() for m in row])

    @staticmethod
    def idb(page, seed=False, upgrade=False):
        return page.evaluate("""async ({seed, upgrade, sessions, notes, messages}) => {
            const open = indexedDB.open('zhiwu_on_device_db');
            const db = await new Promise((resolve,reject) => {
                open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
            });
            try {
                return await new Promise((resolve,reject) => {
                    const tx = db.transaction('kv', seed ? 'readwrite' : 'readonly');
                    const store = tx.objectStore('kv');
                    const read = store.get('zhiwu_state_v1');
                    let snapshot;
                    tx.onabort = () => reject(Error('Expected the disposable legacy fixture or empty library'));
                    tx.oncomplete = () => resolve(snapshot);
                    read.onsuccess = () => {
                        const state = read.result;
                        if (seed) {
                            if (upgrade) {
                                if (state.tutorSessions.length !== sessions.length || state.notes.length !== notes.length ||
                                    !sessions.every(s => state.tutorSessions.some(old => old.id === s.id &&
                                        old.mode === s.mode && old.title === s.title &&
                                        JSON.stringify(old.note_ids) === JSON.stringify(s.note_ids)) &&
                                        JSON.stringify(state.tutorMessages[s.id]) === JSON.stringify(messages[s.id])) ||
                                    !notes.every(n => state.notes.some(old => old.id === n.id && old.content === n.content))) tx.abort();
                            } else {
                                if (state.tutorSessions.length || state.notes.length) { tx.abort(); return; }
                                store.put({...state, notes, tutorSessions:sessions, tutorMessages:messages},'zhiwu_state_v1');
                            }
                        } else {
                            snapshot = state.tutorSessions.map(({id,title,mode}) =>
                                ({id,title,mode,count:state.tutorMessages[id]?.length || 0}));
                        }
                    };
                });
            } finally { db.close(); }
        }""", dict(seed=seed, upgrade=upgrade, sessions=SESSIONS if seed else [],
                   notes=NOTES if seed else [], messages=MESSAGES if seed else {}))

    def snapshot(self, page, mobile):
        if mobile:
            return self.idb(page)
        with closing(sqlite3.connect(self.sqlite_path(), uri=True)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(
                "SELECT s.id,s.title,s.mode,count(m.id) AS count FROM tutor_sessions s "
                "LEFT JOIN tutor_messages m ON m.session_id=s.id GROUP BY s.id")]

    def run_flow(self, page, platform):
        mobile = platform != "desktop"
        page.set_default_timeout(15000)
        if platform == "apk":
            self.assertEqual(page.evaluate("window.Capacitor?.getPlatform()"), "android")
            origin = page.evaluate("location.origin")
        else:
            origin = self.origins[platform]
        page.goto(origin)
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("button", name=re.compile("^本地模型")).click()
        page.locator("label", has_text="API Base URL").locator("..").locator("input").fill(self.model_origin)
        page.get_by_role("button", name="保存并启用", exact=True).click()
        expect(page.get_by_text("已保存", exact=True)).to_be_visible()
        if mobile:
            self.idb(page, seed=True, upgrade=platform == "apk" and bool(os.environ.get("ZHIWU_MODES_UPGRADE")))
        else:
            self.seed_sqlite()
        page.goto(origin + "/?chat=old-qa")
        chat = page.get_by_role("region", name="对话消息")
        new = page.get_by_role("button", name="新建对话", exact=True)
        settings = page.get_by_role("button", name="对话设置", exact=True)
        picker = page.get_by_role("button", name=re.compile("^参考笔记"))
        create = page.get_by_role("dialog", name="新建对话", exact=True)
        config = page.get_by_role("dialog", name="对话设置", exact=True)

        def check_mode(mode):
            expect(settings).to_contain_text(mode)
            settings.click()
            expect(config.get_by_role("radio", name=mode, exact=True)).to_be_checked()
            config.get_by_role("button", name="取消", exact=True).click()

        def change(mode, save=True):
            settings.click()
            config.get_by_role("radio", name=mode, exact=True).check()
            config.get_by_role("button", name="保存" if save else "取消", exact=True).click()
            expect(config).to_be_hidden()

        def open_new():
            expect(new).to_have_count(1)
            new.click()
            expect(create.get_by_role("radio")).to_have_count(3)
            for label in (PLAIN, QA, FEYNMAN):
                expect(create.get_by_role("radio", name=label, exact=True)).to_be_visible()
            expect(create.get_by_role("radio", name=PLAIN, exact=True)).to_be_checked()

        def send(mode, question, previous, reply, previous_citation=False):
            witness = self.model.witness = RecordingModel(mode, question, previous, reply, previous_citation)
            page.locator("textarea").fill(question)
            page.get_by_role("button", name="发送消息", exact=True).click()
            try:
                expect(chat.get_by_text(reply, exact=True)).to_be_visible(timeout=20000)
            except AssertionError:
                self.fail(f"{mode}: {witness.calls}, model errors {witness.errors}, UI {chat.inner_text()}")
            self.assertEqual(witness.errors, [])
            self.assertEqual(witness.calls, ["answer"] if mode == PLAIN else ["search", "finish", "answer"])
            # The stored final message is now visible as a complete reply.
            expect(chat.get_by_role("button", name="存为闪卡").last).to_be_visible()

        def delete_current(sid):
            page.goto(origin + "/?chat=" + sid)
            expect(settings).to_be_visible()
            if mobile:
                page.get_by_role("button", name="历史对话", exact=True).click()
            active = page.get_by_role("list", name="对话列表").locator("li").filter(
                has=page.locator("button[aria-current='true']"))
            active.get_by_role("button", name=re.compile("^删除")).click()
            active.get_by_role("button", name="确认删除", exact=True).click()
            expect(active).to_have_count(0)
            close = page.get_by_role("button", name="关闭历史对话", exact=True)
            if mobile and close.is_visible():
                close.click()
            expect(settings).to_have_count(0)
            expect(picker).to_have_count(0)
            expect(page.locator("textarea")).to_have_value("")

        expect(chat.get_by_text(MESSAGES["old-qa"][0]["content"], exact=True)).to_be_visible()
        expect(new).to_have_count(1)
        check_mode(QA)
        expect(picker).to_have_text(re.compile(r"\(0\)"))
        picker.click()
        page.get_by_role("button", name="移除失效选择").click()
        picker.click()
        send(QA, "查这份校准记录中的原文", [("assistant", MESSAGES["old-qa"][0]["content"])], "已核对答疑资料。")
        page.goto(origin + "/?chat=old-feynman")
        check_mode(FEYNMAN)
        expect(picker).to_have_text(re.compile(r"\(1\)"))
        send(FEYNMAN, "请根据校准记录追问我", [("assistant", MESSAGES["old-feynman"][0]["content"])], "请解释这个读数的边界。")
        change(PLAIN)
        page.reload()
        check_mode(PLAIN)
        expect(picker).to_have_count(0)
        send(PLAIN, "沿用刚才的话题做一般性讨论。", [("user", "请根据校准记录追问我"),
             ("assistant", "请解释这个读数的边界。")], "我们继续讨论这个边界。", previous_citation=True)
        change(FEYNMAN)
        before = self.snapshot(page, mobile)
        open_new()
        create.get_by_role("radio", name=FEYNMAN, exact=True).check()
        create.get_by_role("button", name="取消", exact=True).click()
        self.assertEqual(self.snapshot(page, mobile), before)
        open_new()
        create.get_by_role("button", name="创建对话", exact=True).click()
        expect(create).to_be_hidden()
        expect(picker).to_have_count(0)
        check_mode(PLAIN)
        plain_id = parse_qs(urlparse(page.url).query)["chat"][0]
        self.assertNotIn(plain_id, ("old-qa", "old-feynman"))
        first = "请给我一张便签，聊聊光学校准的一般原理。"
        send(PLAIN, first, [], TOKEN)
        send(PLAIN, "接着聊，刚才的便签号是什么？", [("user", first), ("assistant", TOKEN)], "刚才的便签为 " + TOKEN)
        send(PLAIN, NO_LOOKUP, [("assistant", TOKEN)], "校准能减少系统误差。")
        change(QA, save=False)
        check_mode(PLAIN)
        prior = next(s for s in self.snapshot(page, mobile) if s["id"] == plain_id)
        change(QA)
        page.reload()
        check_mode(QA)
        expect(picker).to_be_visible()
        after = next(s for s in self.snapshot(page, mobile) if s["id"] == plain_id)
        self.assertEqual(after["count"], prior["count"])
        self.assertEqual(after["mode"], "qa")
        open_new()
        create.get_by_role("radio", name=FEYNMAN, exact=True).check()
        create.get_by_role("button", name="创建对话", exact=True).click()
        expect(create).to_be_hidden()
        check_mode(FEYNMAN)
        change(PLAIN)
        page.reload()
        check_mode(PLAIN)
        expect(picker).to_have_count(0)
        expect(chat.get_by_text("有什么想了解的？", exact=True)).to_be_visible()
        send(PLAIN, "我想聊普通光学问题", [], "普通讨论已开始。")

        # The dedicated note page still starts a Feynman session with this note selected.
        page.goto(origin + "/?note=" + NOTE_ID)
        page.get_by_role("button", name="费曼追问", exact=True).click()
        check_mode(FEYNMAN)
        expect(picker).to_have_text(re.compile(r"\(1\)"))
        picker.click()
        expect(page.get_by_role("button", name=TITLE, exact=True)).to_be_visible()
        for entry in self.snapshot(page, mobile):
            delete_current(entry["id"])
        self.assertEqual(self.snapshot(page, mobile), [])
        send(PLAIN, "从空白页直接问一个常识问题。", [], "已自动开启普通对话。")
        check_mode(PLAIN)
        expect(picker).to_have_count(0)
        self.assertEqual(len(self.snapshot(page, mobile)), 1)

    def test_desktop_sqlite(self):
        with self.browser.new_context(viewport={"width": 1440, "height": 960}, service_workers="block") as context:
            self.run_flow(context.new_page(), "desktop")

    def test_standalone_indexeddb(self):
        with self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                      service_workers="block") as context:
            self.run_flow(context.new_page(), "standalone")

    @unittest.skipUnless(os.environ.get("ZHIWU_APK_CDP"), "Requires a disposable debug APK")
    def test_android_apk(self):
        adb = [os.environ.get("ADB", "adb"), "-s", os.environ["ANDROID_SERIAL"]]
        port = self.model.server_port
        subprocess.run(adb + ["reverse", f"tcp:{port}", f"tcp:{port}"], check=True)
        self.addCleanup(subprocess.run, adb + ["reverse", "--remove", f"tcp:{port}"])
        self.run_flow(self.apk_page(), "apk")


if __name__ == "__main__":
    unittest.main()
