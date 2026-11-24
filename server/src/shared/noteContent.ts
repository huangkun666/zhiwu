export interface ChatExcerpt {
  id: string;
  content: string;
  created_at: string;
}

export function readChatExcerpts(value: unknown): ChatExcerpt[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ChatExcerpt => (
    typeof item?.id === 'string' && typeof item.content === 'string' && typeof item.created_at === 'string'
  ));
}

export function noteStudyText(note: { content: string; source_content?: string | null; chat_excerpts?: unknown }) {
  return [note.content, note.source_content, ...readChatExcerpts(note.chat_excerpts).map((excerpt) => excerpt.content)]
    .filter(Boolean)
    .join('\n\n');
}

export function noteSearchExcerpt(note: {
  content?: string | null; source_content?: string | null; chat_excerpts?: unknown; summary?: { abstract?: string } | null;
}, query = ''): string {
  const texts = [note.content, note.source_content, ...readChatExcerpts(note.chat_excerpts).map(excerpt => excerpt.content)]
    .filter((text): text is string => typeof text === 'string' && Boolean(text.trim()));
  if (query) {
    const needle = query.toLowerCase();
    for (const text of texts) {
      const match = text.toLowerCase().indexOf(needle);
      if (match < 0) continue;
      const offset = Math.max(0, match - 48);
      return (offset ? '…' : '') + text.slice(offset, offset + 240) + (text.length > offset + 240 ? '…' : '');
    }
  }
  const abstract = typeof note.summary?.abstract === 'string' ? note.summary.abstract : '';
  return (abstract || texts[0] || '').slice(0, 240);
}

export function nextNoteUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

export function splitLegacyChatExcerpts(content: string) {
  const headings = [...content.matchAll(/\n\n---\n\n### 费曼助教延伸笔记（([^）\r\n]+)）\n\n/g)];
  return {
    body: content.slice(0, headings[0]?.index ?? content.length),
    excerpts: headings.map((heading, index) => {
      const offset = heading.index;
      const end = headings[index + 1]?.index ?? content.length;
      return {
        offset,
        date: heading[1],
        block: content.slice(offset, end),
        content: content.slice(offset + heading[0].length, end),
      };
    }),
  };
}

type StoredNoteText = { content: string; source_filename?: string | null; source_type?: string; source_content?: string | null };

export function editableNoteBody(note: StoredNoteText): string | null {
  if (note.source_filename && note.source_type !== 'image' && note.source_content == null) return null;
  return splitLegacyChatExcerpts(note.content).body;
}

export function reviewedNoteContent(
  note: StoredNoteText & { updated_at: string }, requested: string | undefined, expectedUpdatedAt?: unknown,
): { content: string } | { error: string } {
  if (expectedUpdatedAt === undefined) return { content: requested ?? note.content };
  if (expectedUpdatedAt !== note.updated_at) return { error: '笔记已更新，请重新读取后再确认修改' };
  if (requested === undefined || requested === note.content) return { content: note.content };
  const currentBody = editableNoteBody(note);
  if (currentBody === null) return { error: '这份旧笔记的正文存放导入原文，可将新内容追加为聊天摘录' };
  const suffix = note.content.slice(currentBody.length);
  const replacement = splitLegacyChatExcerpts(requested);
  if (replacement.excerpts.length && requested.slice(replacement.body.length) !== suffix) {
    return { error: '旧版聊天摘录已单独保留，请只修改笔记正文' };
  }
  return { content: replacement.body + suffix };
}

export function removeLegacyChatExcerpt(
  content: string,
  offset: number,
  block: string,
  findReplies: (prefix: string) => Iterable<string>
): { content: string } | { error: string } {
  const excerpt = splitLegacyChatExcerpts(content).excerpts.find((item) => item.offset === offset);
  if (!excerpt || excerpt.block !== block) {
    return { error: '这段旧版追加内容已变更，请重新打开笔记后再试' };
  }

  // Old appends have no message ID or end marker. Match a saved reply before removing any text.
  const matches = new Set<string>();
  for (const reply of findReplies(excerpt.content)) {
    if (reply && (excerpt.content === reply || excerpt.content.startsWith(`${reply}\n`))) matches.add(reply);
  }
  if (matches.size !== 1) {
    return { error: '无法确认旧回复的完整边界，请从笔记右上角「编辑」手动移除对应文字' };
  }

  const [reply] = matches;
  const replyEnd = offset + block.length - excerpt.content.length + reply.length;
  return { content: content.slice(0, offset) + content.slice(replyEnd) };
}

export function stripInlineImages(content: string): string {
  return (content || '')
    .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)\s*(?:---\s*)?/gi, '')
    .replace(/!\[[^\]]*\]\(\/uploads\/[^)]+\)\s*(?:---\s*)?/gi, '')
    .trim();
}
