import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('a revoked or unmounted phone request never reaches the note tools', async (t) => {
  const previous = { bridge: globalThis.androidBridge, capacitor: globalThis.Capacitor };
  t.after(() => {
    if (previous.bridge === undefined) delete globalThis.androidBridge;
    else globalThis.androidBridge = previous.bridge;
    if (previous.capacitor === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = previous.capacitor;
  });
  globalThis.androidBridge = {};
  globalThis.Capacitor = { PluginHeaders: [{ name: 'ZhiwuMcp', methods: [
    { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' },
    { name: 'takeRequest', rtype: 'promise' }, { name: 'respond', rtype: 'promise' },
  ] }] };
  const { Capacitor } = await import('@capacitor/core');
  const registered = Promise.withResolvers();
  const claimed = Promise.withResolvers();
  const removed = Promise.withResolvers();
  Capacitor.nativeCallback = (_plugin, method, options, notify) => {
    assert.equal(method, 'addListener');
    assert.equal(options.eventName, 'mcpRequest');
    registered.resolve(notify);
    return 'subscription';
  };
  const calls = [];
  Capacitor.nativePromise = async (_plugin, method, { id }) => {
    calls.push(method);
    if (method === 'takeRequest') {
      claimed.resolve(id);
      return { request: null };
    }
    if (method === 'removeListener') removed.resolve();
  };
  const vite = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'error',
    server: { middlewareMode: true, ws: false, watch: null }, optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());
  const { servePhoneMcp } = await vite.ssrLoadModule('/src/api/phoneMcpBridge.ts');
  const unsubscribe = servePhoneMcp(() => assert.fail('revoked request changed the library'));
  const notify = await registered.promise;
  notify({ id: 'revoked' });
  assert.equal(await claimed.promise, 'revoked');
  unsubscribe();
  await removed.promise;
  notify({ id: 'after-unmount' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['takeRequest', 'removeListener']);
});
