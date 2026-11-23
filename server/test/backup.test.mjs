import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import JSZip from 'jszip';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const fixtures = [];
const at = '2026-11-23T08:00:00.000Z';
const original = Buffer.from('%PDF-1.4\n原始文件\n');

async function openLibrary() {
  const folder = mkdtempSync(join(dist, 'notes-test-backup-'));
  const compiled = join(folder, 'server', 'dist');
  mkdirSync(compiled, { recursive: true });
  for (const unit of readdirSync(dist).filter((name) => !name.startsWith('notes-test-'))) {
    cpSync(join(dist, unit), join(compiled, unit), { recursive: true });
  }

  const { db, UPLOADS_DIR, initDatabase } = await import(pathToFileURL(join(compiled, 'db.js')));
  initDatabase();
  const app = express();
  const { backupsRouter } = await import(pathToFileURL(join(compiled, 'routes', 'backups.js')));
  const { categoriesRouter } = await import(pathToFileURL(join(compiled, 'routes', 'categories.js')));
  app.use(express.json());
  app.use('/api/backups', backupsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/uploads', express.static(UPLOADS_DIR));
  const server = app.listen(0, '127.0.0.1');
  fixtures.push({ folder, server, db });
  await once(server, 'listening');
  return { folder, origin: `http://127.0.0.1:${server.address().port}`, db, uploads: UPLOADS_DIR };
}

after(async () => {
  for (const { server, db, folder } of fixtures) {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    assert.match(basename(folder), /^notes-test-backup-/);
    assert.equal(dirname(folder), resolve(dist));
    rmSync(folder, { recursive: true, force: true });
  }
});

function upload(origin, action, bytes, name = 'backup.zip') {
  const body = new FormData();
  body.append('backup', new File([bytes], name));
  return fetch(`${origin}/api/backups/${action}`, { method: 'POST', body });
}

async function exportBackup(library) {
  const response = await fetch(`${library.origin}/api/backups`);
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

function seedLibrary({ db, uploads }) {
  db.prepare(`INSERT INTO categories (id, name, created_at) VALUES ('cat', '物理', ?)`).run(at);
  const insertNote = db.prepare(`INSERT INTO notes (id, title, content, source_content, chat_excerpts, category_id,
    source_type, source_filename, attachment_path, deleted_at, created_at, updated_at)
    VALUES (?, ?, '最新笔记', '原文文本', ?, 'cat', 'pdf', ?, ?, ?, ?, ?)`);
  insertNote.run('pdf', '带图表的资料', JSON.stringify([{ id: 'clip', content: '助教摘录', created_at: at }]), '图表.pdf', '/uploads/original.pdf', null, at, at);
  insertNote.run('trashed', '在回收站的资料', '[]', '找不到.pdf', '/uploads/missing.pdf', at, at, at);
  writeFileSync(join(uploads, 'original.pdf'), original);
  db.prepare(`INSERT INTO concepts (id, name, mastery_score, quiz_attempts, quiz_correct, created_at)
    VALUES ('concept', '重力', 0.75, 4, 3, ?)`).run(at);
  db.prepare(`INSERT INTO concepts (id, name, created_at) VALUES ('second-concept', '加速度', ?)`).run(at);
  db.exec(`INSERT INTO note_concepts (note_id, concept_id) VALUES ('trashed', 'concept')`);
  db.exec(`INSERT INTO concept_links (id, source_id, target_id, relation, weight)
    VALUES ('link', 'concept', 'second-concept', '影响', 0.8)`);
  db.prepare(`INSERT INTO syntheses (id, title, note_ids, content, created_at)
    VALUES ('analysis', '总结', '["pdf","trashed"]', '综合记录', ?)`).run(at);
  db.prepare(`INSERT INTO quizzes (id, title, source_note_ids, status, total_questions, score, created_at, completed_at)
    VALUES ('quiz', '练习', '["trashed"]', 'completed', 1, 1, ?, ?)`).run(at, at);
  db.exec(`INSERT INTO quiz_questions (id, quiz_id, note_id, type, stem, options_json, correct_answer, user_answer, is_correct)
    VALUES ('question', 'quiz', 'trashed', 'single', '题目', '["选项一"]', 'A', 'A', 1)`);
  db.prepare(`INSERT INTO flashcards (id, note_id, front, back, next_review_at, last_reviewed_at, repetitions, created_at, updated_at)
    VALUES ('card', 'trashed', '概念', '释义', ?, ?, 3, ?, ?)`).run(at, at, at, at);
  db.prepare(`INSERT INTO mistakes (id, question_id, note_id, type, stem, correct_answer, user_reflection, wrong_count, next_review_at, created_at, updated_at)
    VALUES ('mistake', 'question', 'trashed', 'single', '曾错的题', 'A', '我的反思', 5, ?, ?, ?)`).run(at, at, at);
  db.prepare(`INSERT INTO tutor_sessions (id, title, mode, note_ids, created_at, updated_at)
    VALUES ('chat', '辅导', 'qa', '["pdf","trashed"]', ?, ?)`).run(at, at);
  db.prepare(`INSERT INTO tutor_messages (id, session_id, role, content, created_at)
    VALUES ('reply', 'chat', 'assistant', '保留的回答', ?)`).run(at);
  db.prepare(`INSERT INTO study_logs (id, activity_type, entity_id, duration_seconds, score, created_at, date_key)
    VALUES ('activity', 'quiz_complete', 'quiz', 60, 1, ?, '2026-11-23')`).run(at);
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_settings', ?)`).run(JSON.stringify({ providers: [{ apiKey: 'fixture-token' }] }));
}

test('an archive preserves original files, the recycle bin, and study records across libraries', async () => {
  const source = await openLibrary();
  const target = await openLibrary();
  seedLibrary(source);
  const zipBytes = await exportBackup(source);
  const zip = await JSZip.loadAsync(zipBytes);
  const manifestText = await zip.file('manifest.json').async('string');
  assert.equal(manifestText.includes('fixture-token'), false);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.format, 'zhiwu-backup');
  assert.equal(manifest.version, 2);
  const attachment = manifest.attachments.find(({ noteId }) => noteId === 'pdf');
  assert.equal(attachment.mime, 'application/pdf');
  assert.deepEqual(await zip.file(attachment.path).async('nodebuffer'), original);
  assert.deepEqual(manifest.missingAttachments, [{ noteId: 'trashed', filename: '找不到.pdf' }]);

  const preview = await upload(target.origin, 'preview', zipBytes);
  assert.equal(preview.status, 200);
  const info = await preview.json();
  assert.equal(info.counts.trashedNotes, 1);
  assert.equal(info.counts.quizzes, 1);
  assert.equal(info.counts.attachments, 1);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);

  const restored = await upload(target.origin, 'restore', zipBytes);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).notesCount, 2);
  const pdfPath = target.db.prepare(`SELECT attachment_path FROM notes WHERE id = 'pdf'`).get().attachment_path;
  const opened = await fetch(`${target.origin}${pdfPath}`);
  assert.equal(opened.status, 200);
  assert.deepEqual(Buffer.from(await opened.arrayBuffer()), original);
  assert.equal(target.db.prepare(`SELECT deleted_at FROM notes WHERE id = 'trashed'`).get().deleted_at, at);
  assert.equal(target.db.prepare(`SELECT quiz_correct FROM concepts WHERE id = 'concept'`).get().quiz_correct, 3);
  assert.equal(target.db.prepare(`SELECT concept_id FROM note_concepts WHERE note_id = 'trashed'`).get().concept_id, 'concept');
  assert.equal(target.db.prepare(`SELECT user_answer FROM quiz_questions WHERE id = 'question'`).get().user_answer, 'A');
  assert.equal(target.db.prepare(`SELECT repetitions FROM flashcards WHERE id = 'card'`).get().repetitions, 3);
  assert.equal(target.db.prepare(`SELECT user_reflection FROM mistakes WHERE id = 'mistake'`).get().user_reflection, '我的反思');
  assert.equal(target.db.prepare(`SELECT content FROM tutor_messages WHERE id = 'reply'`).get().content, '保留的回答');
  assert.equal(target.db.prepare(`SELECT duration_seconds FROM study_logs WHERE id = 'activity'`).get().duration_seconds, 60);

  const repeat = await upload(target.origin, 'restore', zipBytes);
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).notesCount, 0);
  assert.deepEqual(readdirSync(target.uploads), [basename(pdfPath)]);
});

