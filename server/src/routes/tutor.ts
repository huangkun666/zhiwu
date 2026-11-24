import { Router } from 'express';
import { db, existingNoteIds, inTransaction, logStudyActivity, nowIso, uid } from '../db.js';
import { callLLM, tutorChatAI, tutorChatStreamAI } from '../services/ai.js';
import { existingIds, readIds, tutorNoteScope, tutorNoteSelection } from '../shared/libraryReferences.js';
import { nextNoteUpdatedAt } from '../shared/noteContent.js';
import { readTutorHistoryCursor, tutorHistoryPage, tutorSessionTitle } from '../shared/tutorHistory.js';
import { prepareTutorTurn, runTutorChat } from '../shared/tutorContext.js';
import { newTutorMode, requireTutorMode, tutorDefaultTitles, type TutorMode } from '../shared/tutorMode.js';
import { ensurePdfPageIndexes, readPdfPageWithVision } from '../services/pdfPageIndex.js';

export const tutorRouter = Router();

interface StoredTutorSession {
  id: string;
  title: string;
  mode: TutorMode;
  note_ids: string;
  created_at: string;
  updated_at: string;
}

function updateSession(id: string, changes: Partial<Pick<StoredTutorSession, 'title' | 'mode'>>) {
  return inTransaction(() => {
    const current = db.prepare('SELECT * FROM tutor_sessions WHERE id = ?').get(id) as unknown as StoredTutorSession | undefined;
    if (!current) return;
    const { title, mode } = { ...current, ...changes };
    if (current.title === title && current.mode === mode) return current;
    const updated_at = nextNoteUpdatedAt(current.updated_at);
    db.prepare('UPDATE tutor_sessions SET title = ?, mode = ?, updated_at = ? WHERE id = ?').run(title, mode, updated_at, id);
    return { ...current, title, mode, updated_at };
  });
}

async function answerTutor(
  session: StoredTutorSession,
  message: string,
  options?: { mode?: string; noteIds?: unknown; discardedNoteIds?: unknown },
  onDelta?: (text: string) => void,
  progress?: (message: string) => void,
) {
  const mode = options?.mode === undefined ? session.mode : requireTutorMode(options.mode);
  // Older clients set the mode with their next message. Apply that choice before awaiting the model.
  if (mode !== session.mode) updateSession(session.id, { mode });
  const history = db.prepare(
    `SELECT role, content FROM tutor_messages WHERE session_id = ? AND role IN ('user','assistant')
     ORDER BY created_at DESC, rowid DESC LIMIT 12`
  ).all(session.id).reverse() as { role: 'user' | 'assistant'; content: string }[];
  async function readNotes() {
    const { ids, automatic } = tutorNoteScope(mode, session.note_ids, options?.noteIds);
    const noteIds = existingNoteIds(ids);
    const selectNoteIds = mode === 'general' ? undefined
      : tutorNoteSelection(session.note_ids, existingNoteIds(session.note_ids), noteIds, options?.discardedNoteIds);
    await ensurePdfPageIndexes(automatic ? undefined : noteIds);
    const condition = automatic ? '' : 'WHERE id IN (SELECT value FROM json_each(?))';
    const params = automatic ? [] : [JSON.stringify(noteIds)];
    const notes = db.prepare(
      `SELECT id, title, content, source_type, source_filename, source_content, source_pages, chat_excerpts, tags, updated_at
       FROM active_notes ${condition} ORDER BY updated_at DESC, id`
    ).all(...params) as unknown as Parameters<typeof prepareTutorTurn>[1];
    const versions = new Map(notes.map(note => [note.id, note.updated_at]));
    const current = () => {
      const rows = db.prepare(`SELECT id, updated_at FROM active_notes ${condition}`).all(...params);
      return new Set(rows.flatMap(row => versions.get(String(row.id)) === row.updated_at ? [String(row.id)] : []));
    };
    const turn = await prepareTutorTurn(mode, notes, automatic, history, message,
      (query) => callLLM(query, { temperature: 0, maxTokens: query[0].content.startsWith('ZHIWU_SCAN') ? 1800 : 300 }),
      async () => current(), readPdfPageWithVision, progress);
    return { messages: turn.messages, render: (reply: string) => turn.render(reply, current()), selectNoteIds };
  }
  const { reply, sources } = await runTutorChat(mode, history, message,
    (messages, emit) => onDelta ? tutorChatStreamAI(mode, messages, emit ?? (() => {})) : tutorChatAI(mode, messages),
    readNotes, onDelta);
  return saveTutorReply(session.id, message, () => sources ? sources.render(reply) : reply, sources?.selectNoteIds);
}

