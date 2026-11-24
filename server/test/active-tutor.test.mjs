import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTutorTurn, runTutorChat } from '../dist/shared/tutorContext.js';
import { progressMarker, scopeSignature } from '../dist/shared/tutorScan.js';
import { catalog } from '../dist/shared/tutorSearch.js';
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

test('semantic reading accepts a fenced JSON result and recovers the exact original PDF whitespace', async () => {
  const source = '供电中断\r\n  后，读数保留。';
  const note = { id: 'power', title: '电源记录', content: '', source_type: 'pdf', source_content: source,
    source_pages: [{start: 0, end: source.length, status: 'text'}] };
  const turn = await prepareTutorTurn('qa', [note], false, [], '逐段检查断电记录', async ([system]) => {
    assert.match(system.content, /^ZHIWU_SCAN/);
    return '本段有一条证据。\n```json\n' + JSON.stringify({ findings: [{ unit: 'N1 #1', quote: '供电中断 后，读数保留。' }] }) + '\n```\n检查完毕。';
  });
  const answer = turn.render('记录如下。');
  assert.match(answer, /累计 1\/1/);
  assert.match(answer, /供电中断 {3}后，读数保留。.*\?note=power&part=source&at=1&sig=[^)]*&page=1/);
});

test('semantic reading retries an invalid result with fewer originals and advances on valid empty findings', async () => {
  const note = { id: 'retry', title: '实验记录', content: Array.from({ length: 43 }, (_, i) =>
    `实验 ${i + 1}。${'这是另一项实验的观察。'.repeat(20)}`).join('\n\n') };
  const visits = [];
  const turn = await prepareTutorTurn('qa', [note], false, [], '逐段找出断电记录', async ([, request]) => {
    const keys = JSON.parse(request.content).originals.map(([key]) => key);
    visits.push(keys);
    return visits.length === 1 ? '{"findings":[{"unit":"N1 #1"' : '{"findings":[]}';
  });
  const answer = turn.render('已对照记录。');
  assert.ok(visits.length >= 2);
  assert.deepEqual(visits[1], visits[0].slice(0, visits[1].length));
  assert.ok(visits[1].length < visits[0].length);
  assert.deepEqual(visits.slice(1).flat(), Array.from({ length: 43 }, (_, i) => `N1 #${i + 1}`));
  assert.match(answer, /累计 43\/43/);
  assert.doesNotMatch(answer, /zhiwu-scan|可继续检查/);
});

test('semantic reading reports validation failures, preserves verified evidence, and retries from the last complete batch', async () => {
  const note = { id: 'evidence', title: '实验记录', content: Array.from({ length: 43 }, (_, i) =>
    `证据 ${i + 1}。${'这是另一项实验的观察。'.repeat(20)}`).join('\n\n') };
  const question = '逐段找出实验记录';
  let attempts = 0;
  let completed = [];
  const first = await prepareTutorTurn('qa', [note], false, [], question, async ([, request]) => {
    const { originals } = JSON.parse(request.content);
    if (!attempts++) {
      completed = originals.map(([key]) => key);
      return '{"findings":[]}';
    }
    return JSON.stringify({ findings: [
      { unit: originals[0][0], quote: `证据 ${completed.length + 1}。` },
      { unit: originals[0][0], quote: '杜撰的引文。' },
    ] });
  });
  const answer = first.render('部分核对结果。');
  assert.match(answer, new RegExp(`累计 ${completed.length}/43`));
  assert.match(answer, /摘录与原文不符/);
  assert.match(answer, new RegExp(`证据 ${completed.length + 1}。.*part=body&at=${completed.length + 1}&sig=`));
  assert.doesNotMatch(answer, /杜撰的引文|可继续检查/);
  const visits = [];
  const second = await prepareTutorTurn('qa', [note], false,
    [{ role: 'user', content: question }, { role: 'assistant', content: answer }], '重试逐段检查', async ([, request]) => {
      const input = JSON.parse(request.content);
      assert.equal(input.question, question);
      visits.push(...input.originals.map(([key]) => key));
      return '{"findings":[]}';
    });
  assert.equal(visits[0], `N1 #${completed.length + 1}`);
  assert.match(second.render('已完成检查。'), /累计 43\/43/);
});

