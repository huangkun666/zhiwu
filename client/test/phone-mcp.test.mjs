import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createServer } from 'vite';

const dbName = 'zhiwu_on_device_db';
const store = 'kv';
const key = 'zhiwu_state_v1';
const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const stamp = '2024-01-01T00:00:00.000Z';
const note = (id, fields = {}) => ({
  id, title: id, content: '', category_id: null, source_type: 'markdown', tags: [],
  created_at: stamp, updated_at: stamp, ...fields,
});

async function library(t, seed = {}) {
  const indexedDB = new IDBFactory();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else delete globalThis.indexedDB;
  });
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  t.after(() => db.close());
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(seed, key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  const saved = () => new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  const { handlePhoneMcpRequest } = await vite.ssrLoadModule('/src/api/phoneMcpTools.ts');
  const { localApi } = await vite.ssrLoadModule('/src/api/localEngine.ts');
  let changes = 0;
  const post = (access, body, fields = headers) => handlePhoneMcpRequest({
    access, body: typeof body === 'string' ? body : JSON.stringify(body), headers: fields,
  }, () => { changes++; });
  return { post, localApi, saved, changes: () => changes };
}

function message(method, params, id = 1) {
  return { jsonrpc: '2.0', method, params, id };
}

async function exchange(post, access, name, args) {
  const response = await post(access, message('tools/call', { name, arguments: args }));
  return JSON.parse(response.body);
}

async function call(post, access, name, args = {}) {
  const { result, error } = await exchange(post, access, name, args);
  assert.equal(error, undefined, JSON.stringify(error));
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent;
}

async function toolError(post, access, name, args, expected) {
  const { result, error } = await exchange(post, access, name, args);
  assert.ok(error || result?.isError);
  assert.match(error?.message ?? result.content[0].text, expected);
}

