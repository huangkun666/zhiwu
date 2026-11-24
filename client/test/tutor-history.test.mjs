import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyPendingTutorHistoryChanges, verifyTutorHistory } from '../../server/test/fixtures/tutor-history.mjs';
import { verifyTutorModes } from '../../server/test/fixtures/tutor-modes.mjs';

async function openLibrary(t) {
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => vite.close());
  return (await vite.ssrLoadModule('/src/api/localEngine.ts')).localApi;
}

test('portable tutor history pages, search, rename and persistence', { timeout: 20000 }, async (t) => {
  let stored;
  let writable = true;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key, value) => {
      if (!writable) throw new Error('Disk full');
      stored = value;
    },
  } });
  const engine = await openLibrary(t);
  const api = {
    restore: (backup) => engine.importJsonBackup(JSON.stringify(backup)),
    list: (q, cursor) => engine.listTutorHistory(q, cursor),
    messages: (id) => engine.getTutorMessages(id),
    rename: (id, title) => engine.renameTutorSession(id, title),
    remove: (id) => engine.deleteTutorSession(id),
    create: () => engine.createTutorSession({ mode: 'qa' }),
  };
  assert.deepEqual(await api.list(), { items: [], nextCursor: null });
  await verifyTutorHistory(t, api);
  await t.test('a failed write can be retried and reopened from storage', async () => {
    writable = false;
    try {
      await assert.rejects(api.rename('history-00', '再次改名'), /无法保存到设备/);
    } finally {
      writable = true;
    }
    assert.equal((await api.messages('history-00')).session.title, '保留旧消息');
    await api.rename('history-00', '再次改名');
    const reopened = await openLibrary(t);
    assert.deepEqual((await reopened.getTutorMessages('valueOf')).messages, []);
    assert.deepEqual((await reopened.listTutorHistory('无消息的旧会话')).items.map(({ id }) => id), ['valueOf']);
    assert.equal((await reopened.getTutorMessages('history-00')).session.title, '再次改名');
    assert.deepEqual((await reopened.listTutorHistory('磁针%_')).items.map(({ title }) => title), ['再次改名']);
    await assert.rejects(reopened.getTutorMessages('history-04'), /会话不存在/);
  });
  await t.test('handles renames and deletions while the model is answering', async () => {
    const settings = await engine.getSettings();
    await engine.saveSettings({ ...settings, activeProviderId: 'local' });
    await verifyPendingTutorHistoryChanges({
      ...api,
      async whileReplyPending(id, change) {
        const started = Promise.withResolvers();
        const finish = Promise.withResolvers();
        const mock = t.mock.method(globalThis, 'fetch', async () => {
          started.resolve();
          return Response.json({ choices: [{ message: { content: await finish.promise } }] });
        });
        const reply = engine.sendTutorMessage(id, { message: '并发问题' });
        try {
          await started.promise;
          await change();
        } finally {
          finish.resolve('完成并发回复');
          await reply.catch(() => {});
          mock.mock.restore();
        }
        return reply;
      },
    });
  });
  await t.test('concurrent rename acknowledgments reflect each request and wait for durable storage', async () => {
    const id = 'history-00';
    const renamed = await Promise.all([api.rename(id, '阶段一'), api.rename(id, '阶段二')]);
    assert.deepEqual(renamed.map(({ title }) => title), ['阶段一', '阶段二']);
    writable = false;
    try {
      const writes = await Promise.allSettled([api.rename(id, '同一重试'), api.rename(id, '同一重试')]);
      assert.deepEqual(writes.map(({ status }) => status), ['rejected', 'rejected']);
    } finally {
      writable = true;
    }
    assert.equal((await api.messages(id)).session.title, '阶段二');
  });
});

test('portable tutor modes and ordinary conversation', { timeout: 20000 }, async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored, setItem: (_key, value) => { stored = value; },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  const engine = await openLibrary(t);
  const settings = await engine.getSettings();
  await engine.saveSettings({ ...settings, activeProviderId: 'local' });
  let model;
  t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json({
    choices: [{ message: { content: await model(JSON.parse(options.body)) } }],
  }));
  await verifyTutorModes(t, {
    create: (payload) => engine.createTutorSession(payload),
    mode: (id, mode) => engine.setTutorSessionMode(id, mode),
    list: (q) => engine.listTutorHistory(q),
    messages: (id) => engine.getTutorMessages(id),
    restore: (snapshot) => engine.importJsonBackup(JSON.stringify(snapshot)),
    export: async () => JSON.parse(await engine.exportJsonBackup()),
    model: (handler) => { model = handler; },
    send: (id, payload) => engine.sendTutorMessage(id, payload),
    async stream(id, payload) {
      const chunks = [];
      const statuses = [];
      const result = await engine.sendTutorMessageStream(id, payload, delta => chunks.push(delta), status => statuses.push(status));
      return { result, text: chunks.join(''), statuses };
    },
  });
});