test('semantic reading identifies persistent request and response-format failures without counting unread content', async () => {
  const note = { id: 'errors', title: '实验记录', content: '实验记录正文。' };
  const results = [
    [/模型请求未成功/, () => { throw Error('injected connection failure'); }],
    [/模型返回的结果格式无法解析/, () => '暂时无法提供结果。'],
  ];
  for (const [message, result] of results) {
    let visits = 0;
    const turn = await prepareTutorTurn('qa', [note], false, [], '逐段检查实验记录', async () => {
      visits++;
      return result();
    });
    const answer = turn.render('未完成检查。');
    assert.ok(visits > 1 && visits <= 3);
    assert.match(answer, /累计 0\/1/);
    assert.match(answer, message);
    assert.doesNotMatch(answer, /可继续检查|injected connection failure/);
  }
});

test('semantic reading can retry the same group when a provider rejects structured responses', async () => {
  const note = { id: 'older-api', title: '实验记录', content: '实验记录正文。' };
  const attempts = [];
  const turn = await prepareTutorTurn('qa', [note], false, [], '逐段检查实验记录', async ([, request], options) => {
    attempts.push([JSON.parse(request.content).originals, !!options?.jsonMode]);
    if (options?.jsonMode) throw Error('structured responses unsupported');
    return '```json\n{"findings":[]}\n```';
  });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], [attempts[1][0], true]);
  assert.equal(attempts[1][1], false);
  assert.match(turn.render('已完成。'), /累计 1\/1/);
});

test('a restored progress marker resumes only with the same source content', async () => {
  const note = { id: 'restored', title: '实验记录', content: '原来的第一段。\n\n第二段。' };
  const question = '逐段核对实验记录';
  const marker = progressMarker({ scope: '*', signature: scopeSignature(catalog([note])), next: 1, question });
  const history = [{ role: 'assistant', content: `累计 1/2。\n${marker}` }];
  async function retry(source) {
    const visits = [];
    const turn = await prepareTutorTurn('qa', [source], false, history, '继续', async ([, request]) => {
      const input = JSON.parse(request.content);
      assert.equal(input.question, question);
      visits.push(...input.originals.map(([key]) => key));
      return '{"findings":[]}';
    });
    return { visits, answer: turn.render('已完成。') };
  }
  const unchanged = await retry(note);
  assert.deepEqual(unchanged.visits, ['N1 #2']);
  assert.match(unchanged.answer, /本轮完成 1 段，累计 2\/2/);
  const changed = await retry({ ...note, content: '修改后的第一段。\n\n第二段。' });
  assert.deepEqual(changed.visits, ['N1 #1', 'N1 #2']);
  assert.match(changed.answer, /资料已变更.*本轮完成 2 段，累计 2\/2/);
});

test('semantic reading withholds stale findings and progress if a source changes before saving', async () => {
  const note = { id: 'concurrent', title: '实验记录', content: '实验记录正文。' };
  for (const duringScan of [true, false]) {
    const current = new Set([note.id]);
    const { render } = await prepareTutorTurn('qa', [note], false, [], '逐段检查实验记录', async () => {
      if (duringScan) current.clear();
      return JSON.stringify({ findings: [{ unit: 'N1 #1', quote: note.content }] });
    }, async () => current);
    const answer = render('已核对。', new Set());
    assert.match(answer, /检查期间资料已变更/);
    assert.doesNotMatch(answer, /实验记录正文|\?note=|累计 1\/1|zhiwu-scan/);
  }
});

test('semantic reading keeps verified findings when the final answer request fails', async () => {
  const note = { id: 'answer-failure', title: '实验记录', content: '此设备断电后保留读数。' };
  const question = '逐段核对断电记录';
  const { reply, sources } = await runTutorChat('qa', [], question, async () => {
    throw Error('injected answer connection failure');
  }, () => prepareTutorTurn('qa', [note], false, [], question, async () =>
    JSON.stringify({ findings: [{ unit: 'N1 #1', quote: note.content }] })));
  const output = sources.render(reply);
  assert.match(output, /模型未能生成回答/);
  assert.match(output, /累计 1\/1/);
  assert.match(output, /此设备断电后保留读数。.*\?note=answer-failure&part=body&at=1/);
  assert.doesNotMatch(output, /injected answer connection failure/);
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