test('standard HTTP SDK clients discover and call tools on the phone using both protocol eras', async t => {
  const { post } = await library(t, { notes: [note('手机中的笔记')] });
  const server = createHttpServer(async (req, res) => {
    if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = await post('read', Buffer.concat(chunks).toString(), req.headers);
    res.writeHead(reply.status, reply.headers).end(reply.body);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  for (const version of ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']) {
    const options = version.startsWith('2025')
      ? { supportedProtocolVersions: [version] }
      : { versionNegotiation: { mode: { pin: version } } };
    const client = new Client({ name: 'phone-mcp-test', version: '1' }, options);
    try {
      await client.connect(new StreamableHTTPClientTransport(url));
      assert.equal(client.getNegotiatedProtocolVersion(), version);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
        ['list_zhiwu_categories', 'read_zhiwu_note', 'search_zhiwu_notes']);
      const response = await client.callTool({ name: 'read_zhiwu_note', arguments: { noteId: '手机中的笔记' } });
      // Pre-structuredContent clients can read the same JSON in the text content.
      assert.equal(JSON.parse(response.content[0].text).title, '手机中的笔记');
    } finally {
      await client.close();
    }
  }
});

test('notifications, malformed requests and HTTP media negotiation produce bounded standard responses', async t => {
  const { post } = await library(t);
  const notify = await post('read', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notify.status, 202);
  assert.equal(notify.body, '');
  const list = await post('read', message('tools/list', {}, 'a'));
  assert.equal(list.status, 200);
  assert.match(new Headers(list.headers).get('content-type'), /application\/json/);
  assert.equal(JSON.parse(list.body).id, 'a');
  assert.equal((await post('edit', '{')).status, 400);
  assert.equal((await post('read', message('tools/list'), { ...headers, accept: 'text/plain' })).status, 406);
  assert.equal((await post('read', message('tools/list'), { ...headers, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('edit', message('tools/list'), { ...headers, 'mcp-protocol-version': '2099-01-01' })).status, 400);
});

test('read-only and guessed tool names access only active notes and compact matching excerpts', async t => {
  const source = '原件'.repeat(180) + '匹配文字' + '原件'.repeat(200);
  const { post, saved, changes } = await library(t, {
    settings: { activeProviderId: 'remote', providers: [{ id: 'remote', apiKey: 'DO_NOT_COPY_KEY' }] },
    notes: [
      note('active', { title: '旧文件', source_content: source, source_filename: '课件.docx',
        attachment_path: 'data:secret/binary,NEVER_EXPOSE', tags: ['课本'] }),
      note('trash', { content: '匹配文字', deleted_at: stamp }),
    ],
  });
  const before = await saved();
  const list = await call(post, 'read', 'search_zhiwu_notes', { query: '匹配文字', tag: '课本', limit: 1 });
  assert.deepEqual(list.notes.map(item => item.id), ['active']);
  assert.match(list.notes[0].excerpt, /匹配文字/);
  assert.ok(list.notes[0].excerpt.length <= 242);
  const read = await call(post, 'read', 'read_zhiwu_note', { noteId: 'active' });
  assert.equal(read.sourceContent, source);
  assert.equal(read.attachmentUrl, null);
  assert.doesNotMatch(JSON.stringify([list, read]), /DO_NOT_COPY_KEY|NEVER_EXPOSE/);
  await toolError(post, 'read', 'read_zhiwu_note', { noteId: 'trash' }, /不存在/);
  for (const name of ['save_to_zhiwu', 'append_to_zhiwu_note', 'update_zhiwu_note', 'ensure_zhiwu_category',
    'import_zhiwu_files', 'getSettings', 'constructor', '__proto__']) {
    await toolError(post, 'read', name, { title: '不能写入', content: '不能写入', noteId: 'active', categoryPath: ['未建分类'] }, /not found|disabled/i);
  }
  assert.deepEqual(await saved(), before);
  assert.equal(changes(), 0);
});

test('edits share the device library, preserve originals and excerpts, and reject stale competing writes', async t => {
  const suffix = '\n\n---\n\n### 费曼助教延伸笔记（2024年1月1日）\n\n旧摘录';
  const { post, localApi, saved, changes } = await library(t, { notes: [
    note('n', { content: '手写正文' + suffix, source_filename: '课件.docx', source_content: '原件提取文字',
      attachment_path: 'data:docx,原始字节' }),
    note('legacy', { content: '全部内容都是导入原件', source_filename: '旧课件.docx', source_type: 'docx' }),
  ] });
  const read = () => call(post, 'read', 'read_zhiwu_note', { noteId: 'n' });
  const append = { noteId: 'n', content: '聊天追加', excerptId: 'x' };
  await Promise.all([call(post, 'edit', 'append_to_zhiwu_note', append), call(post, 'edit', 'append_to_zhiwu_note', append)]);
  await toolError(post, 'edit', 'append_to_zhiwu_note', { ...append, content: '编号冲突' }, /编号已有其他内容/);
  const first = await read();
  assert.equal(first.editableContent, '手写正文');
  assert.deepEqual(first.chatExcerpts.map(x => x.id), ['x']);
  const update = { noteId: 'n', title: '修改后的标题', content: '新正文', expectedUpdatedAt: first.updatedAt };
  const edited = await call(post, 'edit', 'update_zhiwu_note', update);
  assert.equal((await call(post, 'edit', 'update_zhiwu_note', update)).updatedAt, edited.updatedAt);
  assert.equal((await localApi.getNote('n')).content, '新正文' + suffix);
  await localApi.updateNote('n', { content: '用户修改' + suffix });
  await toolError(post, 'edit', 'update_zhiwu_note', update, /已更新/);
  const current = await read();
  const competing = await Promise.all(['甲', '乙'].map(content => exchange(post, 'edit', 'update_zhiwu_note',
    { noteId: 'n', expectedUpdatedAt: current.updatedAt, content })));
  assert.equal(competing.filter(reply => !reply.result?.isError).length, 1);
  const stored = (await saved()).notes.find(item => item.id === 'n');
  assert.match(stored.content, /^[甲乙]/);
  assert.ok(stored.content.endsWith(suffix));
  assert.equal(stored.attachment_path, 'data:docx,原始字节');
  assert.equal(stored.source_content, '原件提取文字');
  assert.deepEqual(stored.chat_excerpts.map(x => x.content), ['聊天追加']);
  const legacy = await call(post, 'read', 'read_zhiwu_note', { noteId: 'legacy' });
  assert.equal(legacy.editableContent, null);
  await toolError(post, 'edit', 'update_zhiwu_note', { noteId: 'legacy', expectedUpdatedAt: legacy.updatedAt, content: '' }, /旧笔记/);
  await localApi.deleteNote('n');
  await toolError(post, 'edit', 'append_to_zhiwu_note', append, /不存在/);
  await localApi.restoreNote('n');
  assert.equal((await read()).chatExcerpts.length, 1);
  assert.ok(changes() > 0);
});

test('save receipts deduplicate retries, resolve full category paths, and refuse ambiguous destinations', async t => {
  const { post, saved, localApi } = await library(t);
  const args = { title: '新笔记', content: '正文', categoryPath: ['专业课', '设计'], tags: ['复习'], requestId: randomUUID() };
  const [one, two] = await Promise.all([call(post, 'edit', 'save_to_zhiwu', args), call(post, 'edit', 'save_to_zhiwu', args)]);
  assert.equal(one.id, two.id);
  assert.deepEqual(one.categoryPath, args.categoryPath);
  const state = await saved();
  assert.equal(state.notes.length, 1);
  assert.equal(state.studyLogs.length, 1);
  assert.deepEqual(state.notes[0].tags, ['复习']);
  const categories = (await call(post, 'read', 'list_zhiwu_categories')).categories;
  assert.equal(categories.length, 2);
  const parent = categories.find(x => x.name === '专业课');
  assert.equal(categories.find(x => x.id === one.categoryId).parentId, parent.id);
  const path = await call(post, 'edit', 'ensure_zhiwu_category', { parentId: parent.id, categoryPath: ['设计'] });
  assert.deepEqual(path, { categoryId: one.categoryId, categoryPath: args.categoryPath });
  await toolError(post, 'edit', 'save_to_zhiwu', { ...args, content: '冲突' }, /编号/);
  await toolError(post, 'edit', 'save_to_zhiwu', { ...args, categoryId: parent.id }, /分类/);
  await localApi.createCategory({ name: '专业课' });
  await toolError(post, 'edit', 'ensure_zhiwu_category', { categoryPath: ['专业课', '设计'] }, /同名分类/);
  const uncategorized = await call(post, 'edit', 'save_to_zhiwu', { title: '兼容现有客户端', content: '普通收录' });
  assert.equal((await localApi.getNote(uncategorized.id)).category_id, null);
});

test('a stale on-screen draft cannot overwrite an external edit, and a fresh manual edit can change legacy text', async t => {
  const { localApi, post } = await library(t, { notes: [
    note('legacy', { content: '从旧版导入的原文', source_filename: '草稿.txt', source_type: 'text' }),
  ] });
  const draft = await localApi.getNote('legacy');
  await call(post, 'edit', 'update_zhiwu_note', { noteId: draft.id, expectedUpdatedAt: draft.updated_at, title: '新标题' });
  await assert.rejects(localApi.updateNote(draft.id, {
    title: '旧标题', content: '编辑时留下的草稿', ifUnmodifiedSince: draft.updated_at,
  }), /笔记已更新/);
  const current = await localApi.getNote('legacy');
  assert.equal(current.title, '新标题');
  assert.equal(current.content, draft.content);
  const saved = await localApi.updateNote(draft.id, { content: '用户亲自修改的文字', ifUnmodifiedSince: current.updated_at });
  assert.equal(saved.content, '用户亲自修改的文字');
});

test('a write receipt carries its own version when the UI appends before that transaction finishes', async t => {
  const { post, localApi } = await library(t, { notes: [note('n')] });
  const writing = Promise.withResolvers();
  const originalPut = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = originalPut.apply(this, args);
    writing.resolve();
    return request;
  });
  const update = call(post, 'edit', 'update_zhiwu_note', { noteId: 'n', expectedUpdatedAt: stamp, title: '外部改名' });
  await writing.promise;
  const [receipt, ui] = await Promise.all([update, localApi.appendNoteChat('n', 'ui', '用户在手机追加')]);
  assert.ok(receipt.updatedAt < ui.updated_at);
  await toolError(post, 'edit', 'update_zhiwu_note', { noteId: 'n', expectedUpdatedAt: receipt.updatedAt, content: '再次修改' }, /已更新/);
});

test('legacy stored notes use their creation version and keep the source when optional text fields are missing', async t => {
  const { post } = await library(t, { notes: [{
    id: 'old', title: '旧笔记', source_type: 'docx', source_filename: '旧文档.docx', source_content: '原文', created_at: stamp,
  }, note('new')] });
  const read = await call(post, 'read', 'read_zhiwu_note', { noteId: 'old' });
  assert.equal(read.editableContent, '');
  assert.equal(read.updatedAt, stamp);
  assert.deepEqual((await call(post, 'read', 'search_zhiwu_notes', { query: '缺少' })).notes, []);
  await call(post, 'edit', 'update_zhiwu_note', { noteId: 'old', expectedUpdatedAt: stamp, content: '补充' });
  assert.equal((await call(post, 'read', 'read_zhiwu_note', { noteId: 'old' })).sourceContent, '原文');
});

test('a failed IndexedDB transaction never gives a write receipt and permits retry', async t => {
  const { post, saved, changes } = await library(t, { notes: [note('n')] });
  const originalPut = IDBObjectStore.prototype.put;
  const abort = t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = originalPut.apply(this, args);
    this.transaction.abort();
    return request;
  });
  const args = { noteId: 'n', excerptId: 'retry', content: '需要落盘' };
  await Promise.all([
    toolError(post, 'edit', 'append_to_zhiwu_note', args, /存储空间|资料库已更新/),
    toolError(post, 'edit', 'append_to_zhiwu_note', args, /存储空间|资料库已更新/),
  ]);
  assert.equal((await saved()).notes[0].chat_excerpts, undefined);
  assert.equal(changes(), 0);
  abort.mock.restore();
  await call(post, 'edit', 'append_to_zhiwu_note', args);
  assert.equal((await saved()).notes[0].chat_excerpts.length, 1);
});

