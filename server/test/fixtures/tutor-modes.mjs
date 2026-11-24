import assert from 'node:assert/strict';

const stamp = '2024-01-15T00:00:00.000Z';
const privateText = '本库独有的实验记录-N72';
const source = 'mode-live-note';
const trash = 'mode-trash-note';
const older = 'mode-old-session';

export async function verifyTutorModes(t, api) {
  const note = { title: '无关资料', content: privateText.repeat(60), created_at: stamp, updated_at: stamp };
  await api.restore({
    notes: [{ ...note, id: source }, { ...note, id: trash, deleted_at: stamp }],
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
    const question = '接着上次的话题，逐段找出背景。';
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
