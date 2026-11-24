"""From repository root: npm --prefix server run build, then python client/test/browser/tutor_retrieval.py -v.

Requires Python Playwright and Chromium (CHROMIUM_PATH can select an installed browser).
The harness starts disposable SQLite, Vite and model servers on loopback. The optional
ZHIWU_ANDROID_CDP endpoint must belong to a disposable Android Chromium profile.
Set ZHIWU_APK_CDP for a freshly installed debug APK's WebView, ADB for the adb
executable and ANDROID_SERIAL for the target emulator. Use the browser WebSocket
URL returned by the forwarded /json/version endpoint. Production APK verification
imports both sources through the app UI, and requires an empty temporary library.
"""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
from time import monotonic
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


PDF_KEY = "lapidolite"
BODY_KEY = "oradometer"
PDF_PAGE = 25
PARAGRAPH = 103
PDF_NAME = "Optical inspection handbook"
BODY_NAME = "Field notebook"
BODY_ORIGINAL = "Original register for the instrument housing. Preserve this signed record."
NEW_CODE = "NB-REVISED-72"
PARTIAL_SCAN_ANSWER = "INCOMPLETE_SCAN_SUMMARY"


def field_entry(number):
    return (f"The inspector recorded visit {number} in the field ledger. "
            "The morning review included the instrument housing, documentation envelope and serial plate. "
            "After the inspection the team filed the worksheet and reviewed the schedule with the next shift.")


class Witness:
    """Echo a previously unseen nonce only after a search and adjacent-unit read return it."""
    require_hidden_answer = True

    def __init__(self, key, answer, *, on_demand=False, previous_page=None):
        self.key = key
        self.answer = answer
        self.on_demand = on_demand
        self.requested = False
        self.previous_page = previous_page
        self.steps = []
        self.errors = []
        self.hit = None
        self.final_stream = None

    def respond(self, body):
        prompt = "\n".join(m["content"] for m in body["messages"])
        system = body["messages"][0]["content"]
        if "[[SEARCH_NOTES]]" in system:
            assert self.on_demand and not self.requested and not self.steps, "Unexpected search decision"
            for material in (PDF_NAME, BODY_NAME, PDF_KEY, BODY_KEY, self.answer, field_entry(1)):
                assert material not in prompt, "Library material reached the model before it chose to search"
            self.requested = True
            return "[[SEARCH_NOTES]]"
        assert self.on_demand == self.requested, "Retrieval started without the model's search request"
        if "ZHIWU_RETRIEVE" in system:
            state = json.loads(body["messages"][-1]["content"])
            if self.previous_page and not self.steps:
                assert len(state["previousSources"]) == 1, "The previous citation was not recovered"
                source, _ = state["previousSources"][0].split()
                self.steps.append("read")
                return json.dumps(dict(action="read", source=source, page=self.previous_page + 1, count=2))
            if not self.steps:
                if self.require_hidden_answer:
                    assert self.answer not in prompt, "Answer leaked into initial planning context"
                self.steps.append("search")
                return json.dumps(dict(action="search", query=self.key))
            if self.steps == ["search"]:
                # The search produces a source ID and position. Read the *next* unit.
                result = state["results"][-1]
                assert self.answer not in result, "Search alone already disclosed the answer"
                hit = re.search(r"(?ms)^(N\d+)\s+#(\d+)\b(?:(?!^N\d+ #).)*?" + self.key, result, re.I)
                assert hit, f"Search did not return the clue's locator: {result!r}"
                self.hit = hit.group(1), int(hit.group(2))
                self.steps.append("read")
                source, index = self.hit
                return json.dumps(dict(action="read", source=source, start=index + 1, count=1))
            assert self.steps[-1] == "read", self.steps
            assert self.answer in state["results"][-1], "Adjacent-unit read did not return the actual answer"
            self.steps.append("finish")
            return json.dumps(dict(action="finish"))

        if self.previous_page:
            # A cited relative position can be read directly from its saved locator.
            assert self.steps in ([], ["read", "finish"]), self.steps
        else:
            assert self.steps == ["search", "read", "finish"], self.steps
        evidence = list(re.finditer(r"(?m)^\s*\[(S\d+)\]\s*N\d+\s+#\d+[^\n]*\n", prompt))
        for i, header in enumerate(evidence):
            end = evidence[i + 1].start() if i + 1 < len(evidence) else len(prompt)
            if re.search(r"\b" + re.escape(self.answer) + r"\b", prompt[header.end():end]):
                self.final_stream = bool(body.get("stream"))
                self.steps.append("answer")
                return f"The recorded value is {self.answer}. [{header[1]}]"
        raise AssertionError("Final context did not associate the answer with an evidence ID")


