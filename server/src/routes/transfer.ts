import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { DATA_DIR, nowIso, UPLOADS_DIR } from '../db.js';
import { readBackupSnapshot } from '../services/backupSnapshot.js';
import { BACKUP_CHUNK_SIZE, isLocalBackupHost } from '../shared/backupReceive.js';
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

const BACKUP_TRANSFER_DIR = path.join(DATA_DIR, 'backup-transfers');
fs.mkdirSync(BACKUP_TRANSFER_DIR, { recursive: true });
const TRANSFER_LIFETIME_MS = 30 * 60 * 1000;

interface BackupReceive {
  receipt: string;
  uploadToken: string;
  path: string;
  expiresAt: number;
  uploadId?: string;
  totalBytes: number;
  receivedBytes: number;
}

const backupReceipts = new Map<string, BackupReceive>();
const backupUploads = new Map<string, BackupReceive>();
const backupChunk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BACKUP_CHUNK_SIZE, files: 1, fields: 0, parts: 1 },
}).single('chunk');

function activeBackup(map: Map<string, BackupReceive>, token: string): BackupReceive | undefined {
  const backup = map.get(token);
  return backup && backup.expiresAt > Date.now() ? backup : undefined;
}

// Periodically purge staged transfers older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - TRANSFER_LIFETIME_MS;
  for (const [token, item] of stagedMap.entries()) {
    if (item.createdAt < cutoff) {
      item.files?.forEach((f) => fs.unlink(f.path, () => {}));
      stagedMap.delete(token);
    }
  }
  for (const [receipt, backup] of backupReceipts) {
    if (backup.expiresAt <= Date.now()) {
      backupReceipts.delete(receipt);
      backupUploads.delete(backup.uploadToken);
    }
  }
  fs.readdir(BACKUP_TRANSFER_DIR, { withFileTypes: true }, (error, entries) => {
    if (error) return;
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{32}\.zip$/.test(entry.name)) continue;
      if (backupReceipts.has(path.basename(entry.name, '.zip'))) continue;
      const filename = path.join(BACKUP_TRANSFER_DIR, entry.name);
      fs.stat(filename, (statError, stats) => {
        if (!statError && stats.mtimeMs < cutoff) fs.unlink(filename, () => {});
      });
    }
  });
}, 5 * 60 * 1000).unref();

async function buildQrPayload(token: string, port: string, requestedIp?: string, receiveBackup = false) {
  const adapters = getLocalNetworkAdapters().filter((adapter) => !receiveBackup || isLocalBackupHost(adapter.address));
  const ips = adapters.map((a) => a.address);
  const primaryIp = requestedIp && ips.includes(requestedIp) ? requestedIp : adapters[0]?.address || '127.0.0.1';
  const suffix = receiveBackup ? `backup/${token}` : token;
  const url = `http://${primaryIp}:${port}/api/transfer/${suffix}`;
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: 240,
    margin: 2,
    color: { dark: '#09090B', light: '#FFFFFF' },
  });
  return { token, url, qrDataUrl, adapters, primaryIp };
}

function backupQrPort(value: unknown): string {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : '3001';
}

transferRouter.post('/backup-receive', async (req, res) => {
  const receipt = crypto.randomBytes(16).toString('hex');
  const uploadToken = crypto.randomBytes(16).toString('hex');
  const backup: BackupReceive = {
    receipt,
    uploadToken,
    path: path.join(BACKUP_TRANSFER_DIR, `${receipt}.zip`),
    expiresAt: Date.now() + TRANSFER_LIFETIME_MS,
    totalBytes: 0,
    receivedBytes: 0,
  };
  const qr = await buildQrPayload(uploadToken, backupQrPort(req.body?.port), undefined, true);
  backupReceipts.set(receipt, backup);
  backupUploads.set(uploadToken, backup);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ ...qr, token: receipt, kind: 'backup-receive' });
});

transferRouter.get('/backup-receive/:receipt/qr', async (req, res) => {
  const backup = activeBackup(backupReceipts, req.params.receipt);
  if (!backup) return res.status(404).json({ error: '备份接收码已过期，请重新生成' });
  const ip = typeof req.query.ip === 'string' ? req.query.ip : undefined;
  const qr = await buildQrPayload(backup.uploadToken, backupQrPort(req.query.port), ip, true);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...qr, token: backup.receipt, kind: 'backup-receive' });
});

