import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTutorTurn } from '../dist/shared/tutorContext.js';

test('short selected notes include legacy body, extracted text and chat excerpts together', async () => {
  const notes = Array.from({ length: 16 }, (_, i) => ({
    id: `note-${i}`, title: `材料 ${i}`, content: `正文 ${i}\n![旧图](data:image/png;base64,AAAA)`,
    source_content: `原文 ${i}`,
    chat_excerpts: JSON.stringify([{ id: 'reply', content: `摘录 ${i}`, created_at: '2026-01-01' }]),
  }));
  let expansions = 0;
  const { messages } = await prepareTutorTurn('qa', notes, false, [], '综合我的笔记', async () => { expansions++; return ''; });
  assert.equal(expansions, 0);
  for (let i = 0; i < notes.length; i++) {
    for (const field of ['正文', '原文', '摘录']) assert.ok(messages[0].content.includes(`\n${field} ${i}`));
  }
  assert.ok(!messages[0].content.includes('base64'));
});

test('a follow-up can retrieve an earlier topic if cross-language expansion fails', async () => {
  const notes = [{ id: 'test', title: '测试资料', content: 'General requirements. '.repeat(2000) +
    '\nDeadband threshold: use instrument DB-09.\n' + 'Packing requirements. '.repeat(2000) }];
  let attempts = 0;
  const { messages } = await prepareTutorTurn('qa', notes, false,
    [{ role: 'user', content: 'deadband 如何定义？' }, { role: 'assistant', content: '还有什么想了解的？' }],
    '用哪台仪器？', async () => { attempts++; throw Error('model unavailable'); });
  assert.equal(attempts, 1);
  assert.ok(messages[0].content.includes('DB-09'));
  assert.match(messages[0].content, /全文检索节选/);
  assert.ok(messages[0].content.length < 17000);
  assert.deepEqual(messages.at(-1), { role: 'user', content: '用哪台仪器？' });
});
