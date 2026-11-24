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
const ZIP_TYPE = 'application/zip';

type BackupDestination = 'native' | 'download' | 'share' | FileSystemFileHandle;
type SaveFilePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function cancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function chooseBackupDestination(filename: string): Promise<BackupDestination | null> {
  if (!Capacitor.isNativePlatform()) return 'download';
  if (Capacitor.isPluginAvailable(PLUGIN_NAME)) return 'native';

  // An older APK may still have a system WebView that can save files.
  const browser = globalThis as typeof globalThis & { showSaveFilePicker?: SaveFilePicker };
  if (browser.showSaveFilePicker) {
    try {
      return await browser.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'ZIP 备份', accept: { [ZIP_TYPE]: ['.zip'] } }],
      });
    } catch (error) {
      if (cancelled(error)) return null;
      if (!(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
    }
  }
  if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [new File([], filename, { type: ZIP_TYPE })] })) {
    return 'share';
  }
  throw new Error('这个安装包和系统暂不支持在手机上保存 ZIP。请用「局域网快传」扫描电脑的「接收备份」码，先把现有资料保存到电脑。');
}

export async function encodeBackupChunk(chunk: Blob): Promise<string> {
  const bytes = new Uint8Array(await chunk.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export async function saveBackupFile(blob: Blob, filename: string, destination: BackupDestination): Promise<boolean> {
  if (typeof destination !== 'string') {
    const writer = await destination.createWritable();
    try {
      await writer.write(blob);
      await writer.close();
      return true;
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  }
  if (destination === 'share') {
    const files = [new File([blob], filename, { type: ZIP_TYPE })];
    if (!navigator.canShare?.({ files })) throw new Error('系统无法分享这份 ZIP。请用「局域网快传」发送到电脑。');
    try {
      await navigator.share({ files });
      return true;
    } catch (error) {
      if (cancelled(error)) return false;
      throw error;
    }
  }
  if (destination === 'download') {
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
