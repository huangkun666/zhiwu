import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createImportForm } from '../mcpFiles.mjs';

async function createFixture(t) {
  const tempRoot = await realpath(tmpdir());
  const fixture = await mkdtemp(join(tempRoot, 'zhiwu-mcp-files-'));
  const importRoot = join(fixture, 'imports');
  t.after(async () => {
    assert.equal(dirname(fixture), tempRoot);
    await rm(fixture, { recursive: true, force: true });
  });
  await mkdir(importRoot);
  return { fixture, importRoot };
}

async function linkDirectory(t, target, link) {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('This Windows session does not allow creating a directory junction');
    return false;
  }
}

test('preserves the basename and original bytes of selected files', async (t) => {
  const { importRoot } = await createFixture(t);
  const notes = join(importRoot, 'notes');
  await mkdir(notes);
  const markdown = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 资料\r\n\r\n原件\r\n')]);
  const code = Buffer.from('export const answer = 42;\r\n');
  await writeFile(join(notes, '资料.MD'), markdown);
  await writeFile(join(importRoot, 'answer.mjs'), code);

  const form = await createImportForm(['notes\\资料.MD', 'answer.mjs'], importRoot);
  assert.ok(form instanceof FormData);
  assert.deepEqual([...form.keys()], ['files', 'files']);
  const files = form.getAll('files');
  assert.deepEqual(files.map((file) => file.name), ['资料.MD', 'answer.mjs']);
  assert.deepEqual(files.map((file) => file.type), ['text/markdown', 'application/octet-stream']);
  const uploaded = await Promise.all(files.map(async (file) => Buffer.from(await file.arrayBuffer())));
  assert.deepEqual(uploaded, [markdown, code]);
});

test('uses the import endpoint MIME types for original documents and images', async (t) => {
  const { importRoot } = await createFixture(t);
  const formats = [
    ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['document.pdf', 'application/pdf'],
    ['text.txt', 'text/plain'],
    ['picture.JPG', 'image/jpeg'],
    ['picture.png', 'image/png'],
    ['picture.webp', 'image/webp'],
    ['picture.gif', 'image/gif'],
    ['picture.bmp', 'image/bmp'],
    ['picture.avif', 'image/avif'],
    ['picture.tif', 'image/tiff'],
    ['picture.heic', 'image/heic'],
    ['picture.heif', 'image/heif'],
  ];
  const bytes = Buffer.from([0, 255, 4, 13, 10]);
  await Promise.all(formats.map(([name]) => writeFile(join(importRoot, name), bytes)));
  const form = await createImportForm(formats.map(([name]) => name), importRoot);
  assert.deepEqual(form.getAll('files').map((file) => [file.name, file.type]), formats);
  assert.deepEqual(Buffer.from(await form.getAll('files')[0].arrayBuffer()), bytes);
});

test('requires a configured existing ZHIWU_IMPORT_DIR directory', async (t) => {
  const { fixture } = await createFixture(t);
  const file = join(fixture, 'root.md');
  await writeFile(file, 'not a directory');
  for (const root of [undefined, '   ', join(fixture, 'missing'), file]) {
    await assert.rejects(createImportForm(['sample.md'], root), /ZHIWU_IMPORT_DIR/);
  }
});

test('rejects absolute paths, drive-relative paths, and paths outside the configured directory', async (t) => {
  const { fixture, importRoot } = await createFixture(t);
  const outside = join(fixture, 'imports-sibling.md');
  await writeFile(outside, 'private');
  const absolute = join(importRoot, 'sample.md');
  await writeFile(absolute, 'authorized relative to the root');
  const paths = [absolute, '/sample.md', '\\sample.md', 'C:sample.md', 'C:\\sample.md', '../imports-sibling.md', '..\\imports-sibling.md'];
  if (process.platform === 'win32') paths.push('sample.md:alternate-stream');
  for (const path of paths) {
    await assert.rejects(createImportForm([path], importRoot), /相对路径|超出/);
  }
});

test('rejects files reached through a symlink or junction outside the configured directory', async (t) => {
  const { fixture, importRoot } = await createFixture(t);
  const outside = join(fixture, 'imports-sibling');
  await mkdir(outside);
  await writeFile(join(outside, 'private.md'), 'private');
  if (!await linkDirectory(t, outside, join(importRoot, 'linked'))) return;

  await assert.rejects(createImportForm(['linked/private.md'], importRoot), /超出/);
});

test('allows a directory symlink or junction whose resolved files stay inside the configured directory', async (t) => {
  const { importRoot } = await createFixture(t);
  const nested = join(importRoot, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, 'inside.md'), 'inside');
  if (!await linkDirectory(t, nested, join(importRoot, 'linked'))) return;

  const form = await createImportForm(['linked/inside.md'], importRoot);
  assert.equal(await form.get('files').text(), 'inside');
});

test('rejects a whole selection when a file is missing or is a directory', async (t) => {
  const { importRoot } = await createFixture(t);
  await writeFile(join(importRoot, 'valid.md'), 'content');
  await mkdir(join(importRoot, 'folder.md'));

  await assert.rejects(createImportForm(['valid.md', 'missing.md'], importRoot), /missing\.md/);
  await assert.rejects(createImportForm(['valid.md', 'folder.md'], importRoot), /普通文件/);
});

test('rejects blank paths, empty selections, and selections exceeding the endpoint file count', async (t) => {
  const { importRoot } = await createFixture(t);

  await assert.rejects(createImportForm(['   '], importRoot), /相对路径/);
  await assert.rejects(createImportForm([null], importRoot), /相对路径/);
  await assert.rejects(createImportForm([], importRoot), /1.+30/);
  await assert.rejects(createImportForm(Array(31).fill('sample.md'), importRoot), /1.+30/);
});

test('rejects a file at the endpoint byte limit', async (t) => {
  const { importRoot } = await createFixture(t);
  const path = join(importRoot, 'too-big.txt');
  await writeFile(path, '');
  await truncate(path, 30 * 1024 * 1024);

  await assert.rejects(createImportForm(['too-big.txt'], importRoot), /30 MiB/);
});