test('search and category listing withhold concurrent phone edits that roll back', { timeout: 30000 }, async t => {
  const { localApi, post } = await library(t, { notes: [note('已保存')], categories: [
    { id: 'existing', name: '已有分类', created_at: stamp },
  ] });
  const writing = Promise.withResolvers();
  const originalPut = IDBObjectStore.prototype.put;
  let release = false;
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = originalPut.apply(this, args);
    const holdTransaction = () => {
      if (release || t.signal.aborted) this.transaction.abort();
      else this.count('pending').onsuccess = holdTransaction;
    };
    holdTransaction();
    writing.resolve();
    return request;
  });
  const readers = ['getNotes', 'getCategories'].map(name => {
    const started = Promise.withResolvers();
    const get = localApi[name];
    t.mock.method(localApi, name, function (...args) {
      const result = get.apply(this, args);
      started.resolve();
      return result;
    });
    return started.promise;
  });
  const ui = Promise.all([
    assert.rejects(localApi.createNote({ title: '未保存笔记', content: '笔记正文', categoryId: 'existing' }), /无法保存|资料库已更新/),
    assert.rejects(localApi.createCategory({ name: '未保存分类' }), /无法保存|资料库已更新/),
  ]);
  await writing.promise;
  const search = exchange(post, 'read', 'search_zhiwu_notes', {});
  const listing = exchange(post, 'read', 'list_zhiwu_categories', {});
  try {
    await Promise.all(readers);
  } finally {
    release = true;
  }
  await ui;
  const responses = await Promise.all([search, listing]);
  for (const response of responses) {
    assert.equal(response.result.isError, true, JSON.stringify(response.result));
    assert.match(response.result.content[0].text, /资料库已更新/);
  }
  assert.deepEqual((await call(post, 'read', 'search_zhiwu_notes')).notes.map(item => item.id), ['已保存']);
  const categories = (await call(post, 'read', 'list_zhiwu_categories')).categories;
  assert.deepEqual(categories.map(c => [c.name, c.noteCount]), [['已有分类', 0]]);
});
