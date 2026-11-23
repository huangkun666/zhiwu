import { Router } from 'express';
import { db, existingNoteIds, inTransaction, logStudyActivity, nowIso, uid } from '../db.js';
import { tutorChatAI, tutorChatStreamAI } from '../services/ai.js';
import { readIds } from '../shared/libraryReferences.js';
import { noteStudyText } from '../shared/noteContent.js';

export const tutorRouter = Router();

function getContextNotes(noteIds: string[]) {
  const condition = noteIds.length
    ? `WHERE id IN (${noteIds.map(() => '?').join(',')})`
    : 'ORDER BY updated_at DESC LIMIT 4';
  const rows = db.prepare(`SELECT title, content, source_content, chat_excerpts FROM notes ${condition}`).all(...noteIds) as
    Array<{ title: string } & Parameters<typeof noteStudyText>[0]>;
  return rows.map((row) => ({ title: row.title, content: noteStudyText(row) }));
}

function replyContext(requested: unknown) {
  const requestedIds = readIds(requested);
  const noteIds = existingNoteIds(requestedIds);
  const notes = noteIds.length || !requestedIds.length ? getContextNotes(noteIds) : [];
  return { noteIds, notes };
}

function saveTutorReply(sessionId: string, message: string, reply: string, noteIds: string[], mode: string) {
  return inTransaction(() => {
    if (!db.prepare(`SELECT 1 FROM tutor_sessions WHERE id = ?`).get(sessionId)) throw new Error('会话已被删除');
    const userMessage = { id: uid(), session_id: sessionId, role: 'user', content: message, created_at: nowIso() };
    const assistantMessage = { id: uid(), session_id: sessionId, role: 'assistant', content: reply, created_at: new Date(Date.now() + 10).toISOString() };
    const insert = db.prepare(`INSERT INTO tutor_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const saved of [userMessage, assistantMessage]) {
      insert.run(saved.id, sessionId, saved.role, saved.content, saved.created_at);
    }
    db.prepare(`UPDATE tutor_sessions SET note_ids = ?, mode = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(existingNoteIds(noteIds)), mode, assistantMessage.created_at, sessionId);
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
      note_ids: readIds(r.note_ids),
    }))
  );
});

// Create session
tutorRouter.post('/sessions', (req, res) => {
  const { title, mode = 'qa', noteIds = [], initialPrompt } = req.body || {};
  const id = uid();
  const now = nowIso();
  const safeMode = mode === 'feynman' ? 'feynman' : 'qa';
  const sessionTitle =
    String(title || '').trim() || (safeMode === 'feynman' ? '费曼考官演练' : '笔记深度答疑');
  const references = existingNoteIds(noteIds);

  db.prepare(
    `INSERT INTO tutor_sessions (id, title, mode, note_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, sessionTitle, safeMode, JSON.stringify(references), now, now);

  // Add an inviting opening message from the tutor
  const opening =
    safeMode === 'feynman'
      ? `你好！我是你的**费曼学习法考官**。\n\n请选择一个概念，试着用**你自己的大白话**把它讲给我听（就像讲给完全没学过的朋友一样）。我会帮你找出逻辑盲区并逐步追问，直到你真正吃透！${
          initialPrompt ? `\n\n> 当前聚焦主题：${initialPrompt}` : ''
        }`
      : `你好！我是你的**知悟学习助教**。我已经准备好结合你的笔记为你深度答疑、举例类比或拆解难点。随时提问吧！${
          initialPrompt ? `\n\n> 当前聚焦主题：${initialPrompt}` : ''
        }`;

  db.prepare(
    `INSERT INTO tutor_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`
  ).run(uid(), id, opening, now);

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
    session: { ...session, note_ids: existingNoteIds(session.note_ids) },
    messages,
  });
});

// Send message & get AI tutor response
tutorRouter.post('/sessions/:id/chat', async (req, res) => {
  const session = db.prepare(`SELECT * FROM tutor_sessions WHERE id = ?`).get(req.params.id) as any;
  if (!session) return res.status(404).json({ error: '会话不存在' });

  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: '消息内容不能为空' });

  const mode: 'qa' | 'feynman' = req.body?.mode === 'feynman' || session.mode === 'feynman' ? 'feynman' : 'qa';
  const { noteIds, notes } = replyContext(req.body?.noteIds ?? session.note_ids);

  const history = db
    .prepare(`SELECT role, content FROM tutor_messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(session.id) as { role: 'user' | 'assistant'; content: string }[];

  try {
    const reply = await tutorChatAI(mode, notes, history, message);
    res.json(saveTutorReply(session.id, message, reply, noteIds, mode));
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

  const mode: 'qa' | 'feynman' = req.body?.mode === 'feynman' || session.mode === 'feynman' ? 'feynman' : 'qa';
  const { noteIds, notes } = replyContext(req.body?.noteIds ?? session.note_ids);

  const history = db
    .prepare(`SELECT role, content FROM tutor_messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(session.id) as { role: 'user' | 'assistant'; content: string }[];

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const reply = await tutorChatStreamAI(mode, notes, history, message, (delta) => {
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    });

    const saved = saveTutorReply(session.id, message, reply, noteIds, mode);
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
