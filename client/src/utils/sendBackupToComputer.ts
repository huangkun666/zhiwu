import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BACKUP_CHUNK_SIZE, parseBackupReceiveUrl } from '../../../server/src/shared/backupReceive';
import { encodeBackupChunk } from './saveBackupFile';

interface ReceiverResponse {
  kind?: string;
  error?: string;
  receivedBytes?: number;
  ready?: boolean;
}

async function requestReceiver(url: URL, headers: Record<string, string> = {}, chunk?: Blob): Promise<ReceiverResponse> {
  const destination = parseBackupReceiveUrl(url.href);
  if (!destination) throw new Error('请使用电脑生成的局域网备份接收码');
  const method = chunk ? 'PUT' : 'GET';
  let status: number;
  let data: ReceiverResponse | null;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: destination.href,
      method,
      disableRedirects: true,
      responseType: 'json',
      connectTimeout: 10_000,
      readTimeout: 20_000,
      ...(chunk ? {
        headers: { ...headers, 'Content-Type': 'multipart/form-data' },
        dataType: 'formData',
        data: [{
          key: 'chunk',
          value: await encodeBackupChunk(chunk),
          type: 'base64File',
          fileName: 'chunk',
          contentType: 'application/octet-stream',
        }],
      } : {}),
    });
    status = response.status;
    data = response.data;
  } else {
    const body = chunk ? new FormData() : undefined;
    if (chunk) body?.append('chunk', chunk, 'chunk');
    const response = await fetch(destination, { method, headers, body, redirect: 'error', credentials: 'omit' });
    status = response.status;
    data = await response.json().catch(() => null);
  }
  if (status < 200 || status >= 300 || !data || typeof data !== 'object') {
    const error = typeof data?.error === 'string' ? data.error : `无法连接备份接收端（HTTP ${status}）`;
    throw new Error(error);
  }
  return data;
}

export async function verifyBackupReceiver(url: URL): Promise<void> {
  const data = await requestReceiver(url);
  if (data.kind !== 'backup-receive') throw new Error('请扫描电脑的备份接收二维码');
}

export async function sendBackupToComputer(url: URL, blob: Blob, onProgress: (receivedBytes: number) => void): Promise<void> {
  if (!blob.size) throw new Error('备份文件为空，请重新导出');
  const uploadId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  for (let offset = 0; offset < blob.size; offset += BACKUP_CHUNK_SIZE) {
    const chunk = blob.slice(offset, offset + BACKUP_CHUNK_SIZE);
    const result = await requestReceiver(url, {
      'X-Zhiwu-Backup-Upload': uploadId,
      'X-Zhiwu-Backup-Size': String(blob.size),
      'X-Zhiwu-Backup-Offset': String(offset),
    }, chunk);
    const expected = offset + chunk.size;
    if (result.receivedBytes !== expected || result.ready !== (expected === blob.size)) {
      throw new Error('电脑返回的接收进度有误，请重新扫码发送');
    }
    onProgress(expected);
  }
}
