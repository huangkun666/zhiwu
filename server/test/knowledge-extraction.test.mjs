import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canAdvanceKnowledge, createKnowledgeQueue, startKnowledgeIndex } from '../dist/shared/knowledgePoints.js';
import { noteKnowledge } from '../dist/shared/tutorSearch.js';

const point = { title: '测量前预热', answer: '通电后等 30 分钟再测量。', aliases: ['多久能测'] };
const original = '环境温度低于 10 ℃ 时，预热\r\n30 分钟再开始测量。';

function extract(note, reply) {
  const current = { ...note, knowledge_index: startKnowledgeIndex(note) };
  const settled = Promise.withResolvers();
  const schedule = createKnowledgeQueue({
    load: () => current,
    save(_id, before, after) {
      if (!canAdvanceKnowledge(current, before)) return false;
      current.knowledge_index = after;
      if (after.status !== 'pending') settled.resolve(current);
      return true;
    },
    async model(messages) {
      const { blocks } = JSON.parse(messages[1].content);
      return reply(blocks);
    },
  });
  schedule([current.id]);
  return settled.promise;
}

test('a reformatted quotation from a text import is linked to the actual original paragraph', { timeout: 5000 }, async () => {
  const note = await extract({
    id: 'text-import', title: '操作手册', content: '', source_content: '设备运行记录。\r\n\r\n' + original,
  }, () => JSON.stringify({ points: [{ ...point, sources: [{ block: 2, quote: '环境温度低于10°C时,预热30分钟再开始测量。' }] }] }));
  assert.equal(note.knowledge_index.status, 'complete');
  assert.equal(note.knowledge_index.points[0].origins[0].quote, original);
  assert.match(noteKnowledge(note).points[0].sources[0].params, /part=source&at=2/);
});

test('a legacy quotation in another paragraph corrects the model’s mismatched source number', { timeout: 5000 }, async () => {
  const note = await extract({ id: 'mixed-sources', title: '手册', content: '气压必须为 73 kPa。\n\n' + original },
    () => JSON.stringify({ points: [{ ...point, sources: [{ block: 1, quote: original }] }] }));
  assert.equal(note.knowledge_index.status, 'complete');
  assert.match(noteKnowledge(note).points[0].sources[0].params, /part=body&at=2/);
});

test('a malformed multi-paragraph reply is retried in smaller groups to find pasted-text knowledge', { timeout: 5000 }, async () => {
  const sizes = [];
  const note = await extract({
    id: 'pasted-text', title: '摘记', content: ['说明页。', original, '文件清单。'].join('\n\n'),
  }, blocks => {
    sizes.push(blocks.length);
    if (blocks.length > 1) return '{"points":[';
    assert.equal(blocks[0].id, 1, 'each request numbers only its own paragraphs');
    return JSON.stringify({ points: blocks[0].text.includes('预热') ? [{ ...point, sources: [] }] : [] });
  });
  assert.equal(note.knowledge_index.status, 'complete');
  assert.deepEqual(sizes, [3, 2, 1, 1, 1]);
  assert.match(noteKnowledge(note).points[0].sources[0].params, /part=body&at=2/);
});

test('out-of-batch paragraph references never become source links', { timeout: 5000 }, async () => {
  const note = await extract({ id: 'unverified', title: '操作手册', content: original },
    () => JSON.stringify({ points: [{ ...point, sources: [999] }] }));
  assert.equal(note.knowledge_index.status, 'paused');
  assert.equal(note.knowledge_index.processed, 0);
  assert.deepEqual(noteKnowledge(note).points, []);
});

test('a mixed single-paragraph reply keeps verified points and remains retryable', { timeout: 5000 }, async () => {
  let calls = 0;
  const note = await extract({ id: 'partial', title: '手册', content: original }, () => {
    calls++;
    return JSON.stringify({ points: [
      { ...point, sources: [1] },
      { ...point, title: '错误的段号', sources: [999] },
      { ...point, title: '虚构引文', sources: [{ block: 1, quote: '预热 40 分钟。' }] },
    ] });
  });
  assert.equal(calls, 2);
  assert.equal(note.knowledge_index.status, 'paused');
  assert.equal(note.knowledge_index.processed, 0);
  assert.deepEqual(noteKnowledge(note).points.map(item => item.title), [point.title]);
});

test('normal batch size resumes after the range with a bad model reply has been processed', { timeout: 5000 }, async () => {
  const sizes = [];
  const content = Array.from({ length: 35 }, (_, number) => `操作记录 ${number}。`).join('\n\n');
  const note = await extract({ id: 'long-source', title: '记录', content }, blocks => {
    sizes.push(blocks.length);
    return sizes.length === 1 ? 'broken JSON' : '{"points":[]}';
  });
  assert.equal(note.knowledge_index.status, 'complete');
  assert.deepEqual(sizes, [18, 9, 9, 17]);
});
