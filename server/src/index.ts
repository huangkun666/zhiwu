import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, PROJECT_ROOT, UPLOADS_DIR } from './db.js';
import { categoriesRouter } from './routes/categories.js';
import { notesRouter } from './routes/notes.js';
import { quizzesRouter } from './routes/quizzes.js';
import { mistakesRouter } from './routes/mistakes.js';
import { flashcardsRouter } from './routes/flashcards.js';
import { graphRouter } from './routes/graph.js';
import { tutorRouter } from './routes/tutor.js';
import { dashboardRouter } from './routes/dashboard.js';
import { getLocalIPv4Addresses, settingsRouter } from './routes/settings.js';
import { transferRouter } from './routes/transfer.js';

initDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Static uploaded attachments (PDFs, images)
app.use('/uploads', express.static(UPLOADS_DIR));

// API routes
app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: '知悟 (Zhiwu)' }));
app.use('/api/dashboard', dashboardRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/notes', notesRouter);
app.use('/api/quizzes', quizzesRouter);
app.use('/api/mistakes', mistakesRouter);
app.use('/api/flashcards', flashcardsRouter);
app.use('/api/graph', graphRouter);
app.use('/api/tutor', tutorRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/transfer', transferRouter);

// Serve built frontend in single-port production mode (ideal for Desktop + Android LAN/Cloud!)
const clientDistDir = path.join(PROJECT_ROOT, 'client', 'dist');
if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get(/^\/(?!api|uploads).*/, (_req, res) => {
    res.sendFile(path.join(clientDistDir, 'index.html'));
  });
}

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Zhiwu Server Error]', err);
  res.status(500).json({ error: err?.message || '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3001;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  const ips = getLocalIPv4Addresses();
  console.log(`\n✨ 「知悟」学习平台服务已启动`);
  console.log(`   电脑本机访问: http://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log(`   安卓手机局域网访问 (同Wi-Fi): http://${ips[0]}:${PORT}`);
  }
  console.log('');
});
