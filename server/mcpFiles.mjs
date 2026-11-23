import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, posix, resolve, sep, win32 } from 'node:path';

const MAX_FILES = 30;
const FILE_SIZE_LIMIT = 30 * 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const FILE_TYPES = new Map([
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
]);

async function selectFile(root, rootPrefix, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\0') ||
      posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath) ||
      (process.platform === 'win32' && relativePath.includes(':'))) {
    throw new Error('请提供 ZHIWU_IMPORT_DIR 内的相对路径');
  }

  const candidate = resolve(root, relativePath.replaceAll('\\', '/'));
  if (candidate === root) throw new Error(`请选择普通文件「${relativePath}」`);
  if (!candidate.startsWith(rootPrefix)) throw new Error(`文件「${relativePath}」超出 ZHIWU_IMPORT_DIR`);
  const filePath = await realpath(candidate).catch(() => {
    throw new Error(`找不到文件或无法访问「${relativePath}」`);
  });
  if (!filePath.startsWith(rootPrefix)) throw new Error(`文件「${relativePath}」超出 ZHIWU_IMPORT_DIR`);

  const info = await stat(filePath, { bigint: true }).catch(() => null);
  if (!info?.isFile()) throw new Error(`请选择可读取的普通文件「${relativePath}」`);
  // Busboy rejects a file as soon as its byte count reaches the configured limit.
  if (info.size >= FILE_SIZE_LIMIT) throw new Error(`文件「${relativePath}」必须小于 30 MiB`);
  return { filePath, name: basename(candidate), relativePath, info };
}

async function readSelectedFile({ filePath, relativePath, info }) {
  const changed = `文件「${relativePath}」在读取前后发生了变化`;
  let handle;
  try {
    handle = await open(filePath, READ_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino ||
        opened.size !== info.size || opened.mtimeNs !== info.mtimeNs || await realpath(filePath) !== filePath) {
      throw new Error(changed);
    }

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(changed);
      offset += bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    if (final.size !== opened.size || final.mtimeNs !== opened.mtimeNs) throw new Error(changed);
    return bytes;
  } catch (error) {
    if (error.code) throw new Error(`无法读取文件「${relativePath}」`, { cause: error });
    throw error;
  } finally {
    await handle?.close();
  }
}

// Returns one multipart `files` entry per selected path, with the original basename and bytes.
export async function createImportForm(paths, importRoot) {
  if (typeof importRoot !== 'string' || !importRoot.trim()) {
    throw new Error('请在 MCP 配置中填写 ZHIWU_IMPORT_DIR 以启用原文件导入');
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) {
    throw new Error('请选择 1 至 30 个原文件');
  }
  const root = await realpath(importRoot).catch(() => null);
  if (!root || !(await stat(root).catch(() => null))?.isDirectory()) {
    throw new Error('ZHIWU_IMPORT_DIR 必须是可访问的现有目录');
  }

  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const selectedFiles = [];
  for (const relativePath of paths) {
    selectedFiles.push(await selectFile(root, rootPrefix, relativePath));
  }

  const form = new FormData();
  for (const file of selectedFiles) {
    const bytes = await readSelectedFile(file);
    const type = FILE_TYPES.get(extname(file.name).toLowerCase()) ?? 'application/octet-stream';
    form.append('files', new File([bytes], file.name, { type }));
  }
  return form;
}
