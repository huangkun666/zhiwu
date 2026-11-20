import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { db, nowIso, UPLOADS_DIR } from '../db.js';
import { getLocalNetworkAdapters } from './settings.js';

export const transferRouter = Router();

const TRANSFER_DIR = path.join(UPLOADS_DIR, 'transfer');
fs.mkdirSync(TRANSFER_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TRANSFER_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

interface StagedTransfer {
  token: string;
  kind: 'files' | 'sync';
  files?: { name: string; mimeType: string; path: string }[];
  createdAt: number;
}

const stagedMap = new Map<string, StagedTransfer>();

// Periodically purge staged transfers older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [token, item] of stagedMap.entries()) {
    if (item.createdAt < cutoff) {
      item.files?.forEach((f) => fs.unlink(f.path, () => {}));
      stagedMap.delete(token);
    }
  }
}, 5 * 60 * 1000).unref();

function buildExportSnapshot() {
  const categories = db.prepare(`SELECT * FROM categories`).all();
  const notes = (db.prepare(`SELECT * FROM notes`).all() as any[]).map((n) => ({
    ...n,
    tags: JSON.parse(n.tags || '[]'),
    summary: n.summary_json ? JSON.parse(n.summary_json) : null,
    is_pinned: Boolean(n.is_pinned),
  }));
  const syntheses = (db.prepare(`SELECT * FROM syntheses`).all() as any[]).map((s) => ({
    ...s,
    note_ids: JSON.parse(s.note_ids || '[]'),
  }));
  const concepts = (db.prepare(`SELECT * FROM concepts`).all() as any[]).map((c) => {
    const noteIds = (
      db.prepare(`SELECT note_id FROM note_concepts WHERE concept_id = ?`).all(c.id) as { note_id: string }[]
    ).map((r) => r.note_id);
    return { ...c, note_ids: noteIds };
  });
  const conceptLinks = db
    .prepare(`SELECT id, source_id as source, target_id as target, relation, weight FROM concept_links`)
    .all();
  const flashcards = db.prepare(`SELECT * FROM flashcards`).all();
  const mistakes = (db.prepare(`SELECT * FROM mistakes`).all() as any[]).map((m) => ({
    ...m,
    options: JSON.parse(m.options_json || '[]'),
  }));
  const studyLogs = db.prepare(`SELECT * FROM study_logs`).all();

  return {
    version: 1,
    exportedAt: nowIso(),
    categories,
    notes,
    syntheses,
    concepts,
    conceptLinks,
    flashcards,
    mistakes,
    studyLogs,
  };
}

async function buildQrPayload(token: string, port: string, requestedIp?: string) {
  const adapters = getLocalNetworkAdapters();
  const ips = adapters.map((a) => a.address);
  const primaryIp = requestedIp && ips.includes(requestedIp) ? requestedIp : adapters[0]?.address || '127.0.0.1';
  const url = `http://${primaryIp}:${port}/api/transfer/${token}`;
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: 240,
    margin: 2,
    color: { dark: '#09090B', light: '#FFFFFF' },
  });
  return { token, url, qrDataUrl, adapters, primaryIp };
}

// Stage one or more PC files for Android APK QR scan import
transferRouter.post('/stage-files', upload.array('files', 10), async (req, res) => {
  const uploaded = (req.files as Express.Multer.File[]) || [];
  if (uploaded.length === 0) {
    return res.status(400).json({ error: '请先选择至少一个要发送给手机的文件' });
  }

  const files = uploaded.map((f) => {
    let originalName = f.originalname;
    try {
      const decoded = Buffer.from(f.originalname, 'latin1').toString('utf8');
      if (!decoded.includes('\uFFFD') && /[\u4e00-\u9fff]/.test(decoded)) {
        originalName = decoded;
      }
    } catch {
      // keep original
    }
    return { name: originalName, mimeType: f.mimetype || 'application/octet-stream', path: f.path };
  });

  const token = crypto.randomBytes(6).toString('hex');
  stagedMap.set(token, { token, kind: 'files', files, createdAt: Date.now() });

  const port = String(req.body?.port || process.env.PORT || '3001');
  const ip = req.body?.ip ? String(req.body.ip) : undefined;
  const qr = await buildQrPayload(token, port, ip);
  res.json({ ...qr, kind: 'files', fileNames: files.map((f) => f.name) });
});

// Stage full PC knowledge base sync snapshot for Android APK QR scan
transferRouter.post('/stage-sync', async (req, res) => {
  const token = crypto.randomBytes(6).toString('hex');
  stagedMap.set(token, { token, kind: 'sync', createdAt: Date.now() });
  const port = String(req.body?.port || process.env.PORT || '3001');
  const ip = req.body?.ip ? String(req.body.ip) : undefined;
  const qr = await buildQrPayload(token, port, ip);
  res.json({ ...qr, kind: 'sync' });
});

// Regenerate QR code for a different NIC IP without re-uploading files
transferRouter.get('/:token/qr', async (req, res) => {
  const item = stagedMap.get(req.params.token);
  if (!item) return res.status(404).json({ error: '快传码已过期，请重新生成' });
  const port = String(req.query.port || process.env.PORT || '3001');
  const ip = req.query.ip ? String(req.query.ip) : undefined;
  const qr = await buildQrPayload(item.token, port, ip);
  res.json({ ...qr, kind: item.kind, fileNames: item.files?.map((f) => f.name) || [] });
});

// Android APK pulls staged files or sync snapshot after scanning QR code
transferRouter.get('/:token', (req, res) => {
  const item = stagedMap.get(req.params.token);
  if (!item) {
    return res.status(404).json({ error: '快传链接已过期或不存在，请在电脑端重新生成二维码' });
  }

  if (item.kind === 'sync') {
    return res.json({ kind: 'sync', payload: buildExportSnapshot() });
  }

  const files = (item.files || [])
    .filter((f) => fs.existsSync(f.path))
    .map((f) => ({
      name: f.name,
      mimeType: f.mimeType,
      base64: fs.readFileSync(f.path).toString('base64'),
    }));

  if (files.length === 0) {
    return res.status(404).json({ error: '暂存文件已失效，请重新选择文件生成二维码' });
  }

  res.json({ kind: 'files', files });
});
