import { readChatExcerpts, splitLegacyChatExcerpts, stripInlineImages } from './noteContent.js';
import { readPdfPages } from './pdfPages.js';

export interface TutorSource {
  id: string;
  title: string;
  content: string;
  source_content?: string | null;
  source_type?: string;
  source_filename?: string | null;
  source_pages?: unknown;
  chat_excerpts?: unknown;
  knowledge_index?: unknown;
  updated_at?: string;
  tags?: unknown;
}

export interface SourceBlock {
  field: 'body' | 'source' | 'excerpt';
  index: number;
  start: number;
  end: number;
  text: string;
  sig: string;
  page?: number;
  excerptId?: string;
  tableHeader?: string;
}

// Content fingerprints detect stale links. They are not access credentials.
export function sourceFingerprint(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export function sourceFields(note: Omit<TutorSource, 'id' | 'title'>) {
  const legacy = splitLegacyChatExcerpts(note.content || '');
  const legacyFile = note.source_filename && note.source_type !== 'image' && note.source_content == null;
  const fields: { field: SourceBlock['field']; text: string; excerptId?: string }[] = [
    { field: 'body', text: legacyFile ? '' : stripInlineImages(legacy.body) },
    { field: 'source', text: note.source_content ?? (legacyFile ? legacy.body : '') },
  ];
  for (const excerpt of legacy.excerpts) fields.push({ field: 'excerpt', text: excerpt.content, excerptId: `legacy-${excerpt.offset}` });
  for (const excerpt of readChatExcerpts(note.chat_excerpts)) fields.push({ field: 'excerpt', text: excerpt.content, excerptId: excerpt.id });
  return fields;
}

export function sourceBlocks(note: Omit<TutorSource, 'id' | 'title'>): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const counts = { body: 0, source: 0, excerpt: 0 };
  function append(field: SourceBlock['field'], text: string, offset = 0, page?: number, excerptId?: string) {
    function addParagraph(from: number, until: number) {
      const newline = text.indexOf('\n', from);
      const firstLine = newline > from && newline < until ? text.slice(from, Math.min(newline, from + 400)).trim() : '';
      const tableHeader = /[|\t]/.test(firstLine) ? firstLine : undefined;
      while (from < until) {
        let end = Math.min(from + 1400, until);
        if (end < until) {
          const tail = text.slice(from + 700, end);
          const newline = tail.lastIndexOf('\n');
          if (newline >= 0) end = from + 700 + newline + 1;
          else {
            const boundary = tail.match(/[。！？.!?；;\s](?=[^。！？.!?；;\s]*$)/u);
            if (boundary) end = from + 700 + boundary.index! + 1;
          }
        }
        const raw = text.slice(from, end);
        const value = raw.trim();
        if (value) {
          const start = offset + from + raw.indexOf(value);
          blocks.push({ field, index: ++counts[field], start, end: start + value.length, text: value,
            page, excerptId, tableHeader,
            sig: sourceFingerprint(`${field}|${page ?? ''}|${excerptId ?? ''}|${tableHeader ? tableHeader + '|' : ''}${value}`) });
        }
        from = end;
      }
    }
    // Keep single newlines (lists, table rows and PDF line wraps) together.
    let from = 0;
    for (const cut of text.matchAll(/(?:\r?\n[\t ]*){2,}|!\[[^\]\n]*\]\((?:data:image\/|\/uploads\/)[^)]*\)/gi)) {
      addParagraph(from, cut.index);
      from = cut.index + cut[0].length;
    }
    addParagraph(from, text.length);
  }
  for (const { field, text, excerptId } of sourceFields(note)) {
    const pages = field === 'source' && note.source_type === 'pdf' ? readPdfPages(note.source_pages, text) : null;
    if (pages) {
      pages.forEach(({ start, end, status }, i) => {
        if (status === 'text') append('source', text.slice(start, end), start, i + 1);
      });
    } else {
      append(field, text, 0, undefined, excerptId);
    }
  }
  return blocks;
}

export function blockLabel(block: SourceBlock) {
  if (block.page) return `PDF 第 ${block.page} 页`;
  const label = { body: '正文', source: '原文', excerpt: '聊天摘录' }[block.field];
  return `${label}第 ${block.index} 段`;
}

// Vision transcriptions are per-turn. This target opens the physical original without persisting OCR as authored text.
export function unreadPdfPage(note: TutorSource, page: number): SourceBlock | undefined {
  if (note.source_type !== 'pdf' || !Number.isSafeInteger(page) || page < 1) return;
  const pages = readPdfPages(note.source_pages, note.source_content || '');
  const target = pages?.[page - 1];
  if (!pages || !target || target.status === 'text') return;
  return { field: 'source', index: page, start: target.start, end: target.end, text: '', page,
    sig: sourceFingerprint(JSON.stringify(['pdf-image', note.id, note.updated_at, note.source_filename, pages.length, page, target])) };
}

export function citationParams(noteId: string, block: SourceBlock) {
  const params = new URLSearchParams({ note: noteId, part: block.field, at: String(block.index), sig: block.sig });
  if (block.page) params.set('page', String(block.page));
  return params;
}

export function citationLink(note: TutorSource, block: SourceBlock) {
  const params = citationParams(note.id, block);
  const title = note.title.replace(/[\[\]\\<>\r\n]/g, ' ').slice(0, 120);
  return `[${title} · ${blockLabel(block)}](?${params.toString().replace(/\)/g, '%29')})`;
}
