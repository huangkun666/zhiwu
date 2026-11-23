import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
let fixture;
let server;
let origin;
let db;

before(async () => {
  fixture = mkdtempSync(join(dist, 'notes-test-'));
  const compiled = join(fixture, 'server', 'dist');
  mkdirSync(compiled, { recursive: true });
  for (const name of readdirSync(dist)) {
    if (!name.startsWith('notes-test-')) cpSync(join(dist, name), join(compiled, name), { recursive: true });
  }

  const { initDatabase, DB_PATH, UPLOADS_DIR, db: database } = await import(pathToFileURL(join(compiled, 'db.js')));
  db = database;
  const oldDb = new DatabaseSync(DB_PATH);
  oldDb.exec(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, summary_json TEXT,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, tags TEXT DEFAULT '[]',
    source_type TEXT DEFAULT 'markdown', source_filename TEXT, attachment_path TEXT,
    word_count INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  oldDb.close();
  initDatabase();

  const { notesRouter } = await import(pathToFileURL(join(compiled, 'routes', 'notes.js')));
  const { settingsRouter } = await import(pathToFileURL(join(compiled, 'routes', 'settings.js')));
  const app = express();
  app.use(express.json());
  app.use('/api/notes', notesRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/uploads', express.static(UPLOADS_DIR));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

async function request(path, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(`${origin}/api/${path}`, {
    method,
    body: body instanceof FormData ? body : JSON.stringify(body),
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

test('imported source stays searchable without filling the editable body', async () => {
  const source = '# 自测资料\n\n正文里的查找词是清醒专注。';
  const form = new FormData();
  form.append('files', new File([source], 'study.md', { type: 'text/markdown' }));
  const { imported: [note] } = await request('notes/import', { method: 'POST', body: form, status: 201 });
  assert.equal(note.content, '');
  assert.equal(note.source_content, source);
  assert.ok(note.word_count > 0);

  const updated = await request(`notes/${note.id}`, { method: 'PUT', body: { content: '我自己的想法。' } });
  assert.equal(updated.source_content, source);
  assert.equal(updated.content, '我自己的想法。');
  const matches = await request(`notes?q=${encodeURIComponent('清醒专注')}`);
  assert.deepEqual(matches.map((match) => match.id), [note.id]);
});

test('an appended reply can be removed by ID after later appends and edits', async () => {
  const note = await request('notes', { method: 'POST', body: { title: '自测笔记', content: '原有正文' }, status: 201 });
  const first = `notes/${note.id}/chat-excerpts/reply-1`;
  await request(first, { method: 'PUT', body: { content: '移除目标只此一处' } });
  await request(first, { method: 'PUT', body: { content: '移除目标只此一处' } });
  await request(`notes/${note.id}/chat-excerpts/reply-2`, { method: 'PUT', body: { content: '保留之后的追加' } });
  await request(`notes/${note.id}`, { method: 'PUT', body: { content: '后来编辑过的正文' } });
  const reopened = await request(`notes/${note.id}`);
  assert.deepEqual(reopened.chat_excerpts.map((excerpt) => excerpt.id), ['reply-1', 'reply-2']);
  const matches = await request(`notes?q=${encodeURIComponent('目标只此')}`);
  assert.equal(matches[0].id, note.id);

  await request(first, { method: 'DELETE' });
  const undone = await request(first, { method: 'DELETE' });
  assert.equal(undone.content, '后来编辑过的正文');
  assert.deepEqual(undone.chat_excerpts.map((excerpt) => excerpt.content), ['保留之后的追加']);
  assert.deepEqual(await request(`notes?q=${encodeURIComponent('目标只此')}`), []);
});

test('legacy undo requires the saved reply and preserves text added after it', async () => {
  const first = '\n\n---\n\n### 费曼助教延伸笔记（2026/11/23）\n\n一段旧回复';
  const second = '\n\n---\n\n### 费曼助教延伸笔记（2026/11/23）\n\n另一段旧回复';
  const original = '旧版笔记';
  const manual = '\n\n我后来手写的文字';
  const time = '2026-11-23T00:00:00.000Z';
  db.prepare(`INSERT INTO tutor_sessions (id, title, mode, created_at, updated_at) VALUES ('old-session', '旧对话', 'qa', ?, ?)`)
    .run(time, time);
  db.prepare(`INSERT INTO tutor_messages (id, session_id, role, content, created_at) VALUES ('old-reply', 'old-session', 'assistant', '一段旧回复', ?)`)
    .run(time);
  const note = await request('notes', { method: 'POST', body: { title: '旧版笔记', content: original + first + manual + second }, status: 201 });
  const removal = `notes/${note.id}/legacy-chat-excerpts/${original.length}`;
  const updatedAt = note.updated_at;
  await request(removal, { method: 'DELETE', body: { block: first, updatedAt }, status: 409 });
  const unverified = `notes/${note.id}/legacy-chat-excerpts/${(original + first + manual).length}`;
  await request(unverified, { method: 'DELETE', body: { block: second, updatedAt }, status: 409 });
  const undone = await request(removal, { method: 'DELETE', body: { block: first + manual, updatedAt } });
  assert.equal(undone.content, original + manual + second);

  const duplicates = await request('notes', { method: 'POST', body: { title: '曾重复追加', content: original + first + first }, status: 201 });
  const duplicateRemoval = `notes/${duplicates.id}/legacy-chat-excerpts/${original.length}`;
  const body = { block: first, updatedAt: duplicates.updated_at };
  assert.equal((await request(duplicateRemoval, { method: 'DELETE', body })).content, original + first);
  await request(duplicateRemoval, { method: 'DELETE', body, status: 409 });
  assert.equal((await request(`notes/${duplicates.id}`)).content, original + first);
});

test('JSON backups keep imported source and individual chat excerpts', async () => {
  const note = {
    id: 'restored-note', title: '备份往返', content: '笔记正文',
    source_type: 'pdf', source_filename: 'backup.pdf', source_content: '备份原文查找词',
    chat_excerpts: [{ id: 'restored-reply', content: '备份聊天', created_at: '2026-11-23T00:00:00.000Z' }],
  };
  await request('settings/import-json', { method: 'POST', body: { notes: [note] } });
  const { notes } = await request('settings/export-json');
  const restored = notes.find(({ id }) => id === note.id);
  assert.equal(restored.source_content, note.source_content);
  assert.deepEqual(restored.chat_excerpts, note.chat_excerpts);
  assert.equal((await request(`notes?q=${encodeURIComponent('原文查找词')}`))[0].id, note.id);
});
