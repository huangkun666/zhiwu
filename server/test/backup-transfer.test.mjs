import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import express from 'express';

test('a backup can be received in chunks and downloaded only with the desktop receipt', async () => {
  const dist = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const fixture = mkdtempSync(join(dist, 'backup-transfer-test-'));
  const copiedDist = join(fixture, '.zhiwu', 'server', 'dist');
  mkdirSync(copiedDist, { recursive: true });
  for (const entry of ['db.js', 'routes', 'services', 'shared']) {
    cpSync(join(dist, entry), join(copiedDist, entry), { recursive: true });
  }

  const { transferRouter } = await import(pathToFileURL(join(copiedDist, 'routes', 'transfer.js')));
  const { db } = await import(pathToFileURL(join(copiedDist, 'db.js')));
  const app = express();
  app.use(express.json());
  app.use('/api/transfer', transferRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const staged = await fetch(`${origin}/api/transfer/backup-receive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }),
    });
    assert.equal(staged.status, 201);
    const receipt = await staged.json();
    const upload = new URL(receipt.url).pathname;
    const uploadToken = upload.split('/').at(-1);
    assert.notEqual(receipt.token, uploadToken);
    assert.deepEqual(await (await fetch(`${origin}${upload}`)).json(), { kind: 'backup-receive' });
    assert.equal((await fetch(`${origin}/api/transfer/backup-receive/${receipt.token}/download`)).status, 404);

    // A valid local-header signature. The receive route stores bytes, while restoration examines the archive.
    const chunkSize = 512 * 1024;
    const archive = new Uint8Array(chunkSize + 8).fill(250);
    archive.set([0x50, 0x4b, 0x03, 0x04]);
    async function sendChunk(offset, bytes, id = 'a'.repeat(32)) {
      const form = new FormData();
      form.append('chunk', new Blob([bytes]), 'chunk');
      return fetch(`${origin}${upload}`, {
        method: 'PUT',
        headers: {
          'X-Zhiwu-Backup-Upload': id,
          'X-Zhiwu-Backup-Size': String(archive.length),
          'X-Zhiwu-Backup-Offset': String(offset),
        },
        body: form,
      });
    }

    assert.equal((await sendChunk(1, archive.slice(1, 9))).status, 409);
    assert.equal((await sendChunk(0, Uint8Array.from([0, 1, 2, 3]))).status, 400);
    assert.equal((await sendChunk(0, archive.slice(0, chunkSize + 1))).status, 400);
    assert.equal((await sendChunk(0, archive.slice(0, chunkSize))).status, 200);
    assert.equal((await sendChunk(chunkSize, archive.slice(chunkSize), 'b'.repeat(32))).status, 409);
    assert.equal((await sendChunk(chunkSize, archive.slice(chunkSize))).status, 200);
    assert.equal((await sendChunk(0, archive.slice(0, chunkSize))).status, 409);

    const status = await (await fetch(`${origin}/api/transfer/backup-receive/${receipt.token}`)).json();
    assert.equal(status.ready, true);
    assert.equal(status.receivedBytes, archive.length);
    assert.equal((await fetch(`${origin}/api/transfer/backup-receive/${uploadToken}/download`)).status, 404);
    const download = await fetch(`${origin}${status.downloadPath}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment;.*\.zip/);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), archive);
  } finally {
    await new Promise((done) => server.close(done));
    db.close();
    if (dirname(fixture) === dist && basename(fixture).startsWith('backup-transfer-test-')) {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});
