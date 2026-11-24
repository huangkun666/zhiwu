import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { createServer } from 'vite';

const stamp = '2026-11-20T12:00:00.000Z';
const fileOriginals = [
  ['pdf', '练习.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n原排版\n')],
  ['docx', '教案.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255])],
  ['image', '照片.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+qv1sAAAAASUVORK5CYII=', 'base64')],
  ['markdown', '原文.md', 'text/markdown', Buffer.from('\uFEFF# 标题\r\n正文\r\n')],
];

function viteLibrary() {
  return createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
}

test('offline archives keep the originals and study history, and a failed restore can be retried', { timeout: 20000 }, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const notes = fileOriginals.map(([type, filename, mime, bytes]) => ({
    id: type, title: filename, source_type: type, source_filename: filename,
    attachment_path: `data:${mime};base64,${bytes.toString('base64')}`, source_content: '# 提取正文',
    category_id: 'physics', tags: ['光学'], created_at: stamp, updated_at: stamp,
    deleted_at: type === 'docx' ? stamp : null,
  }));
  let stored = JSON.stringify({
    settings: { providers: [{ id: 'remote', apiKey: 'fixture-key' }] },
    categories: [{ id: 'physics', name: '物理', color: '#3B5BDB', created_at: stamp }],
    notes: [...notes, { id: 'missing', title: '旧笔记', source_type: 'pdf', source_filename: '旧档.pdf',
      source_content: '旧版保留的提取文字', created_at: stamp, updated_at: stamp }],
    concepts: [{ id: 'optics', name: '光学', category_id: 'physics', note_ids: ['docx'], mastery_score: 0.75, quiz_attempts: 4, quiz_correct: 3 }],
    syntheses: [{ id: 'report', title: '原专题', content: '原归纳', note_ids: ['docx'], created_at: stamp }],
    quizzes: [{ id: 'quiz', title: '练习', source_note_ids: ['docx'], status: 'completed', score: 0.75,
      created_at: stamp, completed_at: stamp, questions: [{ id: 'question', note_id: 'docx', user_answer: 'A', is_correct: true }] }],
    flashcards: [{ id: 'card', note_id: 'docx', front: '正面', back: '背面', repetitions: 3, interval_days: 12,
      next_review_at: '2099-01-01T08:00:00.000Z', created_at: stamp, updated_at: stamp }],
    mistakes: [{ id: 'mistake', note_id: 'docx', question_id: 'question', status: 'reviewing', stem: '错题',
      wrong_count: 4, repetitions: 2, next_review_at: '2099-02-01T08:00:00.000Z', user_reflection: '复习心得',
      created_at: stamp, updated_at: stamp }],
    tutorSessions: [{ id: 'chat', title: '历史对话', mode: 'general', note_ids: ['pdf', 'docx'], created_at: stamp, updated_at: stamp }],
    tutorMessages: { chat: [{ id: 'reply', role: 'assistant', content: '保存的对话', created_at: stamp }] },
    studyLogs: [{ id: 'activity', activity_type: 'quiz_complete', entity_id: 'quiz', duration_seconds: 78,
      score: 0.75, date_key: '2026-11-20', created_at: stamp }],
  });
  let writable = true;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key, value) => {
      if (!writable) throw new Error('Disk full');
      stored = value;
    },
  } });

  let vite;
  try {
    vite = await viteLibrary();
    const { localApi: source } = await vite.ssrLoadModule('/src/api/localEngine.ts');
    const { blob, missingAttachments } = await source.exportBackup();
    assert.equal(missingAttachments, 1);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
    const text = await zip.file('manifest.json').async('string');
    assert.equal(text.includes('fixture-key'), false);
    const manifest = JSON.parse(text);
    for (const [type, , mime, bytes] of fileOriginals) {
      const entry = manifest.attachments.find(({ noteId }) => noteId === type);
      assert.equal(entry.mime, mime);
      assert.deepEqual(await zip.file(entry.path).async('nodebuffer'), bytes);
    }
    await vite.close();
    vite = undefined;

    stored = JSON.stringify({ notes: [{ id: 'existing', title: '设备上的笔记', content: '', created_at: stamp, updated_at: stamp }] });
    vite = await viteLibrary();
    const { localApi: target } = await vite.ssrLoadModule('/src/api/localEngine.ts');
    const file = new File([blob], 'complete.zip');
    const preview = await target.previewBackup(file);
    assert.equal(preview.counts.notes, 5);
    assert.equal(preview.counts.trashedNotes, 1);
    assert.equal(preview.counts.attachments, 4);
    assert.deepEqual(preview.missingAttachments, [{ noteId: 'missing', filename: '旧档.pdf' }]);
    assert.deepEqual((await target.getNotes()).map(({ id }) => id), ['existing']);

    writable = false;
    await assert.rejects(target.restoreBackup(file), /无法保存到设备/);
    assert.deepEqual((await target.getNotes()).map(({ id }) => id), ['existing']);
    writable = true;
    const [first] = await Promise.all([
      target.restoreBackup(file),
      target.importJsonBackup(JSON.stringify({ notes: [{ id: 'legacy', title: '旧版备份记录' }] })),
    ]);
    assert.equal(first.notesCount, 5);
    assert.equal((await target.getNote('legacy')).title, '旧版备份记录');
    assert.equal((await target.getNote('existing')).title, '设备上的笔记');
    assert.equal((await target.previewBackup(file)).conflicts > 0, true);
    assert.equal((await target.restoreBackup(file)).notesCount, 0);
    assert.deepEqual((await target.getTrashedNotes()).map(({ id }) => id), ['docx']);
    assert.deepEqual((await target.getTutorMessages('chat')).session.note_ids, ['pdf']);
    assert.equal((await target.getTutorMessages('chat')).session.mode, 'general');
    assert.equal((await target.getTutorMessages('chat')).messages[0].content, '保存的对话');
    assert.equal((await target.getQuiz('quiz')).score, 0.75);
    assert.equal((await target.getQuiz('quiz')).questions[0].user_answer, 'A');
    assert.equal((await target.getFlashcards())[0].repetitions, 3);
    assert.equal((await target.getMistakes())[0].user_reflection, '复习心得');
    assert.deepEqual((await target.getDashboard()).quizTrend, [{ date: '2026-11-20', accuracy: 75 }]);
    await target.restoreNote('docx');
    assert.deepEqual((await target.getTutorMessages('chat')).session.note_ids, ['pdf', 'docx']);
    assert.deepEqual((await target.getSyntheses())[0].note_ids, ['docx']);
    assert.equal((await target.getDashboard()).subjectMastery[0].mastery, 75);
    for (const [type, , mime, bytes] of fileOriginals) {
      assert.equal((await target.getNote(type)).attachment_path, `data:${mime};base64,${bytes.toString('base64')}`);
    }

    zip.remove(manifest.attachments[0].path);
    const incomplete = new File([await zip.generateAsync({ type: 'nodebuffer' })], 'incomplete.zip');
    const saved = stored;
    await assert.rejects(target.restoreBackup(incomplete), /附件不完整/);
    assert.equal(stored, saved);

    const invalid = new JSZip();
    invalid.file('manifest.json', JSON.stringify({
      ...manifest, attachments: [], missingAttachments: [],
      snapshot: { notes: [{ id: 'invalid', title: '无效旧档', updated_at: 52 }] },
    }));
    const invalidFile = new File([await invalid.generateAsync({ type: 'nodebuffer' })], 'invalid.zip');
    await assert.rejects(target.previewBackup(invalidFile), /字段格式无效/);
    await assert.rejects(target.restoreBackup(invalidFile), /字段格式无效/);
    assert.equal(stored, saved);
  } finally {
    await vite?.close();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});
