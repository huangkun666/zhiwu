import assert from 'node:assert/strict';

const tied = '2090-01-01T00:00:00.000Z';
const old = '2020-05-01T00:00:00.000Z';
const sessionId = (index) => 'history-' + String(index).padStart(2, '0');
const ids = (page) => page.items.map(({ id }) => id);

function historyBackup() {
  const tutorSessions = Array.from({ length: 36 }, (_, index) => ({
    id: sessionId(index), title: '归档练习 ' + index, mode: 'feynman',
    note_ids: ['history-source', 'history-trash'],
    created_at: index === 0 ? old : tied, ...(index ? { updated_at: tied } : {}),
  }));
  tutorSessions[4].title += ' ÉCOLE';
  tutorSessions.push({ id: 'valueOf', title: '无消息的旧会话', mode: 'qa', note_ids: [], created_at: old });
  const note = { title: '来源', content: '', created_at: old, updated_at: old };
  const messages = [
    ['user', '为什么要用磁针%_标定？'],
    ['assistant', '旧答案。'.repeat(120) + '**TÉMOIN** 表示对照样品。[课本 · 正文第1段](?note=internal-history-url&part=body&at=1&sig=fingerprint)\n<!--zhiwu-scan:internal-history-cursor-->'],
    ['user', '再次用磁针%_核对。'],
    ...Array.from({ length: 15 }, () => ['assistant', '后来的普通练习']),
  ].map(([role, content], index) => ({
    id: 'history-turn-' + index, role, content, created_at: new Date(Date.parse(old) + index).toISOString(),
  }));
  return {
    notes: [{ ...note, id: 'history-source' }, { ...note, id: 'history-trash', deleted_at: old }],
    tutorSessions, tutorMessages: {
      [sessionId(0)]: messages,
      [sessionId(3)]: [{ id: 'history-control', role: 'user', content: '这里也有磁针XY标定和磁针%X。', created_at: old }],
    },
  };
}

// Both the HTTP API and the portable engine read the same old-format backup.
export async function verifyTutorHistory(t, api) {
  const backup = historyBackup();
  await api.restore(backup);
  await t.test('uses a deterministic 30-session cursor across deletions and insertions', async () => {
    const first = await api.list();
    assert.deepEqual(ids(first), Array.from({ length: 30 }, (_, i) => sessionId(35 - i)));
    assert.equal(typeof first.nextCursor, 'string');
    assert.deepEqual(first.items[0].note_ids, ['history-source']);
    const filtered = await api.list('归档练习');
    assert.deepEqual(ids(filtered), ids(first));
    await api.remove(first.items.at(-1).id);
    await api.restore({ notes: [], tutorSessions: [{ ...backup.tutorSessions[1], id: 'history-new', updated_at: '2091-01-01T00:00:00.000Z' }] });
    const remaining = await api.list('归档练习', filtered.nextCursor);
    assert.deepEqual(ids(remaining), Array.from({ length: 6 }, (_, i) => sessionId(5 - i)));
    assert.equal(remaining.nextCursor, null);
    assert.equal(remaining.items.at(-1).updated_at, old);
    await assert.rejects(api.list('', 'bad-cursor'), /分页/);
    const unicodeIds = ['旧ID-Ａ', '旧ID-🐼'];
    await api.restore({ notes: [], tutorSessions: unicodeIds.map((id) => ({ ...backup.tutorSessions[0], id, title: '导入的同分 ID' })) });
    assert.deepEqual(ids(await api.list('导入的同分 ID')), ['旧ID-🐼', '旧ID-Ａ']);
  });
  await t.test('finds old user and assistant text with literal Unicode terms and short visible snippets', async () => {
    assert.deepEqual(ids(await api.list('无消息的旧会话')), ['valueOf']);
    assert.deepEqual((await api.messages('valueOf')).messages, []);
    assert.deepEqual(ids(await api.list('école')), [sessionId(4)]);
    const user = await api.list('磁针%_');
    assert.deepEqual(ids(user), [sessionId(0)]);
    assert.match(user.items[0].matchSnippet, /磁针%_/);
    const assistant = await api.list('témoin');
    assert.deepEqual(ids(assistant), [sessionId(0)]);
    assert.match(assistant.items[0].matchSnippet, /TÉMOIN/);
    assert.ok(assistant.items[0].matchSnippet.length <= 180);
    assert.doesNotMatch(assistant.items[0].matchSnippet, /internal-history-|\*\*/);
    assert.deepEqual(ids(await api.list('课本')), [sessionId(0)]);
    assert.deepEqual(await api.list('internal-history-'), { items: [], nextCursor: null });
    assert.deepEqual(await api.list('磁针._'), { items: [], nextCursor: null });
  });
  await t.test('renames only the session and keeps the new title when an old backup is retried', async () => {
    const id = sessionId(4);
    const before = await api.messages(id);
    for (const title of ['', '   ', 42]) await assert.rejects(api.rename(id, title), /标题/);
    await assert.rejects(api.rename(id, '字'.repeat(201)), /200/);
    const renamed = await api.rename(id, '  重读实验记录  ');
    assert.equal(renamed.id, id);
    assert.equal(renamed.title, '重读实验记录');
    assert.equal(renamed.mode, before.session.mode);
    assert.equal(renamed.created_at, before.session.created_at);
    assert.deepEqual(renamed.note_ids, ['history-source']);
    assert.ok(renamed.updated_at > before.session.updated_at);
    assert.equal((await api.rename(id, renamed.title)).updated_at, renamed.updated_at);
    await api.restore(backup);
    assert.deepEqual(ids(await api.list('重读实验记录')), [id]);
    assert.deepEqual(ids(await api.list('école')), []);
    const after = await api.messages(id);
    assert.deepEqual(after.session.selection_ids, ['history-source', 'history-trash']);
    assert.deepEqual(after.messages, before.messages);
    const conversation = await api.messages(sessionId(0));
    await api.rename(sessionId(0), '保留旧消息');
    assert.deepEqual((await api.messages(sessionId(0))).messages, conversation.messages);
    await api.remove(id);
    await assert.rejects(api.rename(id, '不能复原'), /会话不存在/);
    assert.deepEqual(ids(await api.list('重读实验记录')), []);
  });
}

export async function verifyPendingTutorHistoryChanges(api) {
  const created = await api.create();
  const id = created.id;
  const future = { notes: [], tutorSessions: [{ ...created, updated_at: tied }] };
  await api.restore(future);
  let renamed;
  await api.whileReplyPending(id, async () => { renamed = await api.rename(id, '并发改名记录'); });
  const saved = await api.messages(id);
  assert.equal(saved.session.title, '并发改名记录');
  assert.ok(saved.session.updated_at > renamed.updated_at);
  await api.restore(future);
  assert.equal((await api.messages(id)).session.title, '并发改名记录');
  assert.match(saved.messages.at(-1).content, /完成并发回复/);
  await assert.rejects(api.whileReplyPending(id, () => api.remove(id)), /会话已被删除/);
  assert.deepEqual(ids(await api.list('并发改名记录')), []);
  assert.deepEqual(ids(await api.list('完成并发回复')), []);
}
