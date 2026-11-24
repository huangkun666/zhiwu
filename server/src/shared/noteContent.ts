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
