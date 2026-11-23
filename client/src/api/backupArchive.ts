import {
  createBackupManifest,
  normalizeBackupSnapshot,
  parseBackupManifest,
  safeAttachmentMime,
  type BackupAttachment,
  type BackupMissingAttachment,
  type BackupSnapshot,
} from '../../../server/src/shared/libraryBackup';

function localAttachment(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/i.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  return { mime: safeAttachmentMime(match[1]), base64: match[2] };
}

function missingOriginal(note: BackupSnapshot['notes'][number]): BackupMissingAttachment[] {
  return typeof note.source_filename === 'string' && note.source_filename
    ? [{ noteId: note.id, filename: note.source_filename }]
    : [];
}

export function offlineSnapshot(value: unknown): BackupSnapshot {
  const snapshot = normalizeBackupSnapshot(value);
  for (const note of snapshot.notes) {
    const file = localAttachment(note.attachment_path);
    note.attachment_path = file ? `data:${file.mime};base64,${file.base64}` : null;
  }
  return snapshot;
}

export async function createOfflineBackup(value: unknown): Promise<{ blob: Blob; missingAttachments: number }> {
  const snapshot = normalizeBackupSnapshot(value);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const attachments: BackupAttachment[] = [];
  const missing: BackupMissingAttachment[] = [];
  for (const note of snapshot.notes) {
    const attachment = localAttachment(note.attachment_path);
    if (!attachment) {
      missing.push(...missingOriginal(note));
      continue;
    }

    const path = `attachments/${attachments.length}`;
    zip.file(path, attachment.base64, { base64: true, compression: 'STORE' });
    attachments.push({ noteId: note.id, path, mime: attachment.mime });
  }

  zip.file('manifest.json', JSON.stringify(createBackupManifest(snapshot, attachments, missing)));
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' });
  return { blob, missingAttachments: missing.length };
}

export async function readOfflineBackup(file: File, readAttachments: boolean) {
  const prefix = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (!/\.(zip|zhiwu)$/i.test(file.name) && (prefix[0] !== 0x50 || prefix[1] !== 0x4b)) {
    let value: { exportedAt?: unknown };
    try {
      value = JSON.parse(await file.text());
    } catch {
      throw new Error('无法读取此备份文件');
    }
    const snapshot = offlineSnapshot(value);
    const attachments: BackupAttachment[] = [];
    const missingAttachments: BackupMissingAttachment[] = [];
    for (const note of snapshot.notes) {
      const attachment = localAttachment(note.attachment_path);
      if (attachment) attachments.push({ noteId: note.id, path: '', mime: attachment.mime });
      else missingAttachments.push(...missingOriginal(note));
    }
    return {
      kind: 'legacy' as const,
      exportedAt: typeof value?.exportedAt === 'string' ? value.exportedAt : undefined,
      snapshot,
      attachments,
      missingAttachments,
    };
  }

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: readAttachments });
  const manifest = zip.file('manifest.json');
  if (!manifest || (manifest.unsafeOriginalName && manifest.unsafeOriginalName !== 'manifest.json')) {
    throw new Error('备份文件中缺少资料目录');
  }
  const backup = parseBackupManifest(JSON.parse(await manifest.async('string')));
  const notes = new Map(backup.snapshot.notes.map((note) => [note.id, note]));
  for (const attachment of backup.attachments) {
    const entry = zip.file(attachment.path);
    if (!entry || (entry.unsafeOriginalName && entry.unsafeOriginalName !== attachment.path)) {
      throw new Error('备份文件中的原始附件不完整');
    }
    const note = notes.get(attachment.noteId);
    if (readAttachments && note) {
      note.attachment_path = `data:${attachment.mime};base64,${await entry.async('base64')}`;
    }
  }
  return { kind: 'archive' as const, ...backup };
}