function saveTutorReply(sessionId: string, message: string, renderReply: () => string, selectNoteIds?: (latest: unknown) => string[]) {
  return inTransaction(() => {
    const session = db.prepare(`SELECT note_ids, updated_at FROM tutor_sessions WHERE id = ?`).get(sessionId) as
      Pick<StoredTutorSession, 'note_ids' | 'updated_at'> | undefined;
    if (!session) throw new Error('会话已被删除');
    const userMessage = { id: uid(), session_id: sessionId, role: 'user', content: message, created_at: nowIso() };
    const assistantMessage = { id: uid(), session_id: sessionId, role: 'assistant', content: renderReply(), created_at: new Date(Date.now() + 10).toISOString() };
    const insert = db.prepare(`INSERT INTO tutor_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const saved of [userMessage, assistantMessage]) {
      insert.run(saved.id, sessionId, saved.role, saved.content, saved.created_at);
    }
    const updatedAt = Date.parse(assistantMessage.created_at) > Date.parse(session.updated_at)
      ? assistantMessage.created_at : nextNoteUpdatedAt(session.updated_at);
    if (selectNoteIds) {
      const ids = existingNoteIds(selectNoteIds(session.note_ids), true);
      db.prepare('UPDATE tutor_sessions SET note_ids = ? WHERE id = ?').run(JSON.stringify(ids), sessionId);
    }
    db.prepare('UPDATE tutor_sessions SET updated_at = ? WHERE id = ?').run(updatedAt, sessionId);
    logStudyActivity('tutor_chat', sessionId, null, 60);
    return { userMessage, assistantMessage };
  });
}

// List sessions
tutorRouter.get('/sessions', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM tutor_sessions ORDER BY updated_at DESC LIMIT 30`).all() as any[];
  res.json(
    rows.map((r) => ({
      ...r,
      note_ids: existingNoteIds(r.note_ids),
    }))
  );
});

// Full history, including older sessions outside the recent-sessions shortcut.
tutorRouter.get('/history', (req, res) => {
  const query = req.query.q ?? '';
  if (typeof query !== 'string') return res.status(400).json({ error: '搜索词必须是文本' });
  let after;
  try {
    after = readTutorHistoryCursor(req.query.cursor);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const sessions = db.prepare(`SELECT * FROM tutor_sessions ${after ? 'WHERE (updated_at, id) < (?, ?)' : ''}
    ORDER BY updated_at DESC, id DESC`).iterate(...(after ? [after.updated_at, after.id] : []));
  const messages = db.prepare(`SELECT role, content FROM tutor_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`);
  const page = tutorHistoryPage(sessions as unknown as Iterable<StoredTutorSession>, query,
    (id) => messages.iterate(id) as unknown as Iterable<{ role: string; content: string }>);
  const visible = new Set(existingNoteIds(page.items.flatMap((item) => readIds(item.note_ids))));
  res.json({ ...page, items: page.items.map((item) => ({ ...item, note_ids: existingIds(item.note_ids, visible) })) });
});

tutorRouter.patch('/sessions/:id', (req, res) => {
  const changes: Partial<Pick<StoredTutorSession, 'title' | 'mode'>> = {};
  try {
    if (req.body?.title !== undefined) changes.title = tutorSessionTitle(req.body.title);
    if (req.body?.mode !== undefined) changes.mode = requireTutorMode(req.body.mode);
    if (!changes.title && !changes.mode) throw new Error('请提供会话标题或模式');
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const session = updateSession(req.params.id, changes);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  res.json({ ...session, note_ids: existingNoteIds(session.note_ids) });
});

// Create session
tutorRouter.post('/sessions', (req, res) => {
  const { title, mode, noteIds, initialPrompt } = req.body || {};
  let safeMode: TutorMode;
  try {
    safeMode = newTutorMode(mode, noteIds);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const id = uid();
  const now = nowIso();
  const sessionTitle = String(title || '').trim() || tutorDefaultTitles[safeMode];
  const references = safeMode === 'general' ? [] : existingNoteIds(noteIds);

  // Add an inviting opening message from the tutor
  const opening =
    safeMode === 'general' ? null : safeMode === 'feynman'
      ? `你好！我是你的**费曼学习法考官**。\n\n请选择一个概念，试着用**你自己的大白话**把它讲给我听（就像讲给完全没学过的朋友一样）。我会帮你找出逻辑盲区并逐步追问，直到你真正吃透！${
          initialPrompt ? `\n\n> 当前聚焦主题：${initialPrompt}` : ''
        }`
      : `你好！我是你的**知悟学习助教**。我已经准备好结合你的笔记为你深度答疑、举例类比或拆解难点。随时提问吧！${
          initialPrompt ? `\n\n> 当前聚焦主题：${initialPrompt}` : ''
        }`;

  inTransaction(() => {
    db.prepare(`INSERT INTO tutor_sessions (id, title, mode, note_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, sessionTitle, safeMode, JSON.stringify(references), now, now);
    if (opening) db.prepare(
      `INSERT INTO tutor_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`
    ).run(uid(), id, opening, now);
  });

  res.status(201).json({
    id,
    title: sessionTitle,
    mode: safeMode,
    note_ids: references,
    created_at: now,
    updated_at: now,
  });
});

// Get messages of a session
tutorRouter.get('/sessions/:id/messages', (req, res) => {
  const session = db.prepare(`SELECT * FROM tutor_sessions WHERE id = ?`).get(req.params.id) as any;
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const messages = db
    .prepare(`SELECT * FROM tutor_messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(session.id);
  res.json({
    session: { ...session, note_ids: existingNoteIds(session.note_ids), selection_ids: existingNoteIds(session.note_ids, true) },
    messages,
  });
});

// Send message & get AI tutor response
tutorRouter.post('/sessions/:id/chat', async (req, res) => {
  const session = db.prepare(`SELECT * FROM tutor_sessions WHERE id = ?`).get(req.params.id) as any;
  if (!session) return res.status(404).json({ error: '会话不存在' });

  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: '消息内容不能为空' });

  try {
    res.json(await answerTutor(session, message, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '助教回复失败' });
  }
});

// Streaming chat endpoint (SSE) for instant typewriter UX
tutorRouter.post('/sessions/:id/chat-stream', async (req, res) => {
  const session = db.prepare(`SELECT * FROM tutor_sessions WHERE id = ?`).get(req.params.id) as any;
  if (!session) return res.status(404).json({ error: '会话不存在' });

  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: '消息内容不能为空' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const saved = await answerTutor(session, message, req.body,
      delta => res.write(`data: ${JSON.stringify({ delta })}\n\n`),
      status => res.write(`data: ${JSON.stringify({ status })}\n\n`));
    res.write(`data: ${JSON.stringify({ done: true, ...saved })}\n\n`);
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err?.message || '助教回复失败' })}\n\n`);
    res.end();
  }
});

tutorRouter.delete('/sessions/:id', (req, res) => {
  db.prepare(`DELETE FROM tutor_sessions WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});