test('restore fills an unavailable file while retaining more recent note and card changes', async () => {
  const source = await openLibrary();
  const target = await openLibrary();
  seedLibrary(source);
  seedLibrary(target);
  const renamed = await fetch(`${source.origin}/api/categories/cat`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '现代物理' }),
  });
  assert.equal(renamed.status, 200);
  assert((await renamed.json()).updated_at > at);
  target.db.prepare(`UPDATE notes SET attachment_path = '/uploads/lost.pdf', title = '电脑后来改的标题', updated_at = '2026-11-24T08:00:00.000Z' WHERE id = 'pdf'`).run();
  target.db.prepare(`UPDATE flashcards SET repetitions = 8, updated_at = '2026-11-24T08:00:00.000Z' WHERE id = 'card'`).run();
  const restored = await upload(target.origin, 'restore', await exportBackup(source));
  assert.equal(restored.status, 200);
  const note = target.db.prepare(`SELECT title, attachment_path FROM notes WHERE id = 'pdf'`).get();
  assert.equal(note.title, '电脑后来改的标题');
  assert.deepEqual(readFileSync(join(target.uploads, basename(note.attachment_path))), original);
  assert.equal(target.db.prepare(`SELECT repetitions FROM flashcards WHERE id = 'card'`).get().repetitions, 8);
  assert.equal(target.db.prepare(`SELECT name FROM categories WHERE id = 'cat'`).get().name, '现代物理');
});

