import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
let fixture;
let server;
let origin;
let db;
let initDatabase;
let configureTestModel;
let modelReply;

before(async () => {
  fixture = mkdtempSync(join(dist, 'notes-test-'));
  const compiled = join(fixture, 'server', 'dist');
  mkdirSync(compiled, { recursive: true });
  for (const name of readdirSync(dist)) {
    if (!name.startsWith('notes-test-')) cpSync(join(dist, name), join(compiled, name), { recursive: true });
  }

  const { initDatabase: initialize, DB_PATH, UPLOADS_DIR, db: database, getAISettings, saveAISettings } =
    await import(pathToFileURL(join(compiled, 'db.js')));
  db = database;
  initDatabase = initialize;
  const oldDb = new DatabaseSync(DB_PATH);
  oldDb.exec(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, summary_json TEXT,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, tags TEXT DEFAULT '[]',
    source_type TEXT DEFAULT 'markdown', source_filename TEXT, attachment_path TEXT,
    word_count INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  oldDb.close();
  initDatabase();

  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: '知悟 (Zhiwu)' }));
  app.post('/test-model/chat/completions', async (_req, res) => {
    const reply = await modelReply?.();
    res.json({ choices: [{ message: { content: reply || '测试回复' } }] });
  });
  for (const name of ['notes', 'settings', 'categories', 'dashboard', 'graph', 'tutor', 'quizzes', 'mistakes', 'flashcards']) {
    const routes = await import(pathToFileURL(join(compiled, 'routes', `${name}.js`)));
    app.use(`/api/${name}`, routes[`${name}Router`]);
  }
  app.use('/uploads', express.static(UPLOADS_DIR));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  configureTestModel = () => {
    const settings = getAISettings();
    settings.activeProviderId = 'local';
    settings.providers.find(({ id }) => id === 'local').baseUrl = `${origin}/test-model`;
    saveAISettings(settings);
  };
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

