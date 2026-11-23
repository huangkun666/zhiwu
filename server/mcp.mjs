import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createImportForm } from './mcpFiles.mjs';

function configuredAddress() {
  const address = process.env.ZHIWU_URL?.trim();
  if (!address) throw new Error('请在 MCP 配置中填写 ZHIWU_URL，使用你实际访问的知悟地址');

  const url = URL.parse(address);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('ZHIWU_URL 必须是有效的 HTTP 或 HTTPS 服务地址');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  url.search = '';
  url.hash = '';
  return url;
}

try {
  const base = configuredAddress();
  const token = process.env.ZHIWU_TOKEN?.trim();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function request(path, options) {
    const response = await fetch(new URL(path, base), {
      ...options,
      headers: { ...headers, ...options?.headers },
      redirect: 'error',
      signal: options?.signal ?? AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `知悟请求失败（HTTP ${response.status}）`);
    if (data === null) throw new Error('知悟服务未返回可读取的数据');
    return data;
  }

  async function verifyLibrary() {
    const health = await request('api/health');
    if (health?.status !== 'ok' || health.app !== '知悟 (Zhiwu)') {
      throw new Error('该地址未返回知悟服务的状态，请检查 ZHIWU_URL');
    }
  }

  function sendJson(path, body, method = 'POST') {
    return request(path, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  async function ensureCategory(path, parentId) {
    const category = await sendJson('api/categories', { path, parentId });
    if (typeof category.id !== 'string' || !category.id) throw new Error('知悟未返回分类编号');
    return { categoryId: category.id, categoryPath: category.path ?? path };
  }

  async function resolveDestination(categoryId, categoryPath) {
    if (categoryId && categoryPath) throw new Error('请填写分类编号或分类路径中的一项');
    if (categoryPath) return ensureCategory(categoryPath);
    if (!categoryId) return {};

    const categories = await request('api/categories');
    const category = categories.find(({ id }) => id === categoryId);
    if (!category) throw new Error('分类已不存在，请重新选择');
    return { categoryId, categoryPath: category.path ?? [category.name] };
  }

  function noteReceipt(note) {
    if (typeof note?.id !== 'string' || !note.id) {
      throw new Error('知悟未返回笔记编号，请打开知悟核对收录结果');
    }
    const link = new URL(base);
    link.searchParams.set('note', note.id);
    return { id: note.id, title: note.title, url: link.href, categoryId: note.category_id ?? null };
  }

  function result(data, text = JSON.stringify(data)) {
    return {
      structuredContent: data,
      content: [{ type: 'text', text }],
    };
  }

  const label = z.string().trim().min(1);
  const recordId = label.refine((value) => value !== '.' && value !== '..', '记录编号无效');
  const categoryPathSchema = z.array(label).min(1).describe('按顺序填写各级分类，例如 ["项目", "记账小程序", "设计"]');
  const destination = {
    categoryPath: categoryPathSchema.optional(),
    categoryId: recordId.optional().describe('已有分类的编号，和分类路径二选一'),
    tags: z.array(label).optional(),
  };
  const contentSchema = z.string().refine((value) => Boolean(value.trim()), '笔记正文不能为空')
    .describe('Markdown 正文，保留问答、代码块与已有来源链接');
  const noteIdSchema = recordId.describe('笔记编号，可从知悟笔记链接的 note 参数中取出');

  const server = new McpServer({ name: 'zhiwu', version: '1.0.0' });
  server.registerTool('list_zhiwu_categories', {
    title: '查看知悟分类',
    description: '列出当前知悟库的分类、上级分类和完整路径，便于选择收录位置。',
    inputSchema: z.object({}),
  }, async () => {
    await verifyLibrary();
    const categories = await request('api/categories');
    return result({ categories: categories.map((category) => ({
      id: category.id, name: category.name, parentId: category.parent_id ?? null,
      categoryPath: category.path ?? [category.name], noteCount: category.note_count,
    })) });
  });

  server.registerTool('ensure_zhiwu_category', {
    title: '建立知悟分类',
    description: '建立指定的多级分类路径。已经存在的同级同名分类会复用。',
    inputSchema: z.object({
      categoryPath: categoryPathSchema,
      parentId: recordId.optional().describe('指定已有的上级分类。从该分类向下填写路径'),
    }),
  }, async ({ categoryPath, parentId }) => {
    await verifyLibrary();
    const category = await ensureCategory(categoryPath, parentId);
    return result(category, `分类已就绪 ${category.categoryPath.join(' / ')}`);
  });

  server.registerTool('save_to_zhiwu', {
    title: '保存到知悟',
    description: '把用户指定的对话或项目片段原样存为 Markdown 笔记。填写分类路径时，复用或补齐对应分类。',
    inputSchema: z.object({ title: label.describe('笔记标题'), content: contentSchema, ...destination }),
  }, async ({ title, content, categoryPath, categoryId, tags }) => {
    await verifyLibrary();
    const selected = await resolveDestination(categoryId, categoryPath);
    const note = await sendJson('api/notes', { title, content, categoryId: selected.categoryId, tags, sourceType: 'markdown' });
    const receipt = { ...noteReceipt(note), categoryPath: selected.categoryPath };
    const location = selected.categoryPath ? `\n分类 ${selected.categoryPath.join(' / ')}` : '';
    return result(receipt, `已保存《${receipt.title}》${location}\n${receipt.url}`);
  });

  server.registerTool('append_to_zhiwu_note', {
    title: '追加到知悟笔记',
    description: '把指定内容添加到已有笔记的聊天摘录，可在知悟中撤销。重试时可沿用相同摘录编号。',
    inputSchema: z.object({ noteId: noteIdSchema, content: contentSchema, excerptId: recordId.optional() }),
  }, async ({ noteId, content, excerptId = randomUUID() }) => {
    await verifyLibrary();
    const note = await sendJson(`api/notes/${encodeURIComponent(noteId)}/chat-excerpts/${encodeURIComponent(excerptId)}`, { content }, 'PUT');
    const receipt = { ...noteReceipt(note), excerptId };
    return result(receipt, `已追加到《${receipt.title}》\n${receipt.url}`);
  });

  server.registerTool('import_zhiwu_files', {
    title: '导入原文件到知悟',
    description: '批量保存用户选定的原文件。路径相对配置的 ZHIWU_IMPORT_DIR，可同时填写分类和标签。',
    inputSchema: z.object({ paths: z.array(z.string().min(1)).min(1).max(30), ...destination }),
  }, async ({ paths, categoryPath, categoryId, tags }, ctx) => {
    await verifyLibrary();
    const form = await createImportForm(paths, process.env.ZHIWU_IMPORT_DIR);
    const selected = await resolveDestination(categoryId, categoryPath);
    if (selected.categoryId) form.append('categoryId', selected.categoryId);
    if (tags?.length) form.append('tags', JSON.stringify(tags));
    form.append('view', 'compact');
    form.append('ocrImages', 'false');
    const imported = await request('api/notes/import', { method: 'POST', body: form, signal: ctx.mcpReq.signal });
    const notes = imported.imported.map((note) => ({ ...noteReceipt(note), sourceFilename: note.source_filename }));
    const warnings = imported.warnings ?? [];
    return result({ notes, warnings, categoryPath: selected.categoryPath }, [
      `已导入 ${notes.length} 份文件`, ...notes.map(({ title, url }) => `${title} ${url}`), ...warnings,
    ].join('\n'));
  });

  if (process.env.ZHIWU_ALLOW_READ === '1') {
    server.registerTool('search_zhiwu_notes', {
      title: '搜索知悟笔记',
      description: '按关键词、分类编号或标签查找笔记，返回标题、片段和链接。',
      inputSchema: z.object({
        query: label.optional(), categoryId: recordId.optional(), tag: label.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    }, async ({ query, categoryId, tag, limit }) => {
      await verifyLibrary();
      const params = new URLSearchParams({ limit: String(limit), view: 'compact' });
      if (query) params.set('q', query);
      if (categoryId) params.set('categoryId', categoryId);
      if (tag) params.set('tag', tag);
      const notes = await request(`api/notes?${params}`);
      return result({ notes: notes.map((note) => ({
        ...noteReceipt(note), tags: note.tags,
        excerpt: note.excerpt ?? (note.summary?.abstract || note.content || note.source_content || '').slice(0, 240),
      })) });
    });

    server.registerTool('read_zhiwu_note', {
      title: '读取知悟笔记',
      description: '按笔记编号读取正文、文档文字、聊天摘录和原文件地址。',
      inputSchema: z.object({ noteId: noteIdSchema }),
    }, async ({ noteId }) => {
      await verifyLibrary();
      const note = await request(`api/notes/${encodeURIComponent(noteId)}`);
      const attachmentUrl = /^\/uploads\/[a-z0-9][\w.-]*$/i.test(note.attachment_path)
        ? new URL(note.attachment_path.slice(1), base).href : null;
      return result({
        ...noteReceipt(note), tags: note.tags, content: note.content, sourceContent: note.source_content,
        chatExcerpts: note.chat_excerpts, sourceFilename: note.source_filename, attachmentUrl,
      });
    });
  }

  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.message : '知悟 MCP 适配器启动失败');
  process.exitCode = 1;
}
