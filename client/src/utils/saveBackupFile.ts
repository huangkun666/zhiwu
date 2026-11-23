import { Capacitor, registerPlugin } from '@capacitor/core';
import { BACKUP_CHUNK_SIZE } from '../../../server/src/shared/backupReceive';

interface NativeBackupSave {
  chooseFile(options: { filename: string; mimeType: string; size: number }): Promise<{ id?: string }>;
  writeChunk(options: { id: string; base64: string }): Promise<void>;
  finish(options: { id: string }): Promise<void>;
  abort(options: { id: string }): Promise<void>;
}

const PLUGIN_NAME = 'ZhiwuBackupSave';
const nativeSave = registerPlugin<NativeBackupSave>(PLUGIN_NAME);

export function canSaveBackupFile(): boolean {
  return !Capacitor.isNativePlatform() || Capacitor.isPluginAvailable(PLUGIN_NAME);
}

export async function encodeBackupChunk(chunk: Blob): Promise<string> {
  const bytes = new Uint8Array(await chunk.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export async function saveBackupFile(blob: Blob, filename: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    try {
      anchor.click();
      return true;
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  if (!Capacitor.isPluginAvailable(PLUGIN_NAME)) throw new Error('请使用「扫码保存到电脑」导出备份');
  const { id } = await nativeSave.chooseFile({ filename, mimeType: blob.type || 'application/octet-stream', size: blob.size });
  if (!id) return false;

  try {
    for (let offset = 0; offset < blob.size; offset += BACKUP_CHUNK_SIZE) {
      const base64 = await encodeBackupChunk(blob.slice(offset, offset + BACKUP_CHUNK_SIZE));
      await nativeSave.writeChunk({ id, base64 });
    }
    await nativeSave.finish({ id });
    return true;
  } catch (error) {
    await nativeSave.abort({ id }).catch(() => {});
    throw error;
  }
}
