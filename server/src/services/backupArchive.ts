import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import { DATA_DIR, UPLOADS_DIR, inTransaction, uid } from '../db.js';
import {
  createBackupManifest,
  describeBackup,
  mergeBackupSnapshots,
  normalizeBackupSnapshot,
  parseBackupManifest,
  type BackupAttachment,
  type BackupMissingAttachment,
  type BackupRecord,
  type BackupSnapshot,
} from '../shared/libraryBackup.js';
import { applyBackupSnapshot, readBackupSnapshot } from './backupSnapshot.js';
import { scheduleKnowledge } from './knowledgeIndex.js';
import { readKnowledgeIndex } from '../shared/knowledgePoints.js';
import { embeddedOriginal, storedOriginalPath } from './noteOriginal.js';

export const BACKUP_STAGING_DIR = path.join(DATA_DIR, 'backup-staging');
fs.mkdirSync(BACKUP_STAGING_DIR, { recursive: true });

const extensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  'image/avif': 'avif', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif',
};

function knownExtension(mime: string): string {
  return extensions[mime] ?? 'bin';
}

function mimeForOriginal(note: BackupRecord, filename: string): string {
  const extension = path.extname(filename).slice(1).toLowerCase();
  const normalized = ({ jpeg: 'jpg', markdown: 'md', tif: 'tiff' } as Record<string, string>)[extension] ?? extension;
  const found = Object.entries(extensions).find(([, ext]) => ext === normalized)?.[0];
  if (found) return found;
  if (note.source_type === 'pdf') return 'application/pdf';
  if (note.source_type === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

function absentOriginal(note: BackupRecord): BackupMissingAttachment | null {
  if (!note.source_filename && !note.attachment_path) return null;
  const filename = typeof note.source_filename === 'string' && note.source_filename
    ? note.source_filename
    : typeof note.title === 'string' ? note.title : '原文件';
  return { noteId: note.id, filename };
}

export function exportBackupArchive() {
  const snapshot = inTransaction(readBackupSnapshot);
  const zip = new JSZip();
  const attachments: BackupAttachment[] = [];
  const missingAttachments: BackupMissingAttachment[] = [];
  for (const note of snapshot.notes) {
    const file = storedOriginalPath(note.attachment_path);
    const embedded = embeddedOriginal(note.attachment_path);
    try {
      const bytes = file ? fs.readFileSync(file) : embedded?.bytes;
      if (bytes) {
        const mime = file
          ? mimeForOriginal(note, typeof note.source_filename === 'string' ? note.source_filename : file)
          : embedded!.mime;
        const name = `attachments/${attachments.length}.${knownExtension(mime)}`;
        zip.file(name, bytes, { compression: 'STORE' });
        attachments.push({ noteId: note.id, path: name, mime });
        continue;
      }
    } catch (error) {
      if (!file) throw error;
    }
    const missing = absentOriginal(note);
    if (missing) missingAttachments.push(missing);
  }
  const manifest = createBackupManifest(snapshot, attachments, missingAttachments);
  zip.file('manifest.json', JSON.stringify(manifest), { compression: 'DEFLATE' });
  return { manifest, stream: zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true }) as Readable };
}

interface BackupPackage {
  kind: 'archive' | 'legacy';
  exportedAt?: string;
  snapshot: BackupSnapshot;
  attachments: BackupAttachment[];
  missingAttachments: BackupMissingAttachment[];
  readAttachment(name: string): Promise<Buffer>;
}

function isZipFile(bytes: Buffer): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function decodeBackupJson(contents: string): unknown {
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('备份中的 JSON 无法读取');
  }
}

async function readArchive(bytes: Buffer, verifyCrc: boolean): Promise<BackupPackage> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: verifyCrc });
  } catch {
    throw new Error('ZIP 备份已损坏或无法读取');
  }
  const json = zip.file('manifest.json');
  if (!json || json.unsafeOriginalName !== json.name) throw new Error('ZIP 文件中缺少有效的备份清单');
  const manifest = parseBackupManifest(decodeBackupJson(await json.async('string')));
  for (const attachment of manifest.attachments) {
    const source = zip.file(attachment.path);
    if (!source || source.unsafeOriginalName !== source.name) throw new Error('ZIP 文件中缺少备份清单要求的附件');
  }
  return { ...manifest, kind: 'archive', readAttachment: (name) => zip.file(name)!.async('nodebuffer') };
}

