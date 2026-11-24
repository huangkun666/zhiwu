import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR } from '../db.js';
import { safeAttachmentMime } from '../shared/libraryBackup.js';

export function embeddedOriginal(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = /^data:([^,;]+);base64,([a-z\d+/\r\n]*={0,2})$/i.exec(value);
  if (!match) return null;
  const input = match[2].replace(/[\r\n]/g, '');
  const bytes = Buffer.from(input, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) return null;
  return { bytes, mime: safeAttachmentMime(match[1]) };
}

export function storedOriginalPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const filename = /^\/uploads\/([a-z\d][\w.-]*)$/i.exec(value)?.[1];
  if (!filename) return null;
  try {
    const resolved = fs.realpathSync(path.join(UPLOADS_DIR, filename));
    return path.dirname(resolved) === fs.realpathSync(UPLOADS_DIR) && fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}