class EditWitness(Witness):
    # Naming the target note and its code in the edit question can rank the right paragraph immediately.
    require_hidden_answer = False

    def respond(self, body):
        reply = super().respond(body)
        if self.steps[-1] != "answer":
            return reply
        assert "zhiwu-edit" in body["messages"][0]["content"], "No edit proposal tool was offered"
        proposal = dict(source=self.hit[0], operation="replace", before=self.answer, after=NEW_CODE)
        return "建议修正夜班验收码。\n\n```zhiwu-edit\n" + json.dumps(proposal) + "\n```"


class ScanRequestFailure(Exception):
    pass


class ScanWitness:
    def __init__(self, question, issue=None):
        self.question = question
        self.issue = issue
        self.attempts = []
        self.errors = []

    def respond(self, body):
        if not body["messages"][0]["content"].startswith("ZHIWU_SCAN"):
            if self.issue == "request":
                raise ScanRequestFailure()
            return "本轮记录已整理。"
        request = json.loads(body["messages"][-1]["content"])
        assert request["question"] == self.question, request["question"]
        keys = [key for key, _ in request["originals"]]
        self.attempts.append((keys, body.get("response_format")))
        if self.issue == "request":
            raise ScanRequestFailure()
        if self.issue == "format":
            return '{"findings":['
        if self.issue == "quote":
            return json.dumps({"findings": [{"unit": keys[0], "quote": "虚构的测试摘录"}]})
        return json.dumps({"findings": [{"unit": key, "quote": "备用供电仍可用。"}
                                        for key, source in request["originals"] if "备用供电仍可用。" in source]})


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def headers_for(self, media_type):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Content-Type", media_type)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.headers_for("text/plain")

    def do_POST(self):
        witness = self.server.witness
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            reply = witness.respond(body)
            self.send_response(200)
            if body.get("stream"):
                self.headers_for("text/event-stream")
                for delta in (reply[:12], reply[12:]):
                    token = json.dumps({"choices": [{"delta": {"content": delta}}]})
                    self.wfile.write(f"data: {token}\n\n".encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.headers_for("application/json")
                self.wfile.write(json.dumps({"choices": [{"message": {"content": reply}}]}).encode())
        except ScanRequestFailure:
            if body.get("stream"):
                token = json.dumps({"choices": [{"delta": {"content": PARTIAL_SCAN_ANSWER}}]})
                partial = f"data: {token}\n\n".encode()
                self.send_response(200)
                # Close early so the gateway reports a transport failure after the first delta.
                self.send_header("Content-Length", str(len(partial) + 200))
                self.headers_for("text/event-stream")
                self.wfile.write(partial)
                self.wfile.flush()
            else:
                self.send_response(503)
                self.headers_for("text/plain")
                self.wfile.write(b"Fixture model could not read the requested paragraphs")
        except Exception as error:
            witness.errors.append(repr(error))
            self.send_error(500, "Fixture model protocol mismatch")


class TutorBrowserTest(unittest.TestCase):
    fixture_args = ()

    @classmethod
    def setUpClass(cls):
        cls.model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=cls.model.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.model.server_close)
        cls.addClassCleanup(cls.model.shutdown)
        fixture = Path(__file__).with_name("tutor_server.mjs")
        cls.service = subprocess.Popen(["node", str(fixture), *cls.fixture_args], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, encoding="utf-8")
        cls.addClassCleanup(cls.stop_service)
        cls.origins = json.loads(cls.service.stdout.readline())
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH") or cls.playwright.chromium.executable_path,
        )
        cls.addClassCleanup(cls.browser.close)

    @classmethod
    def stop_service(cls):
        try:
            if cls.service.poll() is None:
                cls.service.stdin.write("stop\n")
                cls.service.stdin.flush()
            cls.service.wait(timeout=30)
        finally:
            if cls.service.poll() is None:
                cls.service.kill()
                cls.service.wait()
            cls.service.stdin.close()
            cls.service.stdout.close()
            # A Vite dependency worker can finish writing its cache after server.close() on Windows.
            path = getattr(cls, "origins", {}).get("database")
            if path:
                folder = Path(path).resolve().parent.parent
                server = Path(__file__).resolve().parents[3] / "server"
                if folder.parent == server and folder.name.startswith(".tutor-browser-") and folder.exists():
                    shutil.rmtree(folder)

    @property
    def model_origin(self):
        return f"http://127.0.0.1:{self.model.server_port}"

    def apk_page(self):
        # Capacitor may also expose a detached, zero-size WebView target (e.g. on initial install).
        endpoint = os.environ["ZHIWU_APK_CDP"]
        browser = self.playwright.chromium.connect_over_cdp(endpoint, no_defaults=True)
        for page in browser.contexts[0].pages:
            if page.evaluate("document.visibilityState === 'visible' && innerWidth > 0 && innerHeight > 0"):
                return page
        self.fail("No visible APK WebView target")


