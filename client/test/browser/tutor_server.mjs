// Isolated Vite and desktop API origins for browser integration tests.
import { once } from 'node:events';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as reservePort } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer } from 'vite';

const client = fileURLToPath(new URL('../../', import.meta.url));
const backend = fileURLToPath(new URL('../../../server/', import.meta.url));
const express = createRequire(join(backend, 'package.json'))('express');
const fixture = await mkdtemp(join(backend, '.tutor-browser-'));
const compiled = join(fixture, 'server', 'dist');
const frontends = [];
let db;
let http;
let offline;

async function close() {
  await Promise.all(frontends.map((server) => server.close()));
  for (const server of [http, offline]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  db?.close();
  await rm(fixture, { recursive: true, force: true, maxRetries: 3 });
}

try {
  for (const name of ['db.js', 'routes', 'services', 'shared']) {
    await cp(join(backend, 'dist', name), join(compiled, name), { recursive: true });
  }
  const database = await import(pathToFileURL(join(compiled, 'db.js')));
  database.initDatabase();
  db = database.db;
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  for (const name of ['categories', 'dashboard', 'notes', 'tutor', 'settings']) {
    const routes = await import(pathToFileURL(join(compiled, 'routes', name + '.js')));
    app.use('/api/' + name, routes[name + 'Router']);
  }
  app.use('/uploads', express.static(database.UPLOADS_DIR));
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const api = 'http://127.0.0.1:' + http.address().port;
  const origins = { database: database.DB_PATH };
  const production = process.argv.includes('--built-history');
  if (production) {
    app.use(express.static(join(client, 'dist')));
    origins.desktop = api;
    const standaloneDir = join(fixture, 'standalone-dist');
    await build({
      root: client, logLevel: 'error', cacheDir: join(fixture, 'vite-build-cache'),
      define: { 'import.meta.env.VITE_STANDALONE': '"true"' },
      build: { outDir: standaloneDir },
    });
    offline = express().use(express.static(standaloneDir)).listen(0, '127.0.0.1');
    await once(offline, 'listening');
    origins.standalone = 'http://127.0.0.1:' + offline.address().port;
  }
  for (const mode of production ? [] : ['desktop', 'standalone']) {
    const reservation = reservePort().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const server = await createServer({
      root: client, cacheDir: join(fixture, 'vite-' + mode), logLevel: 'error',
      optimizeDeps: { entries: ['index.html'] },
      define: { 'import.meta.env.VITE_STANDALONE': JSON.stringify(String(mode === 'standalone')) },
      server: {
        host: '127.0.0.1', port, strictPort: true, hmr: false,
        proxy: { '/api': { target: api }, '/uploads': { target: api } },
      },
    });
    frontends.push(server);
    await server.listen();
    origins[mode] = 'http://127.0.0.1:' + server.httpServer.address().port;
  }
  process.stdout.write(JSON.stringify(origins) + '\n');
  // Shut down before closing stdin; Vite's Windows EOF handler can exit the process.
  process.stdin.resume();
  await once(process.stdin, 'data');
  process.stdin.pause();
} finally {
  await close();
}
