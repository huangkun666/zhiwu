import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { categoryPaths } from '../../../server/src/shared/categoryPaths';
import { editableNoteBody, noteSearchExcerpt, readChatExcerpts } from '../../../server/src/shared/noteContent';
import type { Note } from '../types';
import { localApi } from './localEngine';

export interface PhoneMcpRequest {
  body: string;
  headers: Record<string, string>;
  access: 'read' | 'edit';
}

const label = z.string().trim().min(1);
const recordId = label.refine(value => value !== '.' && value !== '..', '记录编号无效');
const noteId = recordId.describe('笔记编号，可从搜索或保存回执取得');
const categoryPath = z.array(label).min(1).max(32).describe('从上到下填写各级分类名称');
const markdown = z.string().refine(value => Boolean(value.trim()), '内容不能为空');
const version = z.string().trim().min(1).describe('读取笔记时取得的 updatedAt');

function result(data: Record<string, unknown>) {
  return { structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function receipt(note: Note) {
  return { id: note.id, title: note.title, categoryId: note.category_id ?? null };
}

function createNoteServer(access: PhoneMcpRequest['access'], onChanged?: () => void) {
  const server = new McpServer({ name: 'zhiwu-phone', version: '1.0.0', title: '知悟手机笔记库' },
    { capabilities: { tools: { listChanged: false } } });
  server.registerTool('list_zhiwu_categories', {
    title: '查看知悟分类', description: '列出手机知识库的分类路径和可用笔记数量。',
    inputSchema: z.object({}), annotations: { readOnlyHint: true },
  }, async () => {
    const categories = await localApi.getCategories();
    const paths = categoryPaths(categories);
    return result({ categories: categories.map(c => ({
      id: c.id, name: c.name, parentId: c.parent_id ?? null, categoryPath: paths.get(c.id), noteCount: c.note_count,
    })) });
  });
  server.registerTool('search_zhiwu_notes', {
    title: '搜索知悟笔记', description: '按关键词、分类编号或标签搜索手机笔记，返回标题和匹配片段。',
    inputSchema: z.object({ query: label.optional(), categoryId: recordId.optional(), tag: label.optional(),
      limit: z.number().int().min(1).max(100).default(20) }), annotations: { readOnlyHint: true },
  }, async ({ query, categoryId, tag, limit }) => {
    const notes = await localApi.getNotes({ q: query, categoryId, tag });
    return result({ notes: notes.slice(0, limit).map(note => ({
      ...receipt(note), tags: note.tags, excerpt: noteSearchExcerpt(note, query),
    })) });
  });
  server.registerTool('read_zhiwu_note', {
    title: '读取知悟笔记', description: '读取手机笔记的正文、原件提取文字及聊天摘录。编辑前核对 editableContent 和 updatedAt。',
    inputSchema: z.object({ noteId }), annotations: { readOnlyHint: true },
  }, async ({ noteId }) => {
    const note = await localApi.getStoredNote(noteId);
    return result({ ...receipt(note), updatedAt: note.updated_at, tags: note.tags, content: note.content,
      editableContent: editableNoteBody(note), sourceContent: note.source_content ?? null,
      chatExcerpts: readChatExcerpts(note.chat_excerpts).map(({ id, content, created_at }) => ({ id, content, created_at })),
      sourceFilename: note.source_filename?.split(/[\\/]/).pop() || null, attachmentUrl: null,
    });
  });
  if (access !== 'edit') return server;

  server.registerTool('ensure_zhiwu_category', {
    title: '建立知悟分类', description: '在手机知识库复用或补齐指定分类路径。',
    inputSchema: z.object({ categoryPath, parentId: recordId.optional() }),
  }, async ({ categoryPath, parentId }) => {
    const category = await localApi.ensureCategoryPath(categoryPath, parentId);
    onChanged?.();
    return result(category);
  });
  server.registerTool('save_to_zhiwu', {
    title: '保存到知悟', description: '将用户指定的内容保存为手机上的 Markdown 笔记。重试时沿用相同 requestId 和参数。',
    inputSchema: z.object({ title: label, content: markdown, categoryPath: categoryPath.optional(),
      categoryId: recordId.optional(), tags: z.array(label).optional(),
      requestId: z.uuid().optional().describe('可选的收录请求 UUID，可在断线后重试同一笔记') }),
  }, async args => {
    const note = await localApi.createNote(args);
    onChanged?.();
    const path = args.categoryPath ?? (note.category_id
      ? categoryPaths(await localApi.getCategories()).get(note.category_id) : undefined);
    return result({ ...receipt(note), categoryPath: path, updatedAt: note.updated_at });
  });
  server.registerTool('append_to_zhiwu_note', {
    title: '追加到知悟笔记', description: '向已有笔记追加可单独撤销的聊天摘录。重试时沿用相同 excerptId 和内容。',
    inputSchema: z.object({ noteId, content: markdown, excerptId: recordId.optional() }),
  }, async ({ noteId, content, excerptId = crypto.randomUUID() }) => {
    const note = await localApi.appendNoteChat(noteId, excerptId, content);
    onChanged?.();
    return result({ ...receipt(note), excerptId, updatedAt: note.updated_at });
  });
  server.registerTool('update_zhiwu_note', {
    title: '修改知悟笔记', description: '修改笔记标题或可编辑正文。先读取 updatedAt 和 editableContent，改正文时保留原文件及摘录。',
    inputSchema: z.object({ noteId, expectedUpdatedAt: version, title: label.optional(),
      content: z.string().optional().describe('完整替换 editableContent，如仅改名请省略') }),
  }, async ({ noteId, expectedUpdatedAt, title, content }) => {
    if (title === undefined && content === undefined) throw new Error('请填写要修改的标题或正文');
    let note = await localApi.getStoredNote(noteId);
    if (content !== undefined && editableNoteBody(note) === null) throw new Error('这份旧笔记的正文存放导入原文，可改名或追加聊天摘录');
    const matches = (current: Note) => (title === undefined || current.title === title)
      && (content === undefined || editableNoteBody(current) === content || current.content === content);
    if (!matches(note)) {
      try {
        note = await localApi.updateNote(noteId, { expectedUpdatedAt, title, content });
        onChanged?.();
      } catch (error) {
        note = await localApi.getStoredNote(noteId);
        if (!matches(note)) throw error;
      }
    }
    return result({ ...receipt(note), updatedAt: note.updated_at });
  });
  return server;
}

// Authentication and the real socket belong to Android. This Request is only an in-memory SDK envelope.
export async function handlePhoneMcpRequest(request: PhoneMcpRequest, onChanged?: () => void) {
  const http = new Request('http://localhost/mcp', { method: 'POST', headers: request.headers, body: request.body });
  const factory = () => createNoteServer(request.access, onChanged);
  let response: Response;
  if (await isLegacyRequest(http)) {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      response = await transport.handleRequest(http);
    } finally {
      await server.close();
    }
  } else {
    // This bridge completes one JSON response per request and advertises a fixed tool list.
    const handler = createMcpHandler(factory, { legacy: 'reject', maxSubscriptions: 0 });
    try {
      response = await handler.fetch(http);
    } finally {
      await handler.close();
    }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}
