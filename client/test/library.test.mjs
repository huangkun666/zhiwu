import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('the offline library clears deleted note references and keeps saved learning records', { timeout: 10000 }, async () => {
  const time = '2024-01-01T00:00:00.000Z';
  const oldLibrary = {
    categories: [
      { id: 'empty', name: '空学科', color: '#3B5BDB', created_at: time },
      { id: 'live', name: '有效学科', color: '#0F766E', created_at: time },
    ],
    notes: [{ id: 'live-note', title: '有效笔记', content: '', tags: [], category_id: 'live', created_at: time, updated_at: time }],
    concepts: [
      { id: 'dead-concept', name: '旧知识点', category_id: 'empty', note_ids: ['deleted-note'], mastery_score: 0.25, quiz_attempts: 1, quiz_correct: 0 },
      { id: 'shared', name: '共享知识点', category_id: 'empty', note_ids: ['deleted-note', 'live-note'], mastery_score: 0.5, quiz_attempts: 2, quiz_correct: 1 },
      { id: 'cooccurs', name: '同篇知识点', category_id: 'live', note_ids: ['deleted-note', 'live-note'], mastery_score: 0.5, quiz_attempts: 0, quiz_correct: 0 },
    ],
    conceptLinks: [
      { id: 'dead-link', source: 'dead-concept', target: 'shared', relation: '相关' },
      { id: 'old-assertion', source: 'shared', target: 'cooccurs', relation: '只由已删笔记声明的关系' },
    ],
    tutorSessions: [{ id: 'chat', title: '学习对话', mode: 'qa', note_ids: ['deleted-note', 'live-note', 'live-note'], created_at: time, updated_at: time }],
    tutorMessages: { chat: [{ id: 'message', content: '原有消息' }] },
    syntheses: [{ id: 'report', content: '保留归纳', note_ids: ['deleted-note', 'live-note'] }],
    quizzes: [{ id: 'quiz', source_note_ids: ['deleted-note', 'live-note'], status: 'completed', score: 0, questions: [{ id: 'question', note_id: 'deleted-note' }] }],
    mistakes: [{ id: 'mistake', question_id: 'question', note_id: 'deleted-note', note_title: '失效标题', status: 'unmastered', next_review_at: time }],
    flashcards: [{ id: 'card', note_id: 'live-note', front: '闪卡', next_review_at: time }],
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = JSON.stringify(oldLibrary);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  } });
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { localApi: api } = await vite.ssrLoadModule('/src/api/localEngine.ts');
    const chat = await api.getTutorMessages('chat');
    assert.deepEqual(chat.session.note_ids, ['live-note']);
    assert.equal(chat.messages[0].content, '原有消息');
    assert.deepEqual((await api.getDashboard()).subjectMastery.map(({ id, mastery }) => [id, mastery]), [['live', 50]]);
    const graph = await api.getGraph();
    assert.deepEqual(graph.nodes.map(({ id }) => id), ['shared', 'cooccurs']);
    assert.deepEqual(graph.links.map(({ relation }) => relation), ['同篇共现']);
    assert.equal((await api.getQuiz('quiz')).questions[0].note_id, null);
    assert.equal((await api.getReviewQueue()).items.find(({ id }) => id === 'mistake').note_title, null);

    await api.deleteNote('live-note');
    assert.deepEqual((await api.getDashboard()).subjectMastery, []);
    assert.deepEqual((await api.getDashboard()).weakConcepts, []);
    assert.deepEqual((await api.getTutorMessages('chat')).session.note_ids, []);
    assert.deepEqual((await api.getSyntheses())[0].note_ids, []);
    assert.equal((await api.getSyntheses())[0].content, '保留归纳');
    assert.equal((await api.getFlashcards())[0].note_id, null);
    assert.equal((await api.getQuizzes())[0].status, 'completed');
    assert.deepEqual((await api.getTrashedNotes()).map(({ id }) => id), ['live-note']);
    await assert.rejects(api.getNote('live-note'), /笔记不存在/);
    await api.restoreNote('live-note');
    assert.deepEqual((await api.getTrashedNotes()).map(({ id }) => id), []);
    assert.deepEqual((await api.getTutorMessages('chat')).session.note_ids, ['live-note']);
    assert.deepEqual((await api.getSyntheses())[0].note_ids, ['live-note']);
    assert.equal((await api.getFlashcards())[0].note_id, 'live-note');
    assert.equal((await api.getDashboard()).subjectMastery[0].mastery, 50);
    await api.deleteNote('live-note');
    await api.permanentlyDeleteNote('live-note');
    assert.deepEqual((await api.getTrashedNotes()).map(({ id }) => id), []);
    await api.deleteQuiz('quiz');
    assert.equal((await api.getMistakes())[0].question_id, null);

    await api.importJsonBackup(JSON.stringify({ notes: [], syntheses: [{ id: 'old-report', content: '旧归纳', note_ids: ['deleted-note'] }] }));
    assert.deepEqual((await api.getSyntheses()).find(({ id }) => id === 'old-report').note_ids, []);
    await assert.rejects(api.generateQuiz({ noteIds: ['deleted-note'] }), /所选笔记/);

    const settings = await api.getSettings();
    await api.saveSettings({ ...settings, activeProviderId: 'local' });
    const note = await api.createNote({ title: '聊天进行时删除', content: '' });
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        started.resolve();
        return new Response(JSON.stringify({ choices: [{ message: { content: await finish.promise } }] }));
      };
      const pending = api.sendTutorMessage('chat', { message: '新的问题', noteIds: [note.id] });
      await started.promise;
      await api.deleteNote(note.id);
      finish.resolve('新的回复');
      await pending;
      const latest = await api.getTutorMessages('chat');
      assert.deepEqual(latest.session.note_ids, []);
      assert.equal(latest.messages.at(-1).content, '新的回复');
      const other = await api.createNote({ title: '新增参考', content: '' });
      await api.sendTutorMessage('chat', { message: '参考新笔记', noteIds: [other.id] });
      assert.deepEqual((await api.getTutorMessages('chat')).session.note_ids, [other.id]);
      await api.restoreNote(note.id);
      assert.deepEqual((await api.getTutorMessages('chat')).session.note_ids, [note.id, other.id]);
    } finally {
      finish.resolve('测试结束');
      globalThis.fetch = realFetch;
    }
  } finally {
    await vite.close();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});
