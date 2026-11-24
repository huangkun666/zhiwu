import assert from 'node:assert/strict';

const stamp = '2024-01-15T00:00:00.000Z';
const privateText = '本库独有的实验记录-N72';
const source = 'mode-live-note';
const trash = 'mode-trash-note';
const outside = 'mode-unselected-note';
const older = 'mode-old-session';

export async function verifyTutorModes(t, api) {
  const note = { title: '蓝鹭方案', content: `蓝鹭方案的实验口令是${privateText}。\n\n校准完成后把温度记为 32 ℃。`, created_at: stamp, updated_at: stamp };
  await api.restore({
    notes: [{ ...note, id: source }, { ...note, id: trash, content: '已回收的密钥-J34', deleted_at: stamp },
      { ...note, id: outside, title: '别的项目', content: '范围外的密钥-Z59' }],
    tutorSessions: [{ id: older, title: '旧答疑', note_ids: [source, trash], created_at: stamp, updated_at: stamp }],
    tutorMessages: { [older]: [
      { id: 'mode-old-question', role: 'user', content: '上次问过潮汐', created_at: stamp },
      { id: 'mode-old-answer', role: 'assistant', content: '你好！我是你的**知悟学习助教**。潮水会涨落。[参见课本](?note=hidden-mode-citation&at=2)<!--zhiwu-scan:hidden-mode-state-->', created_at: stamp },
    ] },
  });

  await t.test('creates an empty ordinary chat by default and retains legacy note-based defaults', async () => {
    const ordinary = await api.create();
    assert.equal(ordinary.mode, 'general');
    assert.deepEqual((await api.messages(ordinary.id)).messages, []);
    assert.equal((await api.create({ noteIds: [] })).mode, 'qa');
    assert.equal((await api.create({ noteIds: [source] })).mode, 'qa');
    assert.equal((await api.create({ mode: 'feynman' })).mode, 'feynman');
    assert.equal((await api.messages(older)).session.mode, 'qa');
    await assert.rejects(api.create({ mode: 'unrecognized' }), /模式/);
  });
  await t.test('retrying a saved turn after a lost receipt returns the same pair once', async () => {
    const { id } = await api.create();
    const payload = { message: '只用常识解释日落', turnId: 'a2cd8ce79ab84b639b3ef4f2fb4b87c5' };
    let calls = 0;
    api.model(() => { calls++; return '地球的自转改变了观察方向。'; });
    const saved = await api.send(id, payload);
    const { userMessage, assistantMessage } = (await api.stream(id, payload)).result;
    assert.deepEqual({ userMessage, assistantMessage }, saved);
    assert.deepEqual((await api.messages(id)).messages, [saved.userMessage, saved.assistantMessage]);
    assert.equal(calls, 1);
  });
  await t.test('persists mode before sending and round-trips it with selections and history', async () => {
    const session = await api.create({ mode: 'qa', title: '自选标题', noteIds: [source] });
    const initial = await api.messages(session.id);
    const updated = await api.mode(session.id, 'general');
    assert.equal(updated.mode, 'general');
    assert.equal(updated.title, '自选标题');
    assert.deepEqual(updated.note_ids, [source]);
    const read = await api.messages(session.id);
    assert.equal(read.session.mode, 'general');
    assert.deepEqual(read.messages, initial.messages);
    assert.equal((await api.list('自选标题')).items.find(item => item.id === session.id).mode, 'general');
    await assert.rejects(api.mode(session.id, 'invalid'), /模式/);
    await assert.rejects(api.mode('mode-missing', 'qa'), /不存在/);
    const snapshot = await api.export();
    const record = snapshot.tutorSessions.find(({ id }) => id === session.id);
    assert.equal(record.mode, 'general');
    await api.restore({ notes: [], tutorSessions: [{ ...record, id: 'mode-portable-copy' }] });
    assert.equal((await api.messages('mode-portable-copy')).session.mode, 'general');
  });
  await t.test('keeps stored learning greetings while leaving them out of ordinary model history', async () => {
    let prompt;
    api.model(body => { prompt = body.messages; return '可以。'; });
    for (const mode of ['qa', 'feynman']) {
      const { id } = await api.create({ mode, initialPrompt: '历史主题' });
      const opening = (await api.messages(id)).messages[0];
      await api.mode(id, 'general');
      await api.send(id, { message: '现在普通聊天' });
      assert.deepEqual(prompt.map(message => message.role), ['system', 'user']);
      assert.equal((await api.messages(id)).messages[0].id, opening.id);
    }
  });
  await t.test('answers ordinary and streaming turns once using only real messages, with no source work or reference changes', async () => {
    const calls = [];
    api.model(body => { calls.push(body.messages); return '这是普通回答'; });
    const question = '不用查我的笔记，接着上次的聊天解释潮汐。';
    const first = await api.send(older, { message: question, mode: 'general', noteIds: [], discardedNoteIds: [trash] });
    assert.equal(first.assistantMessage.content, '这是普通回答');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].at(-1).content, question);
    assert.deepEqual(calls[0].map(message => message.role), ['system', 'user', 'assistant', 'user']);
    assert.match(calls[0][1].content, /上次问过潮汐/);
    assert.match(calls[0][2].content, /潮水会涨落/);
    assert.doesNotMatch(JSON.stringify(calls), /本库独有|ZHIWU_(SCAN|RETRIEVE)|资料覆盖|隐藏来源|hidden-mode|费曼考官/);
    const streamed = await api.stream(older, { message: '再说一句', noteIds: [trash] });
    assert.deepEqual(streamed.statuses, []);
    assert.equal(streamed.text, '这是普通回答');
    assert.equal(streamed.result.assistantMessage.content, '这是普通回答');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].some(message => message.role === 'assistant' && message.content === '这是普通回答'));
    assert.deepEqual((await api.messages(older)).session.selection_ids, [source, trash]);
    await api.mode(older, 'qa');
    const learned = await api.send(older, { message: '概括资料', noteIds: [source] });
    assert.match(calls.at(-1)[0].content, /本库独有/);
    assert.match(learned.assistantMessage.content, /\?note=mode-live-note/);
    await assert.rejects(api.send(older, { message: '测试未知模式', mode: 'typo' }), /模式/);
  });
  await t.test('ordinary source requests use the saved scope, cite originals and follow a citation to the next paragraph', async () => {
    const { id } = await api.create({ mode: 'qa', noteIds: [source] });
    await api.mode(id, 'general');
    const calls = [];
    api.model(({ messages }) => { calls.push(messages); return '见原文。[S1]'; });
    const question = '查一下我的笔记，蓝鹭方案的实验口令是什么？';
    const first = await api.send(id, { message: question, noteIds: [], discardedNoteIds: [source] });
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].content, /本库独有的实验记录-N72/);
    assert.doesNotMatch(calls[0][0].content, /范围外的密钥|已回收的密钥/);
    assert.equal(calls[0].at(-1).content, question);
    assert.match(first.assistantMessage.content, /\?note=mode-live-note&part=body&at=1&sig=/);
    const follow = await api.send(id, { message: '下一段呢？' });
    assert.equal(calls.length, 2);
    assert.match(calls[1][0].content, /校准完成后把温度记为 32 ℃/);
    assert.match(follow.assistantMessage.content, /\?note=mode-live-note&part=body&at=2&sig=/);
    const saved = await api.messages(id);
    assert.equal(saved.session.mode, 'general');
    assert.deepEqual(saved.session.selection_ids, [source]);
    assert.deepEqual(saved.messages.slice(-4).map(message => message.id), [first.userMessage.id, first.assistantMessage.id, follow.userMessage.id, follow.assistantMessage.id]);
    const restricted = await api.send(id, { message: '查一下我的笔记，密钥是什么？', noteIds: [outside, trash] });
    assert.doesNotMatch(calls.at(-1)[0].content, /本库独有|范围外的密钥|已回收的密钥/);
    assert.doesNotMatch(restricted.assistantMessage.content, /\?note=|\[S1\]/);
    assert.deepEqual((await api.messages(id)).session.selection_ids, [source]);
  });
  await t.test('an ordinary model can request evidence without lookup keywords or exposing the control reply', async () => {
    const { id } = await api.create();
    const question = '蓝鹭方案的实验口令是什么？';
    const calls = [];
    api.model(({ messages }) => {
      calls.push(messages);
      const instruction = messages[0].content;
      if (instruction.startsWith('ZHIWU_RETRIEVE')) return JSON.stringify(
        JSON.parse(messages[1].content).results.length ? { action: 'finish' } : { action: 'search', query: '蓝鹭方案' });
      if (!instruction.includes('资料覆盖')) return '[[SEARCH_NOTES]]';
      return `口令是${instruction.includes(privateText) ? privateText : '未知'}。[S1]`;
    });
    const streamed = await api.stream(id, { message: question });
    assert.match(streamed.text, /^口令是本库独有的实验记录-N72/);
    assert.doesNotMatch(streamed.text, /SEARCH_NOTES|\[\[/);
    assert.match(calls[0][0].content, /\[\[SEARCH_NOTES\]\]/);
    assert.doesNotMatch(JSON.stringify(calls[0]), /本库独有|范围外的密钥|已回收的密钥/);
    assert.doesNotMatch(JSON.stringify(calls), /已回收的密钥/);
    assert.equal(calls[0].at(-1).content, question);
    assert.equal(calls.at(-1).at(-1).content, question);
    assert.match(streamed.result.assistantMessage.content, /\?note=mode-live-note&part=body&at=1&sig=/);
    const saved = await api.messages(id);
    assert.equal(saved.session.mode, 'general');
    assert.deepEqual(saved.session.selection_ids, []);
    assert.deepEqual(saved.messages.map(message => message.content), [question, streamed.result.assistantMessage.content]);
    assert.doesNotMatch(saved.messages.at(-1).content, /SEARCH_NOTES|\[\[/);
  });
  await t.test('an ordinary search reads its selected note from the latest library after a restore', async () => {
    const selected = { ...note, id: 'mode-restored-during-decision', title: '水尺记录', content: '水尺读数为 709。' };
    await api.restore({ notes: [selected] });
    const { id } = await api.create({ mode: 'qa', noteIds: [selected.id] });
    await api.mode(id, 'general');
    await api.trashNote(selected.id);
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    let evidence;
    api.model(({ messages }) => {
      if (messages[0].content.includes('资料覆盖')) { evidence = messages[0].content; return '见原文。[S1]'; }
      started.resolve();
      return finish.promise;
    });
    const pending = api.send(id, { message: '水尺读数是多少？' });
    try {
      await started.promise;
      await api.restore({ notes: [{ ...selected, deleted_at: null, updated_at: new Date(Date.now() + 60_000).toISOString() }] });
      assert.equal((await api.note(selected.id)).content, selected.content);
    } finally {
      finish.resolve('[[SEARCH_NOTES]]');
      await pending.catch(() => {});
    }
    const answer = await pending;
    assert.match(evidence, /水尺读数为 709/);
    assert.match(answer.assistantMessage.content, /\?note=mode-restored-during-decision/);
  });
  await t.test('streams a note edit preview without publishing its draft or changing the source', async () => {
    const note = await api.note(source);
    const { id } = await api.create({ mode: 'qa', noteIds: [source] });
    await api.mode(id, 'general');
    const before = '校准完成后把温度记为 32 ℃。';
    const after = '校准完成后把温度记为 34 ℃。';
    const draft = { source: 'N1', operation: 'replace', before, after };
    let usedProviderStream;
    api.model(body => {
      usedProviderStream = Boolean(body.stream);
      return '请核对温度。\n\n```zhiwu-edit\n' + JSON.stringify(draft) + '\n```';
    });
    const result = await api.stream(id, { message: '请修改我的笔记《蓝鹭方案》，把校准温度由 32 ℃ 改为 34 ℃。' });
    assert.doesNotMatch(result.text, /zhiwu-edit|"operation"|"before"/);
    assert.match(result.result.assistantMessage.content, /<!--zhiwu-edit:/);
    assert.equal(usedProviderStream, api.providerStreams);
    assert.doesNotMatch(result.result.assistantMessage.content, /```zhiwu-edit/);
    assert.equal((await api.messages(id)).messages.at(-1).content, result.result.assistantMessage.content);
    assert.deepEqual(await api.note(source), note);
  });
  await t.test('only the current active version accepts a reviewed note update', async () => {
    const id = 'mode-note-revision';
    await api.restore({ notes: [{ ...note, id, source_content: '导入原文永远保留。', source_filename: '蓝鹭.md',
      chat_excerpts: [{ id: 'other-excerpt', content: '另一段对话', created_at: stamp }], tags: ['原标签'] }] });
    const original = await api.note(id);
    const reviewed = await api.updateNote(id, { content: '修订后的正文。', expectedUpdatedAt: original.updated_at });
    assert.equal(reviewed.content, '修订后的正文。');
    assert.notEqual(reviewed.updated_at, original.updated_at);
    assert.equal(reviewed.source_content, original.source_content);
    assert.equal(reviewed.source_filename, original.source_filename);
    assert.deepEqual(reviewed.chat_excerpts, original.chat_excerpts);
    const manual = await api.updateNote(id, { title: '手动更新的标题' });
    const stale = { title: '过期标题', content: '过期内容', tags: [], isPinned: true, expectedUpdatedAt: reviewed.updated_at };
    await api.rejectUpdate(id, stale, 409, /笔记已更新|笔记已变更/);
    assert.deepEqual(await api.note(id), manual);
    await api.trashNote(id);
    await api.rejectUpdate(id, { content: '已移除', expectedUpdatedAt: manual.updated_at }, 404, /笔记不存在/);
    await api.restoreNote(id);
    const restored = await api.note(id);
    assert.equal(restored.content, reviewed.content);
    assert.equal(restored.title, manual.title);
    assert.deepEqual(restored.chat_excerpts, original.chat_excerpts);
  });
  await t.test('a guarded body replacement keeps legacy excerpts and protects imported text stored in the body', async () => {
    const suffix = '\n\n---\n\n### 费曼助教延伸笔记（旧日期）\n\n保留旧摘录。';
    const manual = 'mode-legacy-markdown';
    const legacyFile = 'mode-legacy-file';
    await api.restore({ notes: [
      { ...note, id: manual, content: '旧正文。' + suffix },
      { ...note, id: legacyFile, content: '仅存的文件原文。' + suffix, source_type: 'text', source_filename: '旧资料.txt' },
    ] });
    const original = await api.note(manual);
    const updated = await api.updateNote(manual, { expectedUpdatedAt: original.updated_at, content: '新正文。' });
    assert.equal(updated.content, '新正文。' + suffix);
    await api.rejectUpdate(manual, { expectedUpdatedAt: updated.updated_at, content: '新正文。' + suffix.replace('保留旧摘录', '改掉旧摘录') }, 409, /摘录/);
    const imported = await api.note(legacyFile);
    await api.rejectUpdate(legacyFile, { expectedUpdatedAt: imported.updated_at, content: '覆盖文件', title: '不该改名' }, 409, /原文/);
    assert.deepEqual(await api.note(legacyFile), imported);
    const renamed = await api.updateNote(legacyFile, { expectedUpdatedAt: imported.updated_at, title: '旧资料的新名字' });
    assert.equal(renamed.content, imported.content);
  });
  await t.test('a late reply cannot replace a newer per-session mode, including two switches back to the original value', async () => {
    const first = await api.create({ mode: 'qa' });
    const other = await api.create({ mode: 'feynman' });
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    api.model(async () => { started.resolve(); return finish.promise; });
    const pending = api.send(first.id, { message: '你好', mode: 'general' });
    try {
      await started.promise;
      await api.mode(first.id, 'feynman');
      await api.mode(first.id, 'qa');
    } finally {
      finish.resolve('已答');
      await pending.catch(() => {});
    }
    await pending;
    assert.equal((await api.messages(first.id)).session.mode, 'qa');
    assert.equal((await api.messages(other.id)).session.mode, 'feynman');
  });
}
