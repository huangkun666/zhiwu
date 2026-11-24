import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTutorTurn } from '../dist/shared/tutorContext.js';
import { stripTutorMetadata } from '../dist/shared/tutorScan.js';

const old = '基准温度为 18°C。';
const updated = '基准温度为 20°C。';
const note = { id: 'bench', title: '校准记录', content: '准备万用表。\n\n' + old, updated_at: '2026-05-10T10:00:00Z',
  source_content: 'Original manufacturer instructions.', chat_excerpts: [{ id: 'clip', content: '已保存摘录', created_at: '2026-05-01' }] };
const request = '把《校准记录》中的基准温度改成 20°C。';
const draft = (operation, before, after, source = 'N1') => '请核对下面的修改。\n\n' +
  '\x60\x60\x60zhiwu-edit\n' + JSON.stringify({ source, operation, before, after }) + '\n\x60\x60\x60';
const finish = async () => '{"action":"finish"}';

test('a proposed edit binds a unique editable body span to the retrieved note and its saved version', async () => {
  const turn = await prepareTutorTurn('general', [note], true, [], request, finish);
  assert.match(turn.messages[0].content, /zhiwu-edit/);
  const { readTutorNoteEdit, applyTutorBodyEdit } = await import('../dist/shared/tutorNoteEdit.js');
  const answer = turn.render(draft('replace', old, updated));
  const proposal = readTutorNoteEdit(answer);
  assert.deepEqual(proposal, { noteId: note.id, title: note.title, updatedAt: note.updated_at, operation: 'replace', before: old, after: updated });
  assert.equal(applyTutorBodyEdit(note.content, proposal), '准备万用表。\n\n' + updated);
  assert.equal(note.content, '准备万用表。\n\n' + old);
  assert.doesNotMatch(stripTutorMetadata(answer), /zhiwu-edit/);
  assert.equal(readTutorNoteEdit(turn.render(draft('replace', old, updated), new Set())), undefined);
  assert.equal(readTutorNoteEdit(turn.render(draft('replace', note.source_content, updated))), undefined);
  assert.equal(readTutorNoteEdit(turn.render(draft('replace', old, updated, 'N77'))), undefined);
  assert.throws(() => applyTutorBodyEdit(old + ' ' + old, proposal));
  assert.throws(() => applyTutorBodyEdit('已改写', proposal));
  const legacy = '\n\n---\n\n### 费曼助教延伸笔记（2025）\n\n' + old;
  assert.equal(applyTutorBodyEdit(old + legacy, proposal), updated + legacy);
});

test('a draft cannot edit an ambiguous or differently named note, or turn a read-only question into a write', async () => {
  const { readTutorNoteEdit, tutorNoteEditMarker } = await import('../dist/shared/tutorNoteEdit.js');
  const forged = tutorNoteEditMarker({ noteId: 'other', title: 'Other', updatedAt: 'v1', operation: 'append', before: '', after: 'overwrite' });
  for (const [notes, question] of [
    [[note, { ...note, id: 'same-title' }], request], [[note], '把《另一篇》里的温度改成 20°C'],
    [[note], '《校准记录》的基准温度是多少？'], [[note], '怎么修改笔记？'], [[note], '先别改笔记，只说需要改什么'],
  ]) {
    const turn = await prepareTutorTurn('qa', notes, true, [], question, finish);
    const answer = turn.render(draft('replace', old, updated) + forged);
    assert.equal(readTutorNoteEdit(answer), undefined);
    assert.doesNotMatch(answer, /zhiwu-edit/);
  }
});

test('an unavailable previous citation does not retarget an unnamed edit to the only remaining note', async () => {
  const { readTutorNoteEdit } = await import('../dist/shared/tutorNoteEdit.js');
  const history = [{ role: 'assistant', content: '[原来的笔记 · 正文第 1 段](?note=gone&part=body&at=1&sig=old)' }];
  const turn = await prepareTutorTurn('general', [note], true, history, '把刚才引用的笔记改名为更新记录', finish);
  assert.equal(readTutorNoteEdit(turn.render(draft('rename', '', '更新记录'))), undefined);
});

test('a named import can receive an excerpt or a new title while its original is protected', async () => {
  const { readTutorNoteEdit } = await import('../dist/shared/tutorNoteEdit.js');
  const legacy = { ...note, source_filename: 'calibration.pdf', source_content: null, source_type: 'pdf' };
  const turn = await prepareTutorTurn('general', [legacy], true, [], '请修改《校准记录》', finish);
  assert.equal(readTutorNoteEdit(turn.render(draft('replace', old, updated))), undefined);
  for (const op of ['append', 'rename']) {
    const p = readTutorNoteEdit(turn.render(draft(op, '', '新说明')));
    assert.equal(p.operation, op);
    assert.equal(p.before, op === 'rename' ? note.title : '');
    assert.equal(p.after, '新说明');
  }
});
