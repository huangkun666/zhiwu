import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTutorTurn } from '../dist/shared/tutorContext.js';
import * as tutor from '../dist/shared/tutorContext.js';
import { citationLink, sourceBlocks } from '../dist/shared/tutorSources.js';

test('ordinary chat distinguishes source requests, explicit opt-outs and questions the model can decide', () => {
  const history = [{ role: 'assistant', content: '校准记录。[现场记录 · 原文第 3 段](?note=diary&part=source&at=3&sig=abc)' }];
  for (const question of ['查一下我的笔记，校准温度是多少？', '根据这份 PDF 核对测试步骤', 'What did my notes say about calibration?', '下一段呢？']) {
    assert.equal(tutor.generalTutorIntent(history, question), 'search', question);
  }
  for (const question of ['不用查我的笔记，讲讲一般原理', '先别翻资料，接着上个话题聊。', '别在我的笔记里找，凭常识说说', '不要使用我上传的 PDF。', "Don't look in my notes. What is contrast?", 'Answer from general knowledge only.']) {
    assert.equal(tutor.generalTutorIntent(history, question), 'direct', question);
  }
  for (const question of ['什么是笔记本电脑？', 'PDF 是什么格式？', '为什么天空是蓝色的？', 'Wimberley Rev 00 对比度怎么测？']) {
    assert.equal(tutor.generalTutorIntent([], question), 'auto', question);
  }
  assert.match(tutor.generalTutorTurn([], '聊聊光学', true).messages[0].content, /\[\[SEARCH_NOTES\]\]/);
  assert.doesNotMatch(tutor.generalTutorTurn([], '不用资料', false).messages[0].content, /SEARCH_NOTES/);
});

test('ordinary streaming hides a split retrieval control line and promptly releases normal answer text', () => {
  const chunks = [];
  const search = tutor.generalTutorReply(piece => chunks.push(piece));
  for (const part of [' \n[', '[SEARCH', '_NOTES]', ']', '\n']) search.push(part);
  assert.deepEqual(chunks, []);
  assert.deepEqual(search.finish(' [[SEARCH_NOTES]]\n'), { search: true, answer: '' });
  const answer = tutor.generalTutorReply(piece => chunks.push(piece));
  answer.push(' [');
  answer.push('普通');
  assert.equal(chunks.join(''), ' [普通');
  answer.push('] 回答');
  assert.equal(chunks.join(''), ' [普通] 回答');
  assert.deepEqual(answer.finish(' [普通] 回答'), { search: false, answer: ' [普通] 回答' });
  assert.equal(tutor.generalTutorReply().finish('下面的例子是 [[SEARCH_NOTES]]').search, false);
});

test('an ordinary lookup cites the matching source without including unrelated small notes', async () => {
  const notes = [{ id: 'measurement', title: 'Calibration journal', content: 'Gauge RZ-71 reads twelve.' },
    { id: 'unrelated', title: 'Shopping list', content: 'UNRELATED_PRIVATE_ITEM' }];
  const turn = await prepareTutorTurn('general', notes, true, [], '在笔记里查 RZ-71 的读数', async () => '{"action":"finish"}');
  assert.match(turn.messages[0].content, /Gauge RZ-71 reads twelve/);
  assert.doesNotMatch(turn.messages[0].content, /UNRELATED_PRIVATE_ITEM|Shopping list|费曼考官/);
  assert.match(turn.render('十二。[S1]'), /\?note=measurement&part=body&at=1/);
  const miss = await prepareTutorTurn('general', notes, true, [], '查一下笔记里的 zygometer', async () => '{"action":"finish"}');
  assert.doesNotMatch(miss.render('没有找到。'), /\?note=/);
  assert.doesNotMatch(miss.messages[0].content, /UNRELATED_PRIVATE_ITEM|Gauge RZ-71/);
});

test('an ordinary follow-up reads the next paragraph of the cited original', async () => {
  const note = { id: 'diary', title: 'Field log', content: 'Gauge A.\n\nLimit twelve.\n\nUnrelated remark.' };
  const history = [{ role: 'assistant', content: '请看 ' + citationLink(note, sourceBlocks(note)[0]) }];
  const turn = await prepareTutorTurn('general', [note], true, history, '下一段呢？', async () => '{"action":"finish"}');
  assert.match(turn.messages[0].content, /\[S1\] N1 #2[^\n]*\nLimit twelve/);
  assert.match(turn.render('十二。[S1]'), /note=diary&part=body&at=2&sig=/);
});

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
