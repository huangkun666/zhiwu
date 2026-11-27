import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { createServer } from 'vite';
import { knowledgeCitation, knowledgeClause, knowledgeCompletion, knowledgeQuestion, knowledgeTitle, waitForKnowledge } from '../../server/test/fixtures/imported-knowledge.mjs';

test('offline import queues knowledge and resolves searches to the original note', { timeout: 90000 }, async () => {
  const oldIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const oldFileReader = globalThis.FileReader;
  const oldFetch = globalThis.fetch;
  const release = Promise.withResolvers();
  Object.defineProperty(globalThis, 'indexedDB', { value: indexedDB, configurable: true });
  globalThis.FileReader = class {
    async readAsDataURL(file) {
      this.result = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
      this.onload();
    }
  };
  globalThis.fetch = async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    if (messages[0].content.startsWith('ZHIWU_KNOWLEDGE')) {
      await release.promise;
      return new Response(JSON.stringify({ choices: [{ message: {
        content: knowledgeCompletion(JSON.parse(messages[1].content).blocks),
      } }] }));
    }
    if (messages[0].content.startsWith('ZHIWU_RETRIEVE')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"finish"}' } }] }));
    }
    const citation = knowledgeCitation(messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: citation ? `预热 30 分钟 ${citation}` : '缺少原文' } }] }));
  };
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { localApi: api } = await vite.ssrLoadModule('/src/api/localEngine.ts');
    await api.saveSettings({ ...await api.getSettings(), activeProviderId: 'local' });
    const text = `${'Ordinary setup procedure. '.repeat(1150)}\n\n# Final section\n\n${knowledgeClause}`;
    const { imported: [note] } = await api.importFiles([new File([text], 'operation.txt', { type: 'text/plain' })]);
    assert.equal(typeof api.getKnowledge, 'function', 'offline import records an extraction task');
    const read = () => api.getKnowledge(note.id);
    assert.equal((await read()).status, 'pending');
    const { passages } = await api.searchLibrary('preheat for 30 minutes');
    assert.ok(passages.some(({ source }) => source.noteId === note.id));
    release.resolve();
    const completed = await waitForKnowledge(read, 'complete');
    assert.equal(completed.points[0].title, knowledgeTitle);
    assert.equal((await api.searchLibrary(knowledgeQuestion)).points[0].sources[0].noteId, note.id);
    const session = await api.createTutorSession({ mode: 'qa', noteIds: [note.id] });
    const response = await api.sendTutorMessage(session.id, { message: knowledgeQuestion });
    assert.ok(JSON.stringify(response).includes(completed.points[0].sources[0].params));
    await api.deleteNote(note.id);
    assert.equal((await api.searchLibrary(knowledgeQuestion)).points.length, 0);
    await api.restoreNote(note.id);
    assert.equal((await api.searchLibrary(knowledgeQuestion)).points[0].id, completed.points[0].id);
  } finally {
    release.resolve();
    await vite.close();
    globalThis.fetch = oldFetch;
    if (oldFileReader) globalThis.FileReader = oldFileReader;
    else delete globalThis.FileReader;
    if (oldIndexedDB) Object.defineProperty(globalThis, 'indexedDB', oldIndexedDB);
    else delete globalThis.indexedDB;
  }
});