function readLegacy(value: unknown): BackupPackage {
  const snapshot = normalizeBackupSnapshot(value);
  const { exportedAt } = value as { exportedAt?: unknown };
  const originals = new Map<string, Buffer>();
  const attachments: BackupAttachment[] = [];
  const missingAttachments: BackupMissingAttachment[] = [];
  for (const note of snapshot.notes) {
    const embedded = embeddedOriginal(note.attachment_path);
    if (embedded) {
      const path = `attachments/${attachments.length}.${knownExtension(embedded.mime)}`;
      originals.set(path, embedded.bytes);
      attachments.push({ noteId: note.id, path, mime: embedded.mime });
    } else {
      const missing = absentOriginal(note);
      if (missing) missingAttachments.push(missing);
    }
    delete note.attachment_path;
  }
  return {
    kind: 'legacy',
    exportedAt: typeof exportedAt === 'string' ? exportedAt : undefined,
    snapshot, attachments, missingAttachments,
    readAttachment: async (name) => originals.get(name)!,
  };
}

async function readUploadedBackup(filename: string, verifyCrc: boolean): Promise<BackupPackage> {
  const bytes = await fs.promises.readFile(filename);
  return isZipFile(bytes) ? readArchive(bytes, verifyCrc) : readLegacy(decodeBackupJson(bytes.toString('utf8')));
}

export async function previewBackupArchive(filename: string) {
  const backup = await readUploadedBackup(filename, false);
  return describeBackup(backup.snapshot, inTransaction(readBackupSnapshot), backup);
}

function removeFiles(files: Iterable<string>) {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[Zhiwu Backup Cleanup]', error);
    }
  }
}

export async function restoreBackupArchive(filename: string) {
  return restoreBackup(await readUploadedBackup(filename, true));
}

export async function restoreLegacyBackup(value: unknown) {
  const backup = readLegacy(value);
  const restored = await restoreBackup(backup);
  return { ...restored, cardsMerged: backup.snapshot.flashcards.length, mistakesMerged: backup.snapshot.mistakes.length };
}

async function restoreBackup(backup: BackupPackage) {
  const notes = new Map(backup.snapshot.notes.map((note) => [note.id, note]));
  const staged = new Map<string, { temp: string; final: string }>();
  const promoted: string[] = [];
  try {
    for (const { noteId, path: entry, mime } of backup.attachments) {
      const id = uid();
      const name = `backup-${id}.${knownExtension(mime)}`;
      const destination = `/uploads/${name}`;
      const temp = path.join(BACKUP_STAGING_DIR, `${id}.part`);
      staged.set(destination, { temp, final: path.join(UPLOADS_DIR, name) });
      await fs.promises.writeFile(temp, await backup.readAttachment(entry), { flag: 'wx' });
      notes.get(noteId)!.attachment_path = destination;
    }
    const { pendingIds, ...restored } = inTransaction(() => {
      const local = readBackupSnapshot();
      for (const note of local.notes) {
        if (!storedOriginalPath(note.attachment_path) && !embeddedOriginal(note.attachment_path)) note.attachment_path = null;
      }
      const { snapshot, notesCount } = mergeBackupSnapshots(local, backup.snapshot);
      const localNotes = new Map(local.notes.map((note) => [note.id, note]));
      const changedNotes = snapshot.notes.filter((note) => localNotes.get(note.id) !== note);
      for (const note of changedNotes) {
        if (typeof note.attachment_path !== 'string') continue;
        const file = staged.get(note.attachment_path);
        if (!file) continue;
        fs.renameSync(file.temp, file.final);
        promoted.push(file.final);
      }
      applyBackupSnapshot(snapshot, changedNotes);
      const pendingIds = changedNotes.filter(note => !note.deleted_at && readKnowledgeIndex(note.knowledge_index)?.status === 'pending')
        .map(note => note.id);
      return { ok: true, notesCount, pendingIds };
    });
    scheduleKnowledge(pendingIds);
    return restored;
  } catch (error) {
    removeFiles(promoted);
    throw error;
  } finally {
    removeFiles(Array.from(staged.values(), (file) => file.temp));
  }
}
