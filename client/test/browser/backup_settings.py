"""Run after building server/dist. Uses Playwright, temporary SQLite and fresh IndexedDB."""
from io import BytesIO
import json
from pathlib import Path
import re
import unittest
from urllib.parse import urlsplit
from zipfile import ZipFile

from playwright.sync_api import expect
from tutor_retrieval import TutorBrowserTest


class BackupSettingsTest(TutorBrowserTest):
    def settings(self, platform, *, older_android=False):
        width = 1280 if platform == "desktop" else 390
        context = self.browser.new_context(viewport={"width": width, "height": 820})
        self.addCleanup(context.close)
        if older_android:
            context.add_init_script("""window.androidBridge = {}; window.Capacitor = { PluginHeaders: [] };
                Object.defineProperty(window, 'showSaveFilePicker', {value: undefined, configurable: true});
                Object.defineProperty(navigator, 'share', {value: undefined, configurable: true});""")
        page = context.new_page()
        page.goto(self.origins[platform])
        page.get_by_role("button", name="设置", exact=True).click()
        panel = page.get_by_role("region", name="完整备份", exact=True)
        expect(panel).to_be_visible()
        return page, panel

    def assert_backup_actions(self, page, panel):
        for label in ["导出完整备份", "选择备份恢复", "局域网快传"]:
            expect(panel.get_by_role("button", name=label, exact=True)).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("快传|扫码"))).to_have_count(1)

    def import_note(self, page, title):
        note = dict(title=title, filename=title + ".txt", body=title + "的批注。",
                    source=title + "的原文件。\r\n第二行含有 π。\n")
        note["id"] = page.evaluate("""async ({title, filename, source, body}) => {
            const {api} = await import('/src/api/client.ts');
            const {imported, warnings} = await api.importFiles([new File([source], filename, {type:'text/plain'})]);
            if (warnings.length || imported.length !== 1) throw Error('Fixture import failed: ' + warnings);
            return (await api.updateNote(imported[0].id, {title, content:body})).id;
        }""", note)
        return note

    def note_ids(self, page):
        return page.evaluate("""async () => {
            const {api} = await import('/src/api/client.ts');
            return (await api.getNotes()).map(note => note.id).sort();
        }""")

    def download(self, page, control):
        with page.expect_download() as result:
            control.click()
        download = result.value
        self.assertIsNone(download.failure())
        return download

    def check_zip(self, filename, file, sample):
        self.assertRegex(filename, r"^zhiwu-backup-\d{4}-\d{2}-\d{2}\.zip$")
        with ZipFile(file) as archive:
            self.assertIsNone(archive.testzip())
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["format"], "zhiwu-backup")
            notes = {note["id"]: note for note in manifest["snapshot"]["notes"]}
            note = notes[sample["id"]]
            self.assertEqual((note["title"], note["content"], note["source_filename"]),
                             (sample["title"], sample["body"], sample["filename"]))
            attachment = next(item for item in manifest["attachments"] if item["noteId"] == sample["id"])
            self.assertEqual(archive.read(attachment["path"]), sample["source"].encode())
            return sorted(notes)

    def test_desktop_zip_restores_twice_in_a_fresh_offline_library(self):
        desktop, commands = self.settings("desktop")
        self.assert_backup_actions(desktop, commands)
        note = self.import_note(desktop, "桌面备份样例")
        archive = self.download(desktop, commands.get_by_role("button", name="导出完整备份"))
        expected_ids = self.check_zip(archive.suggested_filename, archive.path(), note)
        phone, restore = self.settings("standalone")
        self.assert_backup_actions(phone, restore)
        self.assertEqual(self.note_ids(phone), [])

        for attempt in range(2):
            with phone.expect_file_chooser() as chooser:
                restore.get_by_role("button", name="选择备份恢复").click()
            chooser.value.set_files(dict(name=archive.suggested_filename, mimeType="application/zip",
                                         buffer=Path(archive.path()).read_bytes()))
            expect(restore.get_by_role("heading", name="恢复预览")).to_be_visible()
            expect(restore.get_by_text(archive.suggested_filename, exact=True)).to_be_visible()
            self.assertEqual(self.note_ids(phone), [] if attempt == 0 else expected_ids)
            if attempt:
                expect(restore.get_by_text(re.compile(r"有 [1-9]\d* 条记录已存在"))).to_be_visible()
            restore.get_by_role("button", name="确认恢复").click()
            expect(restore.get_by_role("status")).to_contain_text("恢复完成")
            self.assertEqual(self.note_ids(phone), expected_ids)

        phone.goto(self.origins["standalone"] + "/?note=" + note["id"])
        expect(phone.get_by_role("heading", name=note["title"], exact=True)).to_be_visible()
        expect(phone.get_by_text(note["body"], exact=True)).to_be_visible()
        phone.get_by_text("查看原文", exact=True).click()
        original = self.download(phone, phone.get_by_role("link", name="下载原文件"))
        self.assertEqual(original.suggested_filename, note["filename"])
        self.assertEqual(Path(original.path()).read_bytes(), note["source"].encode())

    def open_transfer(self, page, panel, name):
        panel.get_by_role("button", name="局域网快传", exact=True).click()
        modal = page.get_by_role("dialog", name=name, exact=True)
        expect(modal).to_be_visible()
        return modal

    def loopback_link(self, desktop_modal):
        # The service advertises a LAN interface. The disposable fixture listens on loopback.
        url = urlsplit(desktop_modal.get_by_label("快传链接").input_value())
        desktop = self.origins["desktop"]
        self.assertEqual(url.port, urlsplit(desktop).port)
        self.assertRegex(url.path, r"^/api/transfer/(?:backup/[0-9a-f]{32}|[0-9a-f]{12})$")
        return desktop + url.path

    def test_phone_sends_its_zip_to_the_desktop_receiver(self):
        desktop, panel = self.settings("desktop")
        self.assert_backup_actions(desktop, panel)
        receiver = self.open_transfer(desktop, panel, "手机与电脑快传")
        receiver.get_by_role("button", name="接收备份").click()
        expect(receiver.get_by_role("img", name="备份接收二维码")).to_be_visible()
        url = self.loopback_link(receiver)

        phone, actions = self.settings("standalone")
        self.assert_backup_actions(phone, actions)
        note = self.import_note(phone, "手机备份样例")
        scanner = self.open_transfer(phone, actions, "局域网快传")
        scanner.get_by_label("快传链接").fill(url)
        connect = scanner.get_by_role("button", name="连接")
        requests = []
        phone.on("request", lambda req: requests.append(req.method) if req.url == url else None)
        with phone.expect_event("dialog", predicate=lambda dialog: dialog.type == "confirm") as cancelled:
            phone.once("dialog", lambda dialog: dialog.dismiss())
            connect.click()
        self.assertIn(urlsplit(url).netloc, cancelled.value.message)
        self.assertEqual(requests, [])
        expect(receiver.get_by_role("link", name="下载完整备份")).to_have_count(0)
        phone.once("dialog", lambda dialog: dialog.accept())
        connect.click()
        expect(scanner.get_by_role("status")).to_contain_text("已发送")
        expect(receiver.get_by_role("status")).to_contain_text("已收到手机备份")
        self.assertEqual(requests, ["GET", "PUT"])
        archive = self.download(desktop, receiver.get_by_role("link", name="下载完整备份"))
        self.assertEqual(self.check_zip(archive.suggested_filename, archive.path(), note), [note["id"]])

    def test_phone_scanner_imports_files_and_syncs_notes(self):
        desktop, panel = self.settings("desktop")
        note = self.import_note(desktop, "等待同步的桌面笔记")
        sender = self.open_transfer(desktop, panel, "手机与电脑快传")
        sender.get_by_role("button", name="传送文件", exact=True).click()
        with desktop.expect_file_chooser() as chooser:
            sender.get_by_role("button", name=re.compile("选择要传给手机")).click()
        filename = "局域网文件样例.txt"
        chooser.value.set_files(dict(name=filename, mimeType="text/plain", buffer="局域网文件原件。".encode()))
        expect(sender.get_by_text(re.compile(re.escape(filename)))).to_be_visible()
        phone, actions = self.settings("standalone")
        for operation, expected in [("files", "成功扫码导入 1 篇笔记"), ("sync", "同步完成")]:
            if operation == "sync":
                sender.get_by_role("button", name="同步笔记", exact=True).click()
            scanner = self.open_transfer(phone, actions, "局域网快传")
            scanner.get_by_label("快传链接").fill(self.loopback_link(sender))
            scanner.get_by_role("button", name="连接").click()
            expect(scanner.get_by_role("status")).to_contain_text(expected)
            expect(scanner).to_be_hidden()
        self.assertIn(note["id"], self.note_ids(phone))
        filenames = phone.evaluate("""async () => (await (await import('/src/api/client.ts')).api.getNotes())
            .map(note => note.source_filename)""")
        self.assertIn(filename, filenames)

    def test_older_android_keeps_separate_export(self):
        page, panel = self.settings("standalone", older_android=True)
        self.assertEqual(page.evaluate("window.Capacitor.getPlatform()"), "android")
        self.assertFalse(page.evaluate("window.Capacitor.isPluginAvailable('ZhiwuBackupSave')"))
        self.assert_backup_actions(page, panel)
        panel.get_by_role("button", name="导出完整备份").click()
        expect(panel.get_by_role("alert")).to_contain_text("局域网快传")
        expect(page.get_by_role("dialog")).to_have_count(0)

    def test_older_android_cancelled_picker_explains_how_to_export(self):
        page, panel = self.settings("standalone", older_android=True)
        page.evaluate("""() => Object.defineProperty(window, 'showSaveFilePicker', {value: async () => {
            throw new DOMException('User cancelled', 'AbortError');
        }})""")
        export = panel.get_by_role("button", name="导出完整备份")
        export.click()
        feedback = panel.get_by_role("status")
        expect(feedback).to_contain_text("备份尚未保存")
        expect(feedback).to_contain_text("局域网快传")
        expect(export).to_be_enabled()
        expect(page.get_by_role("dialog")).to_have_count(0)

    def test_older_android_prepares_a_zip_then_shares_on_a_fresh_tap(self):
        page, panel = self.settings("standalone", older_android=True)
        note = self.import_note(page, "分享备份样例")
        page.evaluate("""() => {
            window.sharedBackups = [];
            Object.defineProperty(navigator, 'canShare', {value: ({files}) =>
                files?.length === 1 && files[0] instanceof File && files[0].type === 'application/zip'});
            Object.defineProperty(navigator, 'share', {value: async ({files}) => {
                if (!navigator.userActivation.isActive) throw new DOMException('Tap required', 'NotAllowedError');
                window.sharedBackups.push(files[0]);
                if (window.sharedBackups.length === 1) throw new DOMException('User cancelled', 'AbortError');
            }});
        }""")
        export = panel.get_by_role("button", name="导出完整备份")
        share = panel.get_by_role("button", name="保存或分享 ZIP")
        export.click()
        expect(share).to_be_enabled()
        self.assertEqual(page.evaluate("window.sharedBackups.length"), 0)
        share.click()
        expect(share).to_be_enabled()
        self.assertEqual(page.evaluate("window.sharedBackups.length"), 1)
        share.click()
        expect(panel.get_by_role("status")).to_contain_text("备份已交给所选应用")
        expect(export).to_be_enabled()
        self.assertEqual(page.evaluate("window.sharedBackups.length"), 2)
        shared = page.evaluate("""async () => {
            const file = window.sharedBackups[1];
            return {name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer()))};
        }""")
        self.assertEqual(self.check_zip(shared["name"], BytesIO(bytes(shared["bytes"])), note), [note["id"]])


if __name__ == "__main__":
    unittest.main()
