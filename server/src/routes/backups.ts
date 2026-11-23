import { Router, type RequestHandler } from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import { todayKey } from '../db.js';
import { BACKUP_STAGING_DIR, exportBackupArchive, previewBackupArchive, restoreBackupArchive } from '../services/backupArchive.js';

export const backupsRouter = Router();
const upload = multer({ dest: BACKUP_STAGING_DIR, limits: { files: 1 } });

backupsRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

backupsRouter.get('/', (_req, res, next) => {
  const { manifest, stream } = exportBackupArchive();
  res.attachment(`zhiwu-backup-${todayKey()}.zip`);
  res.setHeader('X-Zhiwu-Missing-Attachments', String(manifest.missingAttachments.length));
  res.once('close', () => stream.destroy());
  stream.once('error', (error) => {
    if (res.headersSent) res.destroy(error);
    else next(error);
  });
  stream.pipe(res);
});

function withBackupUpload(operation: (file: string) => Promise<unknown>): RequestHandler {
  return async (req, res) => {
    const filename = req.file?.path;
    if (!filename) {
      res.status(400).json({ error: '请选择要导入的备份文件' });
      return;
    }
    let status = 200;
    let result: unknown;
    try {
      result = await operation(filename);
    } catch (error) {
      const message = error instanceof Error ? error.message : '备份读取失败';
      status = 400;
      result = { error: message };
    } finally {
      await fs.unlink(filename).catch(() => {});
    }
    res.status(status).json(result);
  };
}

backupsRouter.post('/preview', upload.single('backup'), withBackupUpload(previewBackupArchive));
backupsRouter.post('/restore', upload.single('backup'), withBackupUpload(restoreBackupArchive));
