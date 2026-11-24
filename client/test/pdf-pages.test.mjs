import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('offline PDF imports, legacy reindexing and ZIP restore preserve empty and failed physical pages', async (t) => {
  const storage = new Map();
  const globals = { localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    FileReader: class {
      async readAsDataURL(file) {
        this.result = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
        this.onload();
      }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{ name: 'mixed-pdf-pages', enforce: 'pre', load(id) {
      if (!id.endsWith('/utils/pdf.ts')) return;
      return `let loads = 0; export const countLoads = () => loads;
      export async function loadPdf() {
        loads++;
        return { destroy: async () => {}, promise: Promise.resolve({ numPages: 4, async getPage(number) {
          if (number === 3) throw new Error('broken page');
          const str = ['First', '', '', 'Last'][number - 1];
          return { cleanup() {}, getTextContent: async () => ({items: [{str, hasEOL:true}]}) };
        } }) };
      }`;
    } }],
  });
  t.after(() => vite.close());
  const { localApi: api } = await vite.ssrLoadModule('/src/api/localEngine.ts');
  const { imported: [note], warnings } = await api.importFiles([new File(['%PDF-test'], 'scans.pdf', { type: 'application/pdf' })]);
  assert.match(warnings.join(' '), /1 页文本提取失败/);
  const pages = [
    { start: 0, end: 5, status: 'text' }, { start: 5, end: 5, status: 'empty' },
    { start: 5, end: 5, status: 'failed' }, { start: 7, end: 11, status: 'text' },
  ];
  assert.deepEqual(note.source_pages, pages);
  assert.equal(note.source_content, 'First\n\nLast');
  const { blob } = await api.exportBackup();
  await api.deleteNote(note.id);
  await api.permanentlyDeleteNote(note.id);
  await api.restoreBackup(new File([blob], 'copy.zip'));
  assert.deepEqual((await api.getNote(note.id)).source_pages, pages);

  const edited = { ...note, id: 'legacy', source_pages: undefined, source_content: 'First', content: 'My edits',
    chat_excerpts: [{ id: 'saved', created_at: note.created_at, content: 'Excerpt' }] };
  const unavailable = { ...edited, id: 'unavailable', attachment_path: null,
    source_pages: [{ start: 200, end: 201, status: 'text' }] };
  await api.importJsonBackup(JSON.stringify({ notes: [edited, unavailable] }));
  const rebuilt = await api.getNote(edited.id);
  assert.deepEqual(rebuilt.source_pages, pages);
  assert.equal(rebuilt.source_content, note.source_content);
  assert.equal(rebuilt.content, edited.content);
  assert.deepEqual(rebuilt.chat_excerpts, edited.chat_excerpts);
  assert.equal(rebuilt.updated_at, edited.updated_at);
  assert.equal((await api.getNote('unavailable')).source_pages, null);
  const { countLoads } = await vite.ssrLoadModule('/src/utils/pdf.ts');
  const oldText = { ...edited, id: 'rescued-text', source_content: 'Recovered from the currently unreadable page' };
  await api.importJsonBackup(JSON.stringify({ notes: [oldText] }));
  const before = countLoads();
  for (let i = 0; i < 2; i++) {
    const rescued = await api.getNote(oldText.id);
    assert.equal(rescued.source_content, oldText.source_content);
    assert.equal(rescued.source_pages, null);
  }
  assert.equal(countLoads() - before, 1);
});