function pauseModel(t) {
  configureTestModel();
  const start = Promise.withResolvers();
  const finish = Promise.withResolvers();
  modelReply = () => {
    start.resolve();
    return finish.promise;
  };
  t.after(() => {
    finish.resolve();
    modelReply = undefined;
  });
  return { started: start.promise, reply: finish.resolve };
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

test('trashing a source note hides its live references and restoration brings them back', async () => {
  const first = await request('categories', { method: 'POST', body: { name: '已移除的学科' }, status: 201 });
  const second = await request('categories', { method: 'POST', body: { name: '仍有笔记的学科' }, status: 201 });
  const removed = await request('notes', { method: 'POST', body: { title: '删除测试', categoryId: first.id }, status: 201 });
  const retained = await request('notes', { method: 'POST', body: { title: '保留测试', categoryId: second.id }, status: 201 });
  const time = '2026-11-23T00:00:00.000Z';
  const concept = db.prepare(`INSERT INTO concepts (id, name, category_id, mastery_score, quiz_attempts, quiz_correct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  concept.run('only-removed', '独有知识点', first.id, 0.25, 1, 0, time);
  concept.run('shared-concept', '共享知识点', first.id, 0.5, 2, 1, time);
  const link = db.prepare(`INSERT INTO note_concepts (note_id, concept_id) VALUES (?, ?)`);
  link.run(removed.id, 'only-removed');
  link.run(removed.id, 'shared-concept');
  link.run(retained.id, 'shared-concept');
  db.prepare(`INSERT INTO concept_links (id, source_id, target_id) VALUES ('old-link', 'only-removed', 'shared-concept')`).run();
  const session = await request('tutor/sessions', { method: 'POST', body: { noteIds: [removed.id, retained.id] }, status: 201 });
  db.prepare(`INSERT INTO syntheses (id, title, note_ids, category_id, content, created_at) VALUES ('reference-report', '归纳', ?, ?, '已保存正文', ?)`)
    .run(JSON.stringify([removed.id, retained.id]), first.id, time);
  db.prepare(`INSERT INTO quizzes (id, title, source_note_ids, category_id, status, score, created_at, completed_at) VALUES ('reference-quiz', '做过的题', ?, ?, 'completed', 0, ?, ?)`)
    .run(JSON.stringify([removed.id, retained.id]), first.id, time, time);
  db.prepare(`INSERT INTO quiz_questions (id, quiz_id, note_id, type, stem, correct_answer) VALUES ('reference-question', 'reference-quiz', ?, 'single', '错题题干', 'A')`).run(removed.id);
  const mistake = await request('mistakes/bookmark', { method: 'POST', body: { questionId: 'reference-question' }, status: 201 });
  const card = await request('flashcards', { method: 'POST', body: {
    noteId: removed.id, categoryId: first.id, conceptName: '独有知识点', front: '闪卡问题', back: '答案',
  }, status: 201 });

  await request(`notes/${removed.id}`, { method: 'DELETE' });
  assert.ok(db.prepare(`SELECT id FROM notes WHERE id = ?`).get(removed.id));
  const trash = await request('notes/trash');
  const trashed = trash.find(({ id }) => id === removed.id);
  assert.equal(trashed.title, '删除测试');
  await request(`notes/${removed.id}`, { method: 'DELETE' });
  assert.deepEqual((await request('notes/trash')).find(({ id }) => id === removed.id), trashed);
  await request(`notes/${removed.id}`, { status: 404 });
  await request(`notes/${removed.id}`, { method: 'PUT', body: { title: '回收站内不可修改' }, status: 404 });
  await request('quizzes/generate', { method: 'POST', body: { noteIds: [removed.id] }, status: 400 });
  await request('flashcards/generate', { method: 'POST', body: { noteId: removed.id }, status: 404 });
  await request('notes/synthesize', { method: 'POST', body: { noteIds: [removed.id] }, status: 400 });
  const dashboard = await request('dashboard');
  assert.equal(dashboard.subjectMastery.some(({ id }) => id === first.id), false);
  assert.equal(dashboard.subjectMastery.find(({ id }) => id === second.id).mastery, 50);
  assert.deepEqual(dashboard.weakConcepts.map(({ id }) => id), ['shared-concept']);
  const graph = await request('graph');
  assert.deepEqual(graph.nodes.map(({ id }) => id), ['shared-concept']);
  assert.equal(graph.nodes[0].category_id, second.id);
  assert.deepEqual(graph.links, []);
  const chat = await request(`tutor/sessions/${session.id}/messages`);
  assert.deepEqual(chat.session.note_ids, [retained.id]);
  assert.equal(chat.messages.length, 1);
  assert.deepEqual((await request('notes/syntheses/list')).find(({ id }) => id === 'reference-report').note_ids, [retained.id]);
  const quiz = await request('quizzes/reference-quiz');
  assert.deepEqual(quiz.source_note_ids, [retained.id]);
  assert.equal(quiz.questions[0].note_id, null);
  assert.equal((await request('mistakes')).find(({ id }) => id === mistake.id).note_id, null);
  assert.equal((await request('flashcards')).find(({ id }) => id === card.id).note_id, null);
  assert.equal((await request(`flashcards?noteId=${removed.id}`)).length, 0);
  const queue = (await request('flashcards/queue')).items;
  assert.equal(queue.find(({ id }) => id === mistake.id).note_id, null);
  assert.equal(queue.find(({ id }) => id === card.id).note_id, null);
  const review = await request(`flashcards/${card.id}/review`, { method: 'POST', body: { rating: 3 } });
  assert.equal(review.card.note_id, null);
  assert.equal(review.card.repetitions, 1);

  await request(`notes/trash/${removed.id}/restore`, { method: 'POST' });
  const restored = await request(`notes/${removed.id}`);
  assert.equal(restored.id, removed.id);
  assert.equal(restored.deleted_at, null);
  assert.ok(restored.updated_at > removed.updated_at);
  await request(`notes/trash/${removed.id}/restore`, { method: 'POST' });
  assert.equal((await request(`notes/${removed.id}`)).updated_at, restored.updated_at);
  assert.deepEqual((await request(`tutor/sessions/${session.id}/messages`)).session.note_ids, [removed.id, retained.id]);
  assert.deepEqual((await request('notes/syntheses/list')).find(({ id }) => id === 'reference-report').note_ids, [removed.id, retained.id]);
  assert.equal((await request('quizzes/reference-quiz')).questions[0].note_id, removed.id);
  assert.equal((await request('mistakes')).find(({ id }) => id === mistake.id).note_id, removed.id);
  const restoredCard = (await request('flashcards')).find(({ id }) => id === card.id);
  assert.equal(restoredCard.note_id, removed.id);
  assert.equal(restoredCard.next_review_at, review.card.next_review_at);
  assert.equal((await request('graph')).nodes.find(({ id }) => id === 'shared-concept').note_count, 2);

  await request(`notes/trash/${removed.id}`, { method: 'DELETE', status: 404 });
  await request(`notes/${removed.id}`, { method: 'DELETE' });
  await request(`notes/trash/${removed.id}`, { method: 'DELETE' });
  assert.equal(db.prepare(`SELECT id FROM notes WHERE id = ?`).get(removed.id), undefined);
  assert.deepEqual(JSON.parse(db.prepare(`SELECT note_ids FROM tutor_sessions WHERE id = ?`).get(session.id).note_ids), [retained.id]);
  assert.equal(db.prepare(`SELECT note_id FROM flashcards WHERE id = ?`).get(card.id).note_id, null);
  assert.equal(db.prepare(`SELECT note_id FROM quiz_questions WHERE id = 'reference-question'`).get().note_id, null);

  const child = await request('categories', { method: 'POST', body: { name: '子分类', parentId: first.id }, status: 201 });
  await request(`categories/${first.id}`, { method: 'DELETE' });
  assert.equal((await request('categories')).find(({ id }) => id === child.id).parent_id, null);
  assert.equal((await request('quizzes/reference-quiz')).category_id, null);
  assert.equal((await request('flashcards')).find(({ id }) => id === card.id).category_id, null);
  await request('quizzes/reference-quiz', { method: 'DELETE' });
  assert.equal((await request('mistakes')).find(({ id }) => id === mistake.id).question_id, null);

  await request(`notes/${retained.id}`, { method: 'DELETE' });
  assert.deepEqual((await request(`tutor/sessions/${session.id}/messages`)).session.note_ids, []);
  assert.deepEqual((await request('dashboard')).subjectMastery, []);
  assert.deepEqual((await request('graph')).weakConcepts, []);
});

test('startup and backup restore repair references to records missing in old libraries', async () => {
  const time = '2026-11-23T00:00:00.000Z';
  db.prepare(`INSERT INTO tutor_sessions (id, title, note_ids, created_at, updated_at) VALUES ('unrepaired-session', '旧会话', ?, ?, ?)`)
    .run(JSON.stringify(['missing-note', 'restored-note', 'restored-note']), time, time);
  initDatabase();
  const session = await request('tutor/sessions/unrepaired-session/messages');
  assert.deepEqual(session.session.note_ids, ['restored-note']);
  assert.equal(db.prepare(`SELECT note_ids FROM tutor_sessions WHERE id = 'unrepaired-session'`).get().note_ids, '["restored-note"]');

  const backup = {
    notes: [{ id: 'backup-note', title: '旧备份笔记', category_id: 'missing-category' }],
    syntheses: [{ id: 'backup-report', content: '归纳正文', note_ids: ['missing-note', 'backup-note'] }],
    flashcards: [{ id: 'backup-card', front: '题面', back: '答案', note_id: 'missing-note' }],
    studyLogs: [{ id: 'backup-accuracy', activity_type: 'quiz_complete', date_key: '2026-11-22', score: 0.5 }],
  };
  await request('settings/import-json', { method: 'POST', body: backup });
  assert.equal((await request('notes/backup-note')).category_id, null);
  assert.deepEqual((await request('notes/syntheses/list')).find(({ id }) => id === 'backup-report').note_ids, ['backup-note']);
  assert.equal((await request('flashcards')).find(({ id }) => id === 'backup-card').note_id, null);
  assert.equal((await request('dashboard')).quizTrend.find(({ date }) => date === '2026-11-22').accuracy, 50);

  const card = await request('flashcards', { method: 'POST', body: { noteId: 'backup-note', front: '关联闪卡', back: '答案' }, status: 201 });
  await request('settings/import-json', { method: 'POST', body: {
    notes: [{ id: 'backup-note', title: '更新已有笔记', updated_at: '2030-01-01T00:00:00.000Z' }],
  } });
  assert.equal((await request('flashcards')).find(({ id }) => id === card.id).note_id, 'backup-note');

  const created = await request('tutor/sessions', { method: 'POST', body: { noteIds: ['missing-note', 'backup-note', 'backup-note'] }, status: 201 });
  assert.deepEqual(created.note_ids, ['backup-note']);
});

test('removing the note that asserted a graph relation leaves only the surviving co-occurrence', async () => {
  const first = await request('notes', { method: 'POST', body: { title: '关系来源笔记' }, status: 201 });
  const second = await request('notes', { method: 'POST', body: { title: '另有提及' }, status: 201 });
  const time = '2026-11-23T00:00:00.000Z';
  const insert = db.prepare(`INSERT INTO concepts (id, name, created_at) VALUES (?, ?, ?)`);
  insert.run('relation-a', '甲主题', time);
  insert.run('relation-b', '乙主题', time);
  for (const noteId of [first.id, second.id]) {
    db.prepare(`INSERT INTO note_concepts (note_id, concept_id) VALUES (?, 'relation-a'), (?, 'relation-b')`).run(noteId, noteId);
  }
  db.prepare(`UPDATE notes SET summary_json = ? WHERE id = ?`).run(JSON.stringify({
    relations: [{ source: '甲主题', target: '乙主题', relation: '旧有推导关系' }],
  }), first.id);
  db.prepare(`INSERT INTO concept_links (id, source_id, target_id, relation) VALUES ('legacy-assertion', 'relation-a', 'relation-b', '旧有推导关系')`).run();
  const relevant = (graph) => graph.links.filter(({ source, target }) => [source, target].includes('relation-a'));
  assert.deepEqual(relevant(await request('graph')).map(({ relation }) => relation), ['旧有推导关系']);
  await request(`notes/${first.id}`, { method: 'DELETE' });
  assert.deepEqual(relevant(await request('graph')).map(({ relation }) => relation), ['同篇共现']);
});

test('trashing a note during a tutor reply hides its reference until restoration', { timeout: 5000 }, async (t) => {
  const note = await request('notes', { method: 'POST', body: { title: '聊天时删除测试' }, status: 201 });
  const session = await request('tutor/sessions', { method: 'POST', body: { noteIds: [note.id] }, status: 201 });
  const model = pauseModel(t);
  const reply = request(`tutor/sessions/${session.id}/chat`, { method: 'POST', body: { message: '问题' } });
  await model.started;
  await request(`notes/${note.id}`, { method: 'DELETE' });
  model.reply('保存这次回答');
  await reply;
  const chat = await request(`tutor/sessions/${session.id}/messages`);
  assert.deepEqual(chat.session.note_ids, []);
  assert.equal(chat.messages.at(-1).content, '保存这次回答');
  // The picker sends only visible references when chatting while this note is in the trash.
  await request(`tutor/sessions/${session.id}/chat`, { method: 'POST', body: { message: '继续对话', noteIds: [] } });
  const other = await request('notes', { method: 'POST', body: { title: '新增参考笔记' }, status: 201 });
  await request(`tutor/sessions/${session.id}/chat`, { method: 'POST', body: { message: '参考新笔记', noteIds: [other.id] } });
  assert.deepEqual((await request(`tutor/sessions/${session.id}/messages`)).session.note_ids, [other.id]);
  await request(`notes/trash/${note.id}/restore`, { method: 'POST' });
  assert.deepEqual((await request(`tutor/sessions/${session.id}/messages`)).session.note_ids, [note.id, other.id]);
});

test('a tutor reply with unchanged selections preserves a newer selection', { timeout: 5000 }, async (t) => {
  const previous = await request('notes', { method: 'POST', body: { title: '之前参考的笔记' }, status: 201 });
  const next = await request('notes', { method: 'POST', body: { title: '新选的参考笔记' }, status: 201 });
  const session = await request('tutor/sessions', { method: 'POST', body: { noteIds: [previous.id] }, status: 201 });
  const model = pauseModel(t);
  const pending = request(`tutor/sessions/${session.id}/chat`, { method: 'POST', body: { message: '之前的问题' } });
  await model.started;
  modelReply = () => '针对新笔记的回答';
  await request(`tutor/sessions/${session.id}/chat`, { method: 'POST', body: { message: '新问题', noteIds: [next.id] } });
  model.reply('之前的回答');
  await pending;
  assert.deepEqual((await request(`tutor/sessions/${session.id}/messages`)).session.note_ids, [next.id]);
});

test('grading a quiz while its source is trashed preserves learning history and is safe to retry', { timeout: 5000 }, async (t) => {
  const note = await request('notes', { method: 'POST', body: { title: '批改时删除测试' }, status: 201 });
  const time = '2026-11-23T00:00:00.000Z';
  db.prepare(`INSERT INTO quizzes (id, title, source_note_ids, created_at) VALUES ('grading-quiz', '简答练习', ?, ?)`)
    .run(JSON.stringify([note.id]), time);
  db.prepare(`INSERT INTO quiz_questions (id, quiz_id, note_id, concept_name, type, stem, correct_answer)
    VALUES ('grading-question', 'grading-quiz', ?, '批改测试知识点', 'short', '问题', '答案')`).run(note.id);
  const model = pauseModel(t);
  const body = { answers: { 'grading-question': '作答' } };
  const pending = request('quizzes/grading-quiz/submit', { method: 'POST', body });
  await model.started;
  await request(`notes/${note.id}`, { method: 'DELETE' });
  model.reply(JSON.stringify({ score: 0, isCorrect: false, feedback: '点评' }));
  const result = await pending;
  assert.deepEqual(result.source_note_ids, []);
  assert.equal(result.questions[0].note_id, null);
  assert.equal(result.mistakesAdded, 1);
  assert.equal((await request('quizzes/grading-quiz/submit', { method: 'POST', body })).mistakesAdded, 0);
  const mistake = (await request('mistakes')).find(({ question_id }) => question_id === 'grading-question');
  assert.equal(mistake.note_id, null);
  assert.equal(mistake.wrong_count, 1);
  assert.equal((await request('dashboard')).weakConcepts.some(({ name }) => name === '批改测试知识点'), false);
  await request(`notes/trash/${note.id}/restore`, { method: 'POST' });
  assert.equal((await request('mistakes')).find(({ id }) => id === mistake.id).note_id, note.id);
  assert.equal((await request('dashboard')).weakConcepts.find(({ name }) => name === '批改测试知识点')?.quiz_attempts, 1);
});

test('original attachments and search survive trash and restoration', async () => {
  const original = Buffer.from('\uFEFF# 回收站附件\r\n\r\ntrash attachment search needle');
  const form = new FormData();
  form.append('files', new File([original], 'original.md', { type: 'text/markdown' }));
  form.set('tags', JSON.stringify(['trash-only-tag']));
  const { imported: [note] } = await request('notes/import', { method: 'POST', body: form, status: 201 });
  assert.ok(note.attachment_path);
  const readOriginal = async () => Buffer.from(await (await fetch(`${origin}${note.attachment_path}`)).arrayBuffer());
  assert.deepEqual(await readOriginal(), original);

  await request(`notes/${note.id}`, { method: 'DELETE' });
  assert.deepEqual(await readOriginal(), original);
  assert.deepEqual(await request(`notes?q=${encodeURIComponent('trash attachment search needle')}`), []);
  assert.equal((await request('notes/meta/tags')).some(({ name }) => name === 'trash-only-tag'), false);
  await request(`notes/trash/${note.id}/restore`, { method: 'POST' });
  const [restored] = await request(`notes?q=${encodeURIComponent('trash attachment search needle')}`);
  assert.equal(restored.id, note.id);
  assert.equal(restored.attachment_path, note.attachment_path);
  assert.deepEqual(await readOriginal(), original);

  const shared = await request('notes', { method: 'POST', body: { title: '共用原文件的笔记' }, status: 201 });
  db.prepare(`UPDATE notes SET attachment_path = ? WHERE id = ?`).run(note.attachment_path, shared.id);
  await request(`notes/${note.id}`, { method: 'DELETE' });
  await request(`notes/${shared.id}`, { method: 'DELETE' });
  await request(`notes/trash/${note.id}`, { method: 'DELETE' });
  assert.deepEqual(await readOriginal(), original);
  await request(`notes/trash/${shared.id}`, { method: 'DELETE' });
  const deleted = await fetch(`${origin}${note.attachment_path}`);
  assert.equal(deleted.status, 404);
  await deleted.body.cancel();
});

test('generating from a note deleted during AI inference saves no stale quiz', { timeout: 5000 }, async (t) => {
  const note = await request('notes', { method: 'POST', body: { title: '出题时删除测试' }, status: 201 });
  const existing = (await request('quizzes')).length;
  const model = pauseModel(t);
  const pending = request('quizzes/generate', { method: 'POST', body: { noteIds: [note.id] }, status: 409 });
  await model.started;
  await request(`notes/${note.id}`, { method: 'DELETE' });
  model.reply(JSON.stringify({ questions: [{ noteId: note.id, type: 'single', stem: '问题', correctAnswer: 'A' }] }));
  await pending;
  assert.equal((await request('quizzes')).length, existing);
});

const mcpScript = fileURLToPath(new URL('../mcp.mjs', import.meta.url));

test('the MCP adapter requires an explicit service address', () => {
  const result = spawnSync(process.execPath, [mcpScript], {
    env: { ...process.env, ZHIWU_URL: '' }, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ZHIWU_URL/);
  assert.equal(result.stdout, '');
});

test('the MCP tool saves Markdown in the configured library and returns its note link', { timeout: 10000 }, async () => {
  const client = new Client({ name: 'zhiwu-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [mcpScript], env: { ZHIWU_URL: origin, ZHIWU_ALLOW_READ: '0' },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), [
      'append_to_zhiwu_note', 'ensure_zhiwu_category', 'import_zhiwu_files', 'list_zhiwu_categories', 'save_to_zhiwu',
    ]);
    const title = '从外部 AI 保存的项目决策';
    const content = '# 决策\n\n```ts\nconst answer = 42;\n```\n';
    const result = await client.callTool({ name: 'save_to_zhiwu', arguments: { title, content } });
    assert.equal(Boolean(result.isError), false, JSON.stringify(result));
    const receipt = result.structuredContent;
    assert.equal(receipt.title, title);
    const link = new URL(receipt.url);
    assert.equal(link.origin, origin);
    assert.equal(link.searchParams.get('note'), receipt.id);
    assert(result.content.some((item) => item.type === 'text' && item.text.includes(link.href)));
    const note = await request(`notes/${encodeURIComponent(receipt.id)}`);
    assert.equal(note.title, title);
    assert.equal(note.content, content);
    assert.equal(note.source_type, 'markdown');
  } finally {
    await client.close();
  }
});

test('MCP tools can organize selected sources and read back the collected knowledge', { timeout: 15000 }, async () => {
  const importRoot = mkdtempSync(join(fixture, 'mcp-originals-'));
  const filename = 'résumé.md';
  const bytes = Buffer.from('\uFEFF# 原文件回归\r\n\r\n保留这些字节。\r\n');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+qv1sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(join(importRoot, filename), bytes);
  writeFileSync(join(importRoot, '资料图片.png'), imageBytes);
  const client = new Client({ name: 'zhiwu-workflow-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpScript], env: {
    ZHIWU_URL: origin, ZHIWU_ALLOW_READ: '1', ZHIWU_IMPORT_DIR: importRoot,
  } });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(Boolean(result.isError), false, JSON.stringify(result));
    return result.structuredContent;
  };
  try {
    await client.connect(transport);
    const categoryPath = ['外部知识', '记账小程序', '设计'];
    const [category, repeated] = await Promise.all([
      call('ensure_zhiwu_category', { categoryPath }), call('ensure_zhiwu_category', { categoryPath }),
    ]);
    assert.deepEqual(repeated, category);
    assert.deepEqual(category.categoryPath, categoryPath);
    const other = await call('ensure_zhiwu_category', { categoryPath: ['另一个项目', '设计'] });
    assert.notEqual(other.categoryId, category.categoryId);
    const listing = await call('list_zhiwu_categories', {});
    const leaf = listing.categories.find(({ id }) => id === category.categoryId);
    assert.deepEqual(leaf.categoryPath, categoryPath);
    assert.equal(listing.categories.find(({ id }) => id === leaf.parentId).name, '记账小程序');
    assert.equal(listing.categories.filter(({ categoryPath: path }) => path.join('/') === categoryPath.join('/')).length, 1);

    const saved = await call('save_to_zhiwu', { title: '记账设计记录', content: '这是保留的方案原文。', categoryPath, tags: ['设计记录'] });
    assert.equal(saved.categoryId, category.categoryId);
    const excerpt = '费用分类的对话摘录检索词';
    const appended = await call('append_to_zhiwu_note', { noteId: saved.id, excerptId: 'external-clip', content: excerpt });
    assert.equal(appended.excerptId, 'external-clip');
    await call('append_to_zhiwu_note', { noteId: saved.id, excerptId: 'external-clip', content: excerpt });
    const conflict = await client.callTool({ name: 'append_to_zhiwu_note', arguments: {
      noteId: saved.id, excerptId: 'external-clip', content: '另一份内容',
    } });
    assert.equal(conflict.isError, true);
    const needle = await call('search_zhiwu_notes', { query: '摘录检索词', categoryId: category.categoryId });
    assert.deepEqual(needle.notes.map(({ id }) => id), [saved.id]);
    assert(needle.notes[0].excerpt.includes(excerpt));
    const read = await call('read_zhiwu_note', { noteId: saved.id });
    assert.equal(read.content, '这是保留的方案原文。');
    assert.deepEqual(read.tags, ['设计记录']);
    assert.deepEqual(read.chatExcerpts.map(({ content }) => content), [excerpt]);

    const sourcePath = [...categoryPath.slice(0, -1), '参考资料'];
    const originals = await call('import_zhiwu_files', { paths: [filename, '资料图片.png'], categoryPath: sourcePath });
    assert.deepEqual(originals.warnings, []);
    assert.equal(originals.notes.length, 2);
    const original = await call('read_zhiwu_note', { noteId: originals.notes[0].id });
    assert.equal(original.sourceFilename, filename);
    const downloaded = await fetch(original.attachmentUrl);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    const image = await call('read_zhiwu_note', { noteId: originals.notes[1].id });
    assert.equal(image.sourceFilename, '资料图片.png');
    assert.deepEqual(Buffer.from(await (await fetch(image.attachmentUrl)).arrayBuffer()), imageBytes);

    const name = '旧库中的同名分类';
    await request('categories', { method: 'POST', body: { name }, status: 201 });
    const chosen = await request('categories', { method: 'POST', body: { name }, status: 201 });
    const ambiguous = await client.callTool({ name: 'ensure_zhiwu_category', arguments: { categoryPath: [name, '设计'] } });
    assert.equal(ambiguous.isError, true);
    const child = await call('ensure_zhiwu_category', { parentId: chosen.id, categoryPath: ['设计'] });
    const selected = await call('save_to_zhiwu', { title: '归入指定分支', content: '选中的同名分类', categoryId: child.categoryId });
    assert.equal(selected.categoryId, child.categoryId);
    assert.deepEqual(selected.categoryPath, [name, '设计']);
    assert.equal((await request('categories')).find(({ id }) => id === child.categoryId).parent_id, chosen.id);

    const count = (await request('categories')).length;
    await request('categories', { method: 'POST', body: { path: ['不会部分保存', ' '] }, status: 400 });
    assert.equal((await request('categories')).length, count);
  } finally {
    await client.close();
  }
});

test('today learning separates untested concepts and shows review and quiz progress', async () => {
  const category = await request('categories', { method: 'POST', body: { name: '今日学习学科' }, status: 201 });
  const note = await request('notes', { method: 'POST', body: { title: '今日学习笔记', categoryId: category.id }, status: 201 });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO concepts (id,name,mastery_score,quiz_attempts,quiz_correct,created_at)
    VALUES ('today-weak','专项知识点',.25,1,0,?), ('today-untested','刚提炼的知识点',.5,0,0,?)`).run(now, now);
  db.prepare(`INSERT INTO note_concepts (note_id,concept_id) VALUES (?,'today-weak'), (?,'today-untested')`).run(note.id, note.id);
  const baseline = await request('dashboard');
  assert.deepEqual(baseline.subjectMastery.filter(({ id }) => id === category.id)
    .map(({ mastery, concept_count, tested_count }) => [mastery, concept_count, tested_count]), [[25, 2, 1]]);
  assert(baseline.weakConcepts.some(({ id }) => id === 'today-weak'));
  assert(!baseline.weakConcepts.some(({ id }) => id === 'today-untested'));
  assert(baseline.untestedConcepts.some(({ id }) => id === 'today-untested'));

  configureTestModel();
  modelReply = () => JSON.stringify([1, 2, 3].map((index) => ({
    noteId: note.id, conceptName: '模型给出的别名', type: 'boolean', stem: `判断题 ${index}`, correctAnswer: '对',
  })));
  let quiz;
  try {
    quiz = await request('quizzes/generate', { method: 'POST', status: 201, body: {
      weakOnly: true, focusConcepts: ['专项知识点'], count: 3,
    } });
  } finally {
    modelReply = undefined;
  }
  assert.equal(quiz.questions.length, 3);
  assert(quiz.questions.every(({ concept_name }) => concept_name === '专项知识点'));
  const answers = Object.fromEntries(quiz.questions.map(({ id }) => [id, '对']));
  const graded = await request(`quizzes/${quiz.id}/submit`, { method: 'POST', body: { answers } });
  assert.deepEqual(graded.masteryChanges, [{ id: 'today-weak', name: '专项知识点', before: 25, after: 70 }]);
  const card = await request('flashcards', { method: 'POST', body: { front: '今日练习', back: '答案', noteId: note.id }, status: 201 });
  await request(`flashcards/${card.id}/review`, { method: 'POST', body: { rating: 3 } });
  await request(`flashcards/${card.id}/review`, { method: 'POST', body: { rating: 3 } });
  const after = (await request('dashboard')).todayProgress;
  assert.equal(after.reviewedCards, baseline.todayProgress.reviewedCards + 1);
  assert.equal(after.quizzesCompleted, baseline.todayProgress.quizzesCompleted + 1);
  assert(after.nextReviewAt > now);
});