transferRouter.get('/backup-receive/:receipt', (req, res) => {
  const backup = activeBackup(backupReceipts, req.params.receipt);
  if (!backup) return res.status(404).json({ error: '备份接收码已过期，请重新生成' });
  const ready = backup.totalBytes > 0 && backup.receivedBytes === backup.totalBytes;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ready,
    totalBytes: backup.totalBytes,
    receivedBytes: backup.receivedBytes,
    expiresAt: backup.expiresAt,
    downloadPath: ready ? `/api/transfer/backup-receive/${backup.receipt}/download` : null,
  });
});

transferRouter.get('/backup-receive/:receipt/download', (req, res) => {
  const backup = activeBackup(backupReceipts, req.params.receipt);
  if (!backup || backup.totalBytes === 0 || backup.receivedBytes !== backup.totalBytes || !fs.existsSync(backup.path)) {
    return res.status(404).json({ error: '备份文件尚未接收完成或已过期' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.download(path.basename(backup.path), `zhiwu-backup-${new Date().toISOString().slice(0, 10)}.zip`, { root: BACKUP_TRANSFER_DIR });
});

transferRouter.get('/backup/:token', (req, res) => {
  const backup = activeBackup(backupUploads, req.params.token);
  if (!backup) return res.status(404).json({ error: '备份接收码已过期，请在电脑端重新生成' });
  if (backup.totalBytes > 0 && backup.receivedBytes === backup.totalBytes) {
    return res.status(409).json({ error: '电脑已收到备份。请重新生成接收码以发送另一份' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ kind: 'backup-receive' });
});

transferRouter.put('/backup/:token', (req, res) => {
  const token = req.params.token;
  if (!activeBackup(backupUploads, token)) return res.status(404).json({ error: '备份接收码已过期' });
  backupChunk(req, res, (error) => {
    if (error) return res.status(400).json({ error: '收到的备份分段无效' });
    const backup = activeBackup(backupUploads, token);
    if (!backup) return res.status(404).json({ error: '备份接收码已过期' });
    if (backup.totalBytes > 0 && backup.receivedBytes === backup.totalBytes) {
      return res.status(409).json({ error: '这份备份已接收完成' });
    }
    const uploadId = req.get('X-Zhiwu-Backup-Upload') || '';
    const totalBytes = Number(req.get('X-Zhiwu-Backup-Size'));
    const offset = Number(req.get('X-Zhiwu-Backup-Offset'));
    const chunk = req.file?.buffer;
    if (!chunk?.length || !/^[a-f0-9]{32}$/.test(uploadId) || !Number.isSafeInteger(totalBytes) ||
        !Number.isSafeInteger(offset) || offset < 0 || totalBytes < 4 || offset > totalBytes - chunk.length) {
      return res.status(400).json({ error: '收到的备份分段无效' });
    }
    if (offset !== 0 && (backup.uploadId !== uploadId || offset !== backup.receivedBytes || totalBytes !== backup.totalBytes)) {
      return res.status(409).json({ error: '备份传输进度已变化，请重新扫码发送' });
    }
    if (offset === 0 && (chunk.length < 4 || chunk.readUInt32BE(0) !== 0x504b0304)) {
      return res.status(400).json({ error: '收到的文件不是 ZIP 备份' });
    }
    try {
      fs.writeFileSync(backup.path, chunk, { flag: offset === 0 ? 'w' : 'a' });
    } catch {
      backup.uploadId = undefined;
      backup.totalBytes = 0;
      backup.receivedBytes = 0;
      return res.status(500).json({ error: '电脑未能写入备份，请检查存储空间后重试' });
    }
    backup.uploadId = uploadId;
    backup.totalBytes = totalBytes;
    backup.receivedBytes = offset + chunk.length;
    backup.expiresAt = Date.now() + TRANSFER_LIFETIME_MS;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ receivedBytes: backup.receivedBytes, ready: backup.receivedBytes === totalBytes });
  });
});

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
    return res.json({ kind: 'sync', payload: { version: 1, exportedAt: nowIso(), ...readBackupSnapshot() } });
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
