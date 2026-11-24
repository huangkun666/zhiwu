import { stripTutorMetadata } from './tutorScan.js';
import type { TutorMode } from './tutorMode.js';

export interface TutorChatPayload {
  message: string;
  mode?: TutorMode;
  noteIds?: string[];
  discardedNoteIds?: string[];
  turnId?: string;
}

export function tutorMessageIds(sessionId: string, turnId: unknown) {
  if (turnId === undefined) return;
  if (typeof turnId !== 'string' || !/^[0-9a-f]{32}$/.test(turnId)) throw new Error('无效的提问标识');
  const prefix = `turn-${sessionId}-${turnId}`;
  return { user: prefix + '-user', assistant: prefix + '-assistant' };
}

export function savedTutorPair<T extends { id: string; role: string; content: string }>(
  messages: T[], ids: ReturnType<typeof tutorMessageIds>, question: string,
) {
  if (!ids) return;
  const userMessage = messages.find(item => item.id === ids.user);
  const assistantMessage = messages.find(item => item.id === ids.assistant);
  if (!userMessage && !assistantMessage) return;
  if (userMessage?.role !== 'user' || userMessage.content !== question || assistantMessage?.role !== 'assistant') {
    throw new Error('本次提问标识与已保存的问答不一致');
  }
  return { userMessage, assistantMessage };
}

export const TUTOR_HISTORY_PAGE_SIZE = 30;
export const TUTOR_TITLE_MAX_LENGTH = 200;

export function tutorSessionTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new Error('会话标题不能为空');
  if (title.length > TUTOR_TITLE_MAX_LENGTH) throw new Error(`会话标题最多 ${TUTOR_TITLE_MAX_LENGTH} 个字符`);
  return title;
}

interface HistoryKey {
  updated_at: string;
  id: string;
}

export function readTutorHistoryCursor(value: unknown): HistoryKey | undefined {
  if (value === undefined) return;
  if (typeof value === 'string') {
    try {
      const pair: unknown = JSON.parse(value);
      if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string' && pair[1]) {
        return { updated_at: pair[0], id: pair[1] };
      }
    } catch { /* Report malformed JSON and invalid fields alike. */ }
  }
  throw new Error('历史对话分页参数无效');
}

// SQLite BINARY compares UTF-8 text by code point, including imported non-ASCII IDs.
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  let index = 0;
  while (index < left.length && index < right.length) {
    const a = left.codePointAt(index)!;
    const b = right.codePointAt(index)!;
    if (a !== b) return a - b;
    index += a > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

export function compareTutorHistory(left: HistoryKey, right: HistoryKey): number {
  return compareText(right.updated_at, left.updated_at) || compareText(right.id, left.id);
}

interface HistoryMessage {
  role: string;
  content: string;
}

function matchingSnippet(messages: Iterable<HistoryMessage>, term: RegExp): string | undefined {
  for (const { role, content } of messages) {
    if (typeof content !== 'string' || (role !== 'user' && role !== 'assistant')) continue;
    // Keep the visible label of a citation and omit machine-readable scan progress.
    const text = role === 'assistant' ? stripTutorMetadata(content)
      .replace(/(\*\*|~~)([^\n]+?)\1/g, '$2') : content;
    const match = term.exec(text);
    if (!match) continue;
    const length = 140;
    const before = Math.min(45, Math.max(0, length - match[0].length));
    const start = Math.max(0, match.index - before);
    const end = Math.min(text.length, start + length);
    const excerpt = text.slice(start, end).replace(/^\p{Cs}|\p{Cs}$/gu, '').replace(/\s+/g, ' ').trim();
    return (start ? '…' : '') + excerpt + (end < text.length ? '…' : '');
  }
}

export function tutorHistoryPage<T extends HistoryKey & { title: string }>(
  sessions: Iterable<T>, query: string, messagesFor: (id: string) => Iterable<HistoryMessage>,
) {
  const search = query.trim();
  const term = search ? new RegExp(search.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'iu') : undefined;
  const items: (T & { matchSnippet?: string })[] = [];
  for (const session of sessions) {
    const matchSnippet = term ? matchingSnippet(messagesFor(session.id), term) : undefined;
    if (term && matchSnippet === undefined && !term.test(session.title)) continue;
    if (items.length === TUTOR_HISTORY_PAGE_SIZE) {
      const last = items[items.length - 1];
      return { items, nextCursor: JSON.stringify([last.updated_at, last.id]) };
    }
    items.push(matchSnippet === undefined ? session : { ...session, matchSnippet });
  }
  return { items, nextCursor: null };
}
