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

test('deleting a source note removes live references and preserves shared concepts and saved work', async () => {
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
  const card = await request('flashcards', { method: 'POST', body: { noteId: removed.id, categoryId: first.id, front: '闪卡问题', back: '答案' }, status: 201 });

  await request(`notes/${removed.id}`, { method: 'DELETE' });
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
  assert.equal((await request('flashcards/queue')).items.some(({ id }) => id === mistake.id), true);

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

test('deleting a note during a tutor reply keeps the chat and drops the reference', { timeout: 5000 }, async (t) => {
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
});

test('grading an existing quiz after source deletion detaches the wrong answer and is safe to retry', { timeout: 5000 }, async (t) => {
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
