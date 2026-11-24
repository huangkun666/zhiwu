import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const oldBridge = globalThis.androidBridge;
const oldCapacitor = globalThis.Capacitor;
globalThis.androidBridge = {};
globalThis.Capacitor = {
  PluginHeaders: [
    { name: 'ZhiwuBackupSave', methods: ['chooseFile', 'writeChunk', 'finish', 'abort'].map((name) => ({ name, rtype: 'promise' })) },
    { name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] },
  ],
};
const { Capacitor } = await import('@capacitor/core');
const testServer = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, ws: false },
});
after(async () => {
  if (oldBridge === undefined) delete globalThis.androidBridge;
  else globalThis.androidBridge = oldBridge;
  if (oldCapacitor === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = oldCapacitor;
  await testServer.close();
});

test('saving a backup waits for the Android picker and commits only complete output', async () => {
  const calls = [];
  let cancel = true;
  let diskError = false;
  Capacitor.nativePromise = async (plugin, method, value) => {
    assert.equal(plugin, 'ZhiwuBackupSave');
    calls.push({ method, value });
    if (method === 'chooseFile') return cancel ? {} : { id: 'picked-document' };
    if (method === 'writeChunk' && diskError) throw new Error('write failed');
    return {};
  };

  const { chooseBackupDestination, saveBackupFile } = await testServer.ssrLoadModule('/src/utils/saveBackupFile.ts');
  const target = await chooseBackupDestination('library.zip');
  assert.equal(target, 'native');
  const bytes = Uint8Array.from([0, 255, 7, 209]);
  const blob = new Blob([bytes], { type: 'application/zip' });
  assert.equal(await saveBackupFile(blob, 'library.zip', target), false);
  assert.deepEqual(calls.map(({ method }) => method), ['chooseFile']);

  cancel = false;
  calls.length = 0;
  assert.equal(await saveBackupFile(blob, 'library.zip', target), true);
  assert.deepEqual(calls.map(({ method }) => method), ['chooseFile', 'writeChunk', 'finish']);
  assert.deepEqual(calls[0].value, { filename: 'library.zip', mimeType: 'application/zip', size: bytes.length });
  assert.deepEqual(new Uint8Array(Buffer.from(calls[1].value.base64, 'base64')), bytes);

  diskError = true;
  calls.length = 0;
  await assert.rejects(saveBackupFile(blob, 'library.zip', target), /write failed/);
  assert.deepEqual(calls.map(({ method }) => method), ['chooseFile', 'writeChunk', 'abort']);
});

test('an older APK can save locally with the system WebView picker, including cancel and failed writes', async (t) => {
  t.mock.method(Capacitor, 'isPluginAvailable', () => false);
  const { chooseBackupDestination, saveBackupFile } = await testServer.ssrLoadModule('/src/utils/saveBackupFile.ts');
  const calls = [];
  const blob = new Blob(['example ZIP bytes'], { type: 'application/zip' });
  let writeError = false;
  const handle = { createWritable: async () => ({
    write: async (data) => {
      calls.push('write');
      assert.equal(data, blob);
      if (writeError) throw new Error('disk full');
    },
    close: async () => calls.push('close'),
    abort: async () => calls.push('abort'),
  }) };
  const original = globalThis.showSaveFilePicker;
  t.after(() => {
    if (original) globalThis.showSaveFilePicker = original;
    else delete globalThis.showSaveFilePicker;
  });
  globalThis.showSaveFilePicker = async ({ suggestedName }) => {
    assert.equal(suggestedName, 'library.zip');
    calls.push('pick');
    return handle;
  };
  const picking = chooseBackupDestination('library.zip');
  assert.deepEqual(calls, ['pick'], 'open the picker during the original click');
  const destination = await picking;
  assert.equal(await saveBackupFile(blob, 'library.zip', destination), true);
  assert.deepEqual(calls, ['pick', 'write', 'close']);
  writeError = true;
  await assert.rejects(saveBackupFile(blob, 'library.zip', destination), /disk full/);
  assert.deepEqual(calls.slice(-2), ['write', 'abort']);
  globalThis.showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
  assert.equal(await chooseBackupDestination('library.zip'), null);
});

test('an older APK offers file sharing only when the system accepts a ZIP, and keeps cancellation distinct', async (t) => {
  t.mock.method(Capacitor, 'isPluginAvailable', () => false);
  const { chooseBackupDestination, saveBackupFile } = await testServer.ssrLoadModule('/src/utils/saveBackupFile.ts');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => Object.defineProperty(globalThis, 'navigator', original));
  let shareCount = 0;
  const navigator = {
    canShare: ({ files: [file] }) => file.type === 'application/zip' && file.name === 'library.zip',
    share: async ({ files: [file] }) => {
      shareCount++;
      assert.equal(await file.text(), 'ZIP data');
      if (shareCount === 1) throw new DOMException('cancelled', 'AbortError');
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
  const target = await chooseBackupDestination('library.zip');
  assert.equal(target, 'share');
  const blob = new Blob(['ZIP data'], { type: 'application/zip' });
  assert.equal(await saveBackupFile(blob, 'library.zip', target), false);
  assert.equal(await saveBackupFile(blob, 'library.zip', target), true);
  navigator.canShare = () => false;
  await assert.rejects(chooseBackupDestination('library.zip'), /局域网快传.*接收备份/);
  assert.equal(shareCount, 2);
});

test('backup QR destinations are explicit local addresses with a receive token', async () => {
  const { parseBackupReceiveUrl } = await testServer.ssrLoadModule('/@fs/' + fileURLToPath(new URL('../../server/src/shared/backupReceive.ts', import.meta.url)));
  const path = `/api/transfer/backup/${'d'.repeat(32)}`;
  assert.equal(parseBackupReceiveUrl(`http://192.168.1.2:3001${path}`)?.hostname, '192.168.1.2');
  assert.equal(parseBackupReceiveUrl(`http://172.31.0.1${path}`)?.hostname, '172.31.0.1');
  assert.equal(parseBackupReceiveUrl(`http://100.101.102.103${path}`)?.hostname, '100.101.102.103');
  assert.equal(parseBackupReceiveUrl(`https://example.com${path}`), null);
  assert.equal(parseBackupReceiveUrl(`https://1.2.3.4${path}`), null);
  assert.equal(parseBackupReceiveUrl(`http://user@192.168.1.2${path}`), null);
  assert.equal(parseBackupReceiveUrl(`http://192.168.1.2${path}?forward=https://example.com`), null);
});

test('the Android LAN fallback sends chunks with redirects disabled', async () => {
  const calls = [];
  const size = 512 * 1024 + 2;
  Capacitor.nativePromise = async (plugin, method, options) => {
    assert.equal(plugin, 'CapacitorHttp');
    assert.equal(method, 'request');
    assert.equal(options.disableRedirects, true);
    calls.push(options);
    if (options.method === 'GET') return { status: 200, data: { kind: 'backup-receive' } };
    const bytes = Buffer.from(options.data[0].value, 'base64');
    const receivedBytes = Number(options.headers['X-Zhiwu-Backup-Offset']) + bytes.length;
    return { status: 200, data: { receivedBytes, ready: receivedBytes === size } };
  };
  const { verifyBackupReceiver, sendBackupToComputer } = await testServer.ssrLoadModule('/src/utils/sendBackupToComputer.ts');
  const path = `/api/transfer/backup/${'f'.repeat(32)}`;
  await assert.rejects(verifyBackupReceiver(new URL(`http://example.com${path}`)), /局域网/);
  assert.equal(calls.length, 0);

  const destination = new URL(`http://192.168.0.10:3001${path}`);
  const bytes = new Uint8Array(size).fill(193);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  const updates = [];
  await verifyBackupReceiver(destination);
  await sendBackupToComputer(destination, new Blob([bytes]), (sent) => updates.push(sent));
  assert.deepEqual(calls.map(({ method }) => method), ['GET', 'PUT', 'PUT']);
  assert.equal(calls[1].headers['X-Zhiwu-Backup-Upload'], calls[2].headers['X-Zhiwu-Backup-Upload']);
  assert.deepEqual(calls.slice(1).map(({ dataType }) => dataType), ['formData', 'formData']);
  assert.deepEqual(calls.slice(1).map(({ data }) => data[0].type), ['base64File', 'base64File']);
  const sent = Buffer.concat(calls.slice(1).map(({ data }) => Buffer.from(data[0].value, 'base64')));
  assert.deepEqual(new Uint8Array(sent), bytes);
  assert.deepEqual(updates, [512 * 1024, size]);
});