test('an archive with a missing indexed file cannot add records or write an attachment', async () => {
  const target = await openLibrary();
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    format: 'zhiwu-backup', version: 2, exportedAt: at,
    snapshot: { notes: [{ id: 'missing', title: '不应导入', content: '', created_at: at, updated_at: at }] },
    attachments: [{ noteId: 'missing', path: 'attachments/0.pdf', mime: 'application/pdf' }],
    missingAttachments: [],
  }));
  const restore = await upload(target.origin, 'restore', await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(restore.status, 400);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
  assert.deepEqual(readdirSync(target.uploads), []);
});

test('a restore that fails after staging an original rolls back records and files', async () => {
  const target = await openLibrary();
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    format: 'zhiwu-backup', version: 2, exportedAt: at,
    snapshot: {
      notes: [{ id: 'with-file', title: '不应导入', content: '', created_at: at, updated_at: at }],
      quizzes: [{ id: 'invalid-quiz', questions: [{ id: 'missing-fields' }] }],
    },
    attachments: [{ noteId: 'with-file', path: 'attachments/0.pdf', mime: 'application/pdf' }],
    missingAttachments: [],
  }));
  zip.file('attachments/0.pdf', original);
  const response = await upload(target.origin, 'restore', await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(response.status, 400);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
  assert.deepEqual(readdirSync(target.uploads), []);
  assert.deepEqual(readdirSync(join(dirname(target.uploads), 'backup-staging')), []);
});

test('a legacy JSON backup keeps notes and can restore embedded originals', async () => {
  const target = await openLibrary();
  const json = JSON.stringify({
    version: 1,
    notes: [{ id: 'legacy', title: '旧资料', source_type: 'pdf', source_filename: '旧资料.pdf',
      tags: ['标签'], content: '旧正文', attachment_path: `data:application/pdf;base64,${original.toString('base64')}`, created_at: at, updated_at: at }],
    tutorSessions: [{ id: 'legacy-chat', title: '旧对话', mode: 'qa', note_ids: ['legacy'], created_at: at, updated_at: at }],
    tutorMessages: { 'legacy-chat': [{ id: 'legacy-message', role: 'assistant', content: '旧消息', created_at: at }] },
  });
  const restore = await upload(target.origin, 'restore', Buffer.from(json), 'legacy.json');
  assert.equal(restore.status, 200);
  const note = target.db.prepare(`SELECT content, attachment_path FROM notes WHERE id = 'legacy'`).get();
  assert.equal(note.content, '旧正文');
  assert.deepEqual(readFileSync(join(target.uploads, basename(note.attachment_path))), original);
  assert.equal(target.db.prepare(`SELECT content FROM tutor_messages WHERE id = 'legacy-message'`).get().content, '旧消息');
});