class TutorScanStatusTest(TutorBrowserTest):
    def check_scan_statuses(self, mode, viewport):
        origin = self.origins[mode]
        with self.browser.new_context(viewport=viewport, service_workers="block") as context:
            page = context.new_page()
            page.goto(origin)
            page.evaluate("""async (model) => {
                const {api} = await import('/src/api/client.ts');
                const settings = await api.getSettings();
                settings.providers.find(p => p.id === 'local').baseUrl = model;
                await api.saveSettings({...settings, activeProviderId:'local'});
                const entries = Array.from({length: 43}, (_, i) =>
                    `实验 ${i + 1}。${'记录了设备的运行情况。'.repeat(20)}${i === 42 ? '备用供电仍可用。' : ''}`);
                await api.createNote({title: '供电实验记录', content: entries.join('\\n\\n')});
            }""", self.model_origin)
            page.get_by_role("button", name="助教", exact=True).click()
            messages = page.get_by_role("region", name="对话消息")
            field = page.locator("textarea")
            send = page.get_by_role("button", name="发送消息")
            streams = []
            page.on("response", lambda r: streams.append(r) if "/chat-stream" in r.url else None)
            question = "逐段核对供电实验记录"
            for issue, reason in [("request", "模型请求未成功或没有返回内容"),
                                  ("format", "模型返回的结果格式无法解析"),
                                  ("quote", "模型摘录与原文不符")]:
                with self.subTest(mode=mode, issue=issue):
                    page.get_by_role("button", name="新建对话", exact=True).click()
                    dialog = page.get_by_role("dialog", name="新建对话", exact=True)
                    dialog.get_by_role("radio", name="深度答疑", exact=True).check()
                    dialog.get_by_role("button", name="创建对话", exact=True).click()
                    expect(dialog).to_be_hidden()
                    self.model.witness = witness = ScanWitness(question, issue)
                    field.fill(question)
                    send.click()
                    status = messages.get_by_text(re.compile(r"本轮完成 0 段，累计 0/43 段。.*" + reason))
                    expect(status).to_be_visible(timeout=30000)
                    expect(status).to_contain_text("重试逐段检查")
                    expect(messages.get_by_text("虚构的测试摘录")).to_have_count(0)
                    expect(messages.get_by_text("可继续检查剩余段落")).to_have_count(0)
                    self.assertEqual(witness.errors, [])
                    self.assertEqual(len(witness.attempts), 3)
                    self.assertEqual(witness.attempts[0][1], {"type": "json_object"})
                    if issue == "request":
                        self.assertEqual(witness.attempts[1], (witness.attempts[0][0], None))
                        expect(messages.get_by_text("模型未能生成回答。", exact=True)).to_be_visible()
                        expect(messages.get_by_text(PARTIAL_SCAN_ANSWER)).to_have_count(0)
                        if mode == "desktop":
                            self.assertIn(PARTIAL_SCAN_ANSWER, streams[-1].text())
                        saved = page.evaluate("""async () => {
                            const {api} = await import('/src/api/client.ts');
                            const [{id}] = await api.getTutorSessions();
                            const {messages} = await api.getTutorMessages(id);
                            return messages.at(-1).content;
                        }""")
                        self.assertIn(reason, saved)
                        self.assertIn("模型未能生成回答。", saved)
                        self.assertNotIn(PARTIAL_SCAN_ANSWER, saved)
                    else:
                        self.assertLess(len(witness.attempts[1][0]), len(witness.attempts[0][0]))
            self.model.witness = witness = ScanWitness(question)
            field.fill("重试逐段检查")
            send.click()
            expect(messages.get_by_text(re.compile(r"本轮完成 43 段，累计 43/43 段"))).to_be_visible(timeout=30000)
            citation = messages.get_by_role("link", name="供电实验记录 · 正文第 43 段", exact=True)
            expect(citation).to_be_visible()
            self.assertEqual(witness.errors, [])
            self.assertEqual([key for keys, _ in witness.attempts for key in keys], [f"N1 #{i}" for i in range(1, 44)])
            citation.click()
            expect(page.locator("mark[data-source-target]").filter(has_text="备用供电仍可用。")).to_be_in_viewport()
            page.get_by_role("button", name="返回对话").click()
            expect(messages.get_by_text(re.compile(r"累计 43/43 段"))).to_be_visible()

    def test_desktop_sqlite(self):
        self.check_scan_statuses("desktop", {"width": 1440, "height": 960})

    def test_standalone_indexeddb(self):
        self.check_scan_statuses("standalone", {"width": 390, "height": 844})


