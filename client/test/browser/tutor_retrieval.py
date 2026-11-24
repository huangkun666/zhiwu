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


def field_entry(number):
    return (f"The inspector recorded visit {number} in the field ledger. "
            "The morning review included the instrument housing, documentation envelope and serial plate. "
            "After the inspection the team filed the worksheet and reviewed the schedule with the next shift.")


class Witness:
    """Echo a previously unseen nonce only after a search and adjacent-unit read return it."""
    def __init__(self, key, answer):
        self.key = key
        self.answer = answer
        self.steps = []
        self.errors = []
        self.hit = None
        self.final_stream = None

    def respond(self, body):
        prompt = "\n".join(m["content"] for m in body["messages"])
        if "ZHIWU_RETRIEVE" in body["messages"][0]["content"]:
            state = json.loads(body["messages"][-1]["content"])
            if not self.steps:
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
            assert self.steps == ["search", "read"], self.steps
            assert self.answer in state["results"][-1], "Adjacent-unit read did not return the actual answer"
            self.steps.append("finish")
            return json.dumps(dict(action="finish"))

        assert self.steps == ["search", "read", "finish"], self.steps
        evidence = list(re.finditer(r"(?m)^\s*\[(S\d+)\]\s*N\d+\s+#\d+[^\n]*\n", prompt))
        for i, header in enumerate(evidence):
            end = evidence[i + 1].start() if i + 1 < len(evidence) else len(prompt)
            answer = re.search(r"\b[A-Z]{2}-[A-F0-9]{12}\b", prompt[header.end():end])
            if answer and answer.group() == self.answer:
                self.final_stream = bool(body.get("stream"))
                self.steps.append("answer")
                return f"The recorded value is {answer.group()}. [{header[1]}]"
        raise AssertionError("Final context did not associate the answer with an evidence ID")


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


class TutorRetrievalTest(TutorBrowserTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pdf_answer = "OP-" + secrets.token_hex(6).upper()
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
            const imported = await api.importFiles([new File([binary], args.pdfName + '.pdf', {type:'application/pdf'})]);
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
            const pdf = imported.imported[0];
            const body = await api.createNote({title: args.bodyName, content: args.body});
            if (!pdf.source_content.includes(args.pdfAnswer)) throw Error('PDF text extraction lost the value');
            return {pdf:pdf.id, body:body.id};
        }""", dict(offline=standalone, model=self.model_origin, pdf=self.pdf, pdfName=PDF_NAME,
                   bodyName=BODY_NAME, body=self.body, pdfAnswer=self.pdf_answer))
        self.check_answers(platform or mode, page, origin, note_ids)

    def check_answers(self, mode, page, origin, note_ids):
        stream_responses = []
        page.on("response", lambda r: stream_responses.append(r) if "/chat-stream" in r.url else None)
        mobile = mode != "desktop"
        for kind, title, key, answer, question in [
            ("pdf", PDF_NAME, PDF_KEY, self.pdf_answer, "夜班的光学校准值是多少？请核对手册原文。"),
            ("body", BODY_NAME, BODY_KEY, self.body_answer, "交接用的验收码是什么？请打开现场记录核实。"),
        ]:
            with self.subTest(mode=mode, source=kind):
                page.goto(origin)
                page.get_by_role("button", name="助教", exact=True).click()
                page.get_by_role("button", name="新建对话", exact=True).click()
                dialog = page.get_by_role("dialog", name="新建对话", exact=True)
                dialog.get_by_role("radio", name="深度答疑", exact=True).check()
                dialog.get_by_role("button", name="创建对话", exact=True).click()
                messages = page.get_by_role("region", name="对话消息")
                if kind == "body":
                    picker = page.get_by_role("button", name=re.compile("参考笔记"))
                    picker.click()
                    page.get_by_role("button", name=title, exact=True).click()
                    picker.click()
                self.model.witness = witness = Witness(key, answer)
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
                if not mobile:
                    self.assertTrue(witness.final_stream)
                    response = stream_responses[-1]
                    self.assertIn("text/event-stream", response.headers["content-type"])
                    self.assertIn('"delta"', response.text())
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
                opened_at = monotonic()
                citation.click()
                if kind == "pdf":
                    self.assertEqual(params.get("page"), [str(PDF_PAGE)])
                    expect(page.get_by_role("img", name=f"PDF 第 {PDF_PAGE} 页", exact=True)).to_be_visible()
                    expect(page.get_by_text(f"第 {PDF_PAGE} / 32 页", exact=True)).to_be_visible()
                else:
                    expect(page.locator("mark[data-source-target]").filter(has_text=answer)).to_be_in_viewport()
                open_seconds = monotonic() - opened_at
                page.get_by_role("button", name="返回对话").click()
                expect(messages.get_by_role("link", name=re.compile(title))).to_be_visible()
                print(f"{mode}/{kind} answer {reply_seconds:.2f}s, source opened {open_seconds:.2f}s, "
                      f"{len(witness.steps)} model calls", flush=True)

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
        page.locator('input[type=file][accept*=".pdf"]').set_input_files(dict(
            name=PDF_NAME + ".pdf", mimeType="application/pdf", buffer=base64.b64decode(self.pdf)))
        submit.click()
        expect(submit).to_be_hidden(timeout=30000)
        page.get_by_role("button", name="导入", exact=True).click()
        page.get_by_role("button", name="粘贴 / 随手记").click()
        page.get_by_placeholder("例如：操作系统进程调度笔记").fill(BODY_NAME)
        page.get_by_placeholder("粘贴学习笔记或记录你的思考...").fill(self.body)
        submit.click()
        expect(submit).to_be_hidden()
        notes = {n["title"]: n["id"] for n in self.saved_android_value(page, "notes")}
        self.check_answers("apk", page, origin, {"pdf": notes[PDF_NAME], "body": notes[BODY_NAME]})


if __name__ == "__main__":
    unittest.main()