test('an older format can update content without clearing the recycle-bin state or original metadata', async () => {
  const target = await openLibrary();
  seedLibrary(target);
  const legacy = JSON.stringify({ notes: [{
    id: 'trashed', title: '在旧版编辑过', content: '笔记正文', created_at: at, updated_at: '2026-11-24T08:00:00.000Z',
  }] });
  const result = await upload(target.origin, 'restore', Buffer.from(legacy), 'legacy.json');
  assert.equal(result.status, 200);
  const note = target.db.prepare(`SELECT title, deleted_at, source_filename, source_content FROM notes WHERE id = 'trashed'`).get();
  assert.equal(note.title, '在旧版编辑过');
  assert.equal(note.deleted_at, at);
  assert.equal(note.source_filename, '找不到.pdf');
  assert.equal(note.source_content, '原文文本');
});

test('restore keeps the existing concept ID and progress and connects restored notes and links to it', async () => {
  const source = await openLibrary();
  const target = await openLibrary();
  seedLibrary(source);
  target.db.prepare(`INSERT INTO concepts (id, name, quiz_attempts, quiz_correct, mastery_score, created_at)
    VALUES ('local-concept', '重力', 8, 7, 0.83, ?)`).run(at);
  const result = await upload(target.origin, 'restore', await exportBackup(source));
  assert.equal(result.status, 200);
  const concept = target.db.prepare(`SELECT * FROM concepts WHERE name = '重力'`).get();
  assert.equal(concept.id, 'local-concept');
  assert.equal(concept.quiz_attempts, 8);
  assert.equal(concept.quiz_correct, 7);
  assert.equal(target.db.prepare(`SELECT concept_id FROM note_concepts WHERE note_id = 'trashed'`).get().concept_id, concept.id);
  assert.equal(target.db.prepare(`SELECT source_id FROM concept_links WHERE id = 'link'`).get().source_id, concept.id);
});

test('desktop archives keep the same study data and original bytes after passing through the Android backup adapter', async (t) => {
  const client = new URL('../../client/', import.meta.url);
  const requireClient = createRequire(new URL('package.json', client));
  let vitePath;
  try {
    vitePath = requireClient.resolve('vite');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    t.skip('Install the client dependencies to test Android archive compatibility');
    return;
  }
  const viteModule = await import(pathToFileURL(vitePath));
  const source = await openLibrary();
  const target = await openLibrary();
  seedLibrary(source);
  const desktopZip = await exportBackup(source);
  const vite = await (viteModule.createServer ?? viteModule.default.createServer)({
    root: fileURLToPath(client), configFile: false, cacheDir: join(source.folder, 'vite-cache'),
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { readOfflineBackup, createOfflineBackup } = await vite.ssrLoadModule('/src/api/backupArchive.ts');
    const androidBackup = await readOfflineBackup(new File([desktopZip], 'desktop.zip'), true);
    const { blob } = await createOfflineBackup(androidBackup.snapshot);
    const restored = await upload(target.origin, 'restore', await blob.arrayBuffer());
    assert.equal(restored.status, 200);
    const sourceManifest = JSON.parse(await (await JSZip.loadAsync(desktopZip)).file('manifest.json').async('string'));
    const targetManifest = JSON.parse(await (await JSZip.loadAsync(await exportBackup(target))).file('manifest.json').async('string'));
    assert.deepEqual(targetManifest.snapshot, sourceManifest.snapshot);
    assert.deepEqual(targetManifest.missingAttachments, sourceManifest.missingAttachments);
    const pdfPath = target.db.prepare(`SELECT attachment_path FROM notes WHERE id = 'pdf'`).get().attachment_path;
    const opened = await fetch(`${target.origin}${pdfPath}`);
    assert.equal(opened.status, 200);
    assert.deepEqual(Buffer.from(await opened.arrayBuffer()), original);
  } finally {
    await vite.close();
  }
});