class TutorRetrievalTest(TutorBrowserTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pdf_answer = "OP-" + secrets.token_hex(6).upper()
        cls.next_page_answer = "NX-" + secrets.token_hex(6).upper()
        cls.body_answer = "NB-" + secrets.token_hex(6).upper()
        page = cls.browser.new_page()
        sheets = []
        for n in range(1, 33):
            passage = field_entry(n)
            if n == PDF_PAGE - 1:
                passage = f"For {PDF_KEY} inspection, the following sheet gives the calibration value."
            elif n == PDF_PAGE:
                # PDF text items can split an identifier at a font change without a word break.
                passage = ("The calibration value recorded for the night shift is "
                           f"{cls.pdf_answer[:3]}<b>{cls.pdf_answer[3:]}</b>.")
            elif n == PDF_PAGE + 1:
                passage = f"The spare instrument's verification code is {cls.next_page_answer}."
            sheets.append(f"<section><p>Optical inspection handbook | Sheet {n}</p><p>{passage}</p></section>")
        page.set_content("<style>section + section { break-before: page }</style>" + "".join(sheets))
        cls.pdf = base64.b64encode(page.pdf()).decode()
        page.close()
        entries = [field_entry(n) for n in range(1, 171)]
        entries[PARAGRAPH - 2] = f"The {BODY_KEY} inspection refers to the value written in the next paragraph."
        entries[PARAGRAPH - 1] = f"The night shift acceptance code is {cls.body_answer}."
        cls.body = "\n\n".join(entries)

    def run_flow(self, mode, page, platform=None):
        origin = self.origins[mode]
        page.set_default_timeout(20000)
        page.goto(origin)
        standalone = mode == "standalone"
        note_ids = page.evaluate("""async (args) => {
            const {api, IS_STANDALONE_MODE} = await import('/src/api/client.ts');
            if (IS_STANDALONE_MODE !== args.offline) throw Error('Wrong storage mode');
            if ((await api.getNotes()).length) throw Error('Expected an empty, disposable library');
            const settings = await api.getSettings();
            settings.providers.find(p => p.id === 'local').baseUrl = args.model;
            await api.saveSettings({...settings, activeProviderId:'local'});
            const binary = Uint8Array.from(atob(args.pdf), c => c.charCodeAt(0));
            const imported = await api.importFiles([new File([binary], args.pdfName + '.pdf', {type:'application/pdf'}),
                new File([args.original], args.bodyName + '.txt', {type:'text/plain'})]);
            if (imported.warnings.length) {
                if (args.offline) {
                    const {loadPdf} = await import('/src/utils/pdf.ts');
                    const task = await loadPdf(binary);
                    try {
                        const document = await task.promise;
                        await (await document.getPage(1)).getTextContent();
                    } catch (error) {
                        throw Error([error.name, error.message, error.details, error.stack].join(' | '));
                    } finally { await task.destroy(); }
                }
                throw Error(imported.warnings.join(' '));
            }
            const [pdf,body] = imported.imported;
            if (!pdf.source_content.includes(args.pdfAnswer)) throw Error('PDF text extraction lost the value');
            return {pdf:pdf.id, body:body.id};
        }""", dict(offline=standalone, model=self.model_origin, pdf=self.pdf, pdfName=PDF_NAME,
                   bodyName=BODY_NAME, original=BODY_ORIGINAL, pdfAnswer=self.pdf_answer))
        self.check_answers(platform or mode, page, origin, note_ids)

    def check_answers(self, mode, page, origin, note_ids):
        page.goto(origin + "/?note=" + note_ids["body"])
        page.get_by_title("编辑", exact=True).click()
        body_editor = page.get_by_role("textbox", name="笔记正文")
        body_editor.fill(self.body)
        page.get_by_role("button", name="保存", exact=True).click()
        expect(body_editor).to_be_hidden()
        stream_responses = []
        page.on("response", lambda r: stream_responses.append(r) if "/chat-stream" in r.url else None)
        mobile = mode != "desktop"
        for chat_mode, kind, question in [
            ("深度答疑", "pdf", "夜班的光学校准值是多少？请核对手册原文。"),
            ("深度答疑", "body", "交接用的验收码是什么？请打开现场记录核实。"),
            ("普通对话", "pdf", "请查我的笔记，核对夜班的光学校准值。"),
            ("普通对话", "body", "夜班交接的验收码是多少？"),
        ]:
            with self.subTest(platform=mode, mode=chat_mode, source=kind):
                title, key, answer = ((PDF_NAME, PDF_KEY, self.pdf_answer) if kind == "pdf"
                                      else (BODY_NAME, BODY_KEY, self.body_answer))
                general = chat_mode == "普通对话"
                page.goto(origin)
                page.get_by_role("button", name="助教", exact=True).click()
                page.get_by_role("button", name="新建对话", exact=True).click()
                dialog = page.get_by_role("dialog", name="新建对话", exact=True)
                if general:
                    expect(dialog.get_by_role("radio", name=chat_mode, exact=True)).to_be_checked()
                else:
                    dialog.get_by_role("radio", name=chat_mode, exact=True).check()
                dialog.get_by_role("button", name="创建对话", exact=True).click()
                expect(dialog).to_be_hidden()
                expect(page.get_by_role("button", name="对话设置", exact=True)).to_contain_text(chat_mode)
                messages = page.get_by_role("region", name="对话消息")
                if kind == "body" and not general:
                    picker = page.get_by_role("button", name=re.compile("参考笔记"))
                    picker.click()
                    page.get_by_role("button", name=title, exact=True).click()
                    picker.click()
                self.model.witness = witness = Witness(key, answer, on_demand=general and kind == "body")
                page.locator("textarea").fill(question)
                sent_at = monotonic()
                page.get_by_role("button", name="发送消息").click()
                try:
                    expect(messages.get_by_text(re.compile(re.escape(answer)))).to_be_visible(timeout=30000)
                    citation = messages.get_by_role("link", name=re.compile(title))
                    expect(citation).to_be_visible()
                    reply_seconds = monotonic() - sent_at
                except AssertionError as error:
                    self.fail(f"{error}\nModel errors: {witness.errors}; steps: {witness.steps}; UI: {messages.inner_text()}")
                self.assertEqual(witness.errors, [])
                self.assertEqual(witness.steps, ["search", "read", "finish", "answer"])
                expect(page.get_by_role("button", name="对话设置", exact=True)).to_contain_text(chat_mode)
                if not mobile:
                    self.assertTrue(witness.final_stream)
                    response = stream_responses[-1]
                    self.assertIn("text/event-stream", response.headers["content-type"])
                    self.assertIn('"delta"', response.text())
                    self.assertNotIn("[[SEARCH_NOTES]]", response.text())
                link = citation.get_attribute("href")
                params = parse_qs(urlparse(link).query)
                self.assertEqual(params["note"], [note_ids[kind]])
                self.assertIn("sig", params)
                self.assertEqual(params["part"], ["source" if kind == "pdf" else "body"])
                if kind == "body":
                    self.assertEqual(params["at"], [str(PARAGRAPH)])
                # Read back through each mode's public, persistent session API.
                if mode == "apk":
                    stored = self.saved_android_value(page, "answer", question)
                else:
                    stored = page.evaluate("""async (question) => {
                        const {api} = await import('/src/api/client.ts');
                        for (const {id} of await api.getTutorSessions()) {
                            const {messages} = await api.getTutorMessages(id);
                            if (messages.some(m => m.role === 'user' && m.content === question))
                                return messages.filter(m => m.role === 'assistant').at(-1)?.content;
                        }
                    }""", question)
                self.assertIn(link, stored)
                self.assertNotIn("[[SEARCH_NOTES]]", stored)
                opened_at = monotonic()
                citation.click()
                if kind == "pdf":
                    self.assertEqual(params.get("page"), [str(PDF_PAGE)])
                    expect(page.get_by_role("img", name=f"PDF 第 {PDF_PAGE} 页", exact=True)).to_be_visible(timeout=20000)
                    expect(page.get_by_text(f"第 {PDF_PAGE} / 32 页", exact=True)).to_be_visible()
                else:
                    expect(page.locator("mark[data-source-target]").filter(has_text=answer)).to_be_in_viewport()
                open_seconds = monotonic() - opened_at
                page.get_by_role("button", name="返回对话").click()
                expect(messages.get_by_role("link", name=re.compile(title))).to_be_visible()
                print(f"{mode}/{chat_mode}/{kind} answer {reply_seconds:.2f}s, source opened {open_seconds:.2f}s, "
                      f"{len(witness.steps) + int(witness.requested)} model calls", flush=True)
                if general and kind == "pdf":
                    self.check_following_page(page, messages, note_ids["pdf"])
                elif not general and kind == "body":
                    messages.get_by_role("button", name="追加到笔记", exact=True).click()
                    expect(page.get_by_role("status").filter(has_text="已追加到")).to_be_visible()
        self.check_note_edit(mode, page, origin, note_ids["body"])

    def check_note_edit(self, mode, page, origin, note_id):
        def note():
            if mode == "apk":
                return self.saved_android_value(page, "note", note_id)
            return page.evaluate("""async id => (await import('/src/api/client.ts')).api.getNote(id)""", note_id)

        before = note()
        self.assertEqual(before["content"], self.body)
        self.assertEqual(before["source_content"], BODY_ORIGINAL)
        self.assertIn(self.body_answer, before["chat_excerpts"][0]["content"])
        page.goto(origin)
        page.get_by_role("button", name="助教", exact=True).click()
        page.get_by_role("button", name="新建对话", exact=True).click()
        dialog = page.get_by_role("dialog", name="新建对话", exact=True)
        dialog.get_by_role("button", name="创建对话", exact=True).click()
        expect(dialog).to_be_hidden()
        self.model.witness = witness = EditWitness(BODY_KEY, self.body_answer)
        page.locator("textarea").fill(f"把《{BODY_NAME}》笔记正文中的夜班验收码改成 {NEW_CODE}。")
        page.get_by_role("button", name="发送消息").click()
        suggestion = page.get_by_role("region", name="修改建议", exact=True)
        apply = suggestion.get_by_role("button", name="应用修改", exact=True)
        try:
            expect(apply).to_be_visible(timeout=30000)
        except AssertionError as error:
            self.fail(f"{error}\nEdit model errors: {witness.errors}, steps: {witness.steps}")
        self.assertEqual(witness.errors, [])
        expect(suggestion.get_by_role("link", name=BODY_NAME, exact=True)).to_be_visible()
        expect(suggestion.get_by_text(self.body_answer, exact=True)).to_be_visible()
        expect(suggestion.get_by_text(NEW_CODE, exact=True)).to_be_visible()
        self.assertEqual(note()["content"], self.body, "Generating a suggestion must preserve the note")
        apply.click()
        expect(suggestion.get_by_role("status")).to_have_text("已应用修改")
        page.goto(origin + "/?note=" + note_id)
        expect(page.get_by_text(re.compile("night shift acceptance code is " + NEW_CODE))).to_be_visible()
        after = note()
        self.assertEqual(after["content"], self.body.replace(self.body_answer, NEW_CODE))
        for field in ("title", "source_filename", "source_content", "attachment_path", "chat_excerpts"):
            self.assertEqual(after[field], before[field], field)
        self.assertEqual(page.evaluate("async href => (await fetch(href)).text()", after["attachment_path"]), BODY_ORIGINAL)

    def check_following_page(self, page, messages, note_id):
        self.model.witness = witness = Witness(None, self.next_page_answer, previous_page=PDF_PAGE)
        page.locator("textarea").fill("那下一页的备用仪器验证码呢？")
        page.get_by_role("button", name="发送消息").click()
        try:
            expect(messages.get_by_text(re.compile(self.next_page_answer))).to_be_visible(timeout=30000)
        except AssertionError as error:
            self.fail(f"{error}\nFollow-up model errors: {witness.errors}, steps: {witness.steps}")
        self.assertEqual(witness.errors, [])
        self.assertIn(witness.steps, (["answer"], ["read", "finish", "answer"]))
        citation = messages.get_by_role("link", name=re.compile(rf"{PDF_NAME}.*第 {PDF_PAGE + 1} 页"))
        expect(citation).to_be_visible()
        params = parse_qs(urlparse(citation.get_attribute("href")).query)
        self.assertEqual(params["note"], [note_id])
        self.assertEqual(params["page"], [str(PDF_PAGE + 1)])
        citation.click()
        expect(page.get_by_role("img", name=f"PDF 第 {PDF_PAGE + 1} 页", exact=True)).to_be_visible()
        page.get_by_role("button", name="返回对话").click()
        expect(messages.get_by_text(re.compile(self.next_page_answer))).to_be_visible()

    def test_desktop_sqlite(self):
        with self.browser.new_context(viewport={"width": 1440, "height": 960}, service_workers="block") as context:
            self.run_flow("desktop", context.new_page())

    def test_standalone_indexeddb(self):
        with self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True,
                                      service_workers="block") as context:
            self.run_flow("standalone", context.new_page())

    @unittest.skipUnless(os.environ.get("ZHIWU_ANDROID_CDP"), "Requires disposable Android Chromium with adb reverse")
    def test_android_chromium(self):
        # Reverse only the fixture's two random ports so the Android browser sees secure localhost.
        adb = [os.environ.get("ADB", "adb"), "-s", os.environ["ANDROID_SERIAL"]]
        subprocess.run(adb + ["shell", "am", "start", "-W", "-n",
                              "com.android.chrome/com.google.android.apps.chrome.Main"], check=True)
        for port in [urlparse(self.origins["standalone"]).port, self.model.server_port]:
            subprocess.run(adb + ["reverse", f"tcp:{port}", f"tcp:{port}"], check=True)
            self.addCleanup(subprocess.run, adb + ["reverse", "--remove", f"tcp:{port}"])
        browser = self.playwright.chromium.connect_over_cdp(os.environ["ZHIWU_ANDROID_CDP"],
                                                           no_defaults=True, timeout=20000)
        context = browser.contexts[0]
        page = context.new_page()
        self.addCleanup(page.close)
        self.run_flow("standalone", page, platform="android-chrome")

    @staticmethod
    def saved_android_value(page, kind, question=""):
        return page.evaluate("""async ({kind,question}) => {
            const request = indexedDB.open('zhiwu_on_device_db');
            const db = await new Promise((resolve,reject) => {
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            try {
                const read = db.transaction('kv').objectStore('kv').get('zhiwu_state_v1');
                const state = await new Promise((resolve,reject) => {
                    read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
                });
                if (kind === 'notes') return (state?.notes || []).map(({id,title}) => ({id,title}));
                if (kind === 'note') return state.notes.find(note => note.id === question);
                return Object.values(state.tutorMessages).find(messages => messages.some(m =>
                    m.role === 'user' && m.content === question)).filter(m => m.role === 'assistant').at(-1).content;
            } finally { db.close(); }
        }""", dict(kind=kind, question=question))

    @unittest.skipUnless(os.environ.get("ZHIWU_APK_CDP"), "Requires a disposable debug APK WebView")
    def test_android_apk(self):
        adb = [os.environ.get("ADB", "adb"), "-s", os.environ["ANDROID_SERIAL"]]
        port = self.model.server_port
        subprocess.run(adb + ["reverse", f"tcp:{port}", f"tcp:{port}"], check=True)
        self.addCleanup(subprocess.run, adb + ["reverse", "--remove", f"tcp:{port}"])
        page = self.apk_page()
        page.set_default_timeout(20000)
        self.assertEqual(page.evaluate("window.Capacitor?.getPlatform()"), "android")
        self.assertEqual(self.saved_android_value(page, "notes"), [], "The APK must use a disposable empty library")
        origin = page.evaluate("location.origin")
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("button", name="本地模型", exact=True).click()
        page.locator("div").filter(has=page.locator("label", has_text="API Base URL")).locator(
            "> input").fill(self.model_origin)
        page.get_by_role("button", name="保存并启用", exact=True).click()
        expect(page.get_by_text("已保存", exact=True)).to_be_visible()
        submit = page.get_by_role("button", name="确认导入", exact=True)
        page.get_by_role("button", name="导入", exact=True).click()
        page.locator('input[type=file][accept*=".pdf"]').set_input_files([
            dict(name=PDF_NAME + ".pdf", mimeType="application/pdf", buffer=base64.b64decode(self.pdf)),
            dict(name=BODY_NAME + ".txt", mimeType="text/plain", buffer=BODY_ORIGINAL.encode()),
        ])
        submit.click()
        expect(page.get_by_role("heading", name=PDF_NAME, exact=True)).to_be_visible(timeout=30000)
        notes = {n["title"]: n["id"] for n in self.saved_android_value(page, "notes")}
        self.check_answers("apk", page, origin, {"pdf": notes[PDF_NAME], "body": notes[BODY_NAME]})


if __name__ == "__main__":
    unittest.main()
