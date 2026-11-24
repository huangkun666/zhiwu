import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTutorTurn } from '../dist/shared/tutorContext.js';
import { sourceBlocks } from '../dist/shared/tutorSources.js';

test('a tutor changes its search term and reads a previously unseen paragraph before citing it', async () => {
  const paragraphs = Array.from({ length: 120 }, (_, i) => `第 ${i} 次例会。${'日常进度记录。'.repeat(18)}`);
  paragraphs[89] = '海棠标记出现在周三的工单上。';
  paragraphs[90] = '现场核对时使用了 QX-904 蓝色量规。';
  const note = { id: 'work', title: '现场记录', content: paragraphs.join('\n\n') };
  const actions = [{ action: 'search', query: '海棠' }, { action: 'read', source: 'N1', start: 91, count: 1 }, { action: 'finish' }];
  const prompts = [];
  const turn = await prepareTutorTurn('qa', [note], false, [], '现场用了哪件设备？', async messages => {
    prompts.push(messages.at(-1).content);
    return JSON.stringify(actions.shift());
  });
  assert.match(prompts[1], /N1 #90/);
  assert.match(prompts[2], /QX-904/);
  const material = turn.messages[0].content;
  const marker = material.match(/(\[S\d+\]) N1 #91[^\n]*\n现场核对/)[1];
  const answer = turn.render(`现场使用蓝色量规。${marker} [S9999]`);
  assert.match(answer, /\?note=work&part=body&at=91&sig=/);
  assert.ok(!answer.includes('S9999'));
  assert.ok(!turn.render(marker, new Set()).includes('?note='));
});

test('source offsets refer to the displayed field and an edit invalidates the old target', () => {
  const note = { content: '第一段\r\n\r\n第二段', source_content: 'Imported.\n\nThird row.', chat_excerpts: [
    { id: 'e1', content: 'My reply', created_at: '2026-01-01' },
  ] };
  const blocks = sourceBlocks(note);
  assert.deepEqual(blocks.map(b => [b.field, b.index]), [['body',1],['body',2],['source',1],['source',2],['excerpt',1]]);
  assert.equal(note.content.slice(blocks[1].start, blocks[1].end), '第二段');
  assert.equal(blocks[4].excerptId, 'e1');
  assert.notEqual(sourceBlocks({ ...note, content: '第一段\r\n\r\n改写' })[1].sig, blocks[1].sig);
});

test('literal matches span a hard split, count every occurrence, and continue after the first result page', async () => {
  const note = { id: 'codes', title: '设备记录', content: 'a'.repeat(1398) + 'PQ-47' + '\n\nPQ-47'.repeat(55) };
  const model = () => assert.fail('literal lookup needs no model planning');
  const user = { role: 'user', content: 'PQ-47 出现在哪里？' };
  const first = await prepareTutorTurn('qa', [note], false, [], user.content, model);
  const answer = first.render('已查原文。');
  assert.match(answer, /共 56 处/);
  assert.match(answer, /字符位置 1399/);
  assert.match(answer, /已列出前 50 处/);
  const next = await prepareTutorTurn('qa', [note], false, [user, { role: 'assistant', content: answer }], '继续', model);
  const rest = next.render('余下位置。');
  assert.equal((rest.match(/字符位置/g) || []).length, 6);
  assert.ok(!rest.includes('zhiwu-scan'));
});

test('semantic reading validates original quotations and resumes from the last verified batch', async () => {
  const paragraphs = Array.from({ length: 130 }, (_, i) => `实验记录 ${i}。${'这是另一项实验的观察。'.repeat(70)}`);
  paragraphs[120] = 'No power for a fortnight; readings still persisted in the blue module.';
  const note = { id: 'diary', title: '手记', content: paragraphs.join('\n\n') };
  const visits = [];
  const model = async ([system, user]) => {
    assert.match(system.content, /^ZHIWU_SCAN/);
    const { originals } = JSON.parse(user.content);
    visits.push(...originals.map(([key]) => key));
    return JSON.stringify({ findings: originals.filter(([, text]) => text.includes('fortnight'))
      .map(([unit, quote]) => ({ unit, quote })) });
  };
  const question = '逐段找出断电后是否能保留数据的记录';
  const first = await prepareTutorTurn('qa', [note], false, [], question, model);
  const answer = first.render('已检查第一部分。');
  assert.match(answer, /可继续检查/);
  const second = await prepareTutorTurn('qa', [note], false,
    [{ role: 'user', content: question }, { role: 'assistant', content: answer }], '接着检查', model);
  assert.match(second.messages[0].content, /No power for a fortnight/);
  const result = second.render('已检查后面的记录。');
  assert.match(result, /130\/130/);
  assert.match(result, /part=body&at=121/);
  assert.equal(new Set(visits).size, visits.length);
  const invalid = await prepareTutorTurn('qa', [note], false, [], question, async () =>
    JSON.stringify({ findings: [{ unit: 'N1 #1', quote: 'unverified output' }] }));
  assert.match(invalid.render(''), /累计 0\/130/);
  assert.doesNotMatch(invalid.messages[0].content, /unverified output/);
});

test('reading a scanned page yields only a verified physical-page citation and reports extraction gaps', async () => {
  const note = { id: 'scan', title: '原始扫描', content: '', source_type: 'pdf', source_filename: 'scan.pdf', source_content: '',
    source_pages: [{ start: 0, end: 0, status: 'empty' }] };
  const actions = [{ action: 'read', source: 'N1', page: 1 }, { action: 'finish' }];
  const turn = await prepareTutorTurn('qa', [note], false, [], '第 1 页写了什么？',
    async () => JSON.stringify(actions.shift()), undefined, async (id, page) => {
      assert.equal(id, note.id); assert.equal(page, 1);
      return 'Acceptance limit: 32.5 mV.';
    });
  assert.match(turn.messages[0].content, /视觉转写[\s\S]*32.5 mV/);
  assert.match(turn.render('32.5 mV。[S1]'), /note=scan&part=source&at=1&sig=[^)]*&page=1/);
});

test('a mounting-location question gets semantic search even when the model number is on the cover', async () => {
  const note = { id: 'mount', title: 'CX-8', content: ['CX-8 assembly', ...Array.from({length: 70}, () => 'Factory procedures. '.repeat(20)),
    'Mounting instructions: leave 50 mm clearance above the bracket.'].join('\n\n') };
  const actions = [{action:'search', query:'mounting clearance'}, {action:'finish'}];
  const turn = await prepareTutorTurn('qa', [note], false, [], 'CX-8 的安装位置在哪里？',
    async () => JSON.stringify(actions.shift()));
  assert.equal(actions.length, 0);
  assert.match(turn.messages[0].content, /50 mm clearance/);
  assert.doesNotMatch(turn.render('已查安装要求。'), /逐字匹配，共/);
  const multi = await prepareTutorTurn('qa', [{...note, content:'AB-1 CD-2 CD-2 CD-2'}], false, [],
    'AB-1 和 CD-2 分别出现多少次？', async () => assert.fail());
  assert.match(multi.messages[0].content, /AB-1” 共 1 处/);
  assert.match(multi.messages[0].content, /CD-2” 共 3 处/);
});

test('enumeration keeps separate findings in the same block and reports image-only pages in automatic scope', async () => {
  const text = { id: 'cases', title: 'Cases', content: 'Exception Alpha. Exception Beta.\n\n' + 'Elsewhere. '.repeat(700) };
  const scan = { id: 'scan', title: 'Scan', content: '', source_type: 'pdf', source_content: '',
    source_pages: [{start:0,end:0,status:'failed'}] };
  const turn = await prepareTutorTurn('qa', [text, scan], true, [], '列出所有例外', async ([, request]) => {
    const original = JSON.parse(request.content).originals.find(([, value]) => value.includes('Alpha'));
    return JSON.stringify({ findings: original ? ['Exception Alpha.', 'Exception Beta.'].map(quote => ({unit:original[0], quote})) : [] });
  });
  const answer = turn.render('Exception Alpha. [S1]');
  assert.match(answer, /Exception Beta/);
  assert.match(answer, /《Scan》.*1\(提取失败\)/);
});

test('reading a later table chunk retains its column headers; a repaired or restored source invalidates the cache', async () => {
  const rows = ['Item | Minimum (mV) | Maximum (mV)', ...Array.from({length:300}, (_, i) => `device-${i} | 30.1 | 87.5`)];
  const note = { id:'table', title:'电压表', content:'', source_content:rows.join('\n') };
  const probe = async () => JSON.stringify({action:'finish'});
  const turn = await prepareTutorTurn('qa', [note], false, [], 'device-299 的上限？', probe);
  assert.match(turn.messages[0].content, /表头：Item \| Minimum \(mV\) \| Maximum \(mV\)/);
  note.source_content = '新的表格内容';
  const next = await prepareTutorTurn('qa', [note], false, [], '表格内容？', probe);
  assert.match(next.messages[0].content, /新的表格内容/);
  assert.doesNotMatch(next.messages[0].content, /device-299/);
});
