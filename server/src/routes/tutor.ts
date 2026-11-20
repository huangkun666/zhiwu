import { Router } from 'express';
import { db, logStudyActivity, nowIso, uid } from '../db.js';
import { tutorChatAI } from '../services/ai.js';

export const tutorRouter = Router();

// List sessions
tutorRouter.get('/sessions', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM tutor_sessions ORDER BY updated_at DESC LIMIT 30`).all() as any[];
  res.json(
    rows.map((r) => ({
      ...r,
      note_ids: JSON.parse(r.note_ids || '[]'),
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

  db.prepare(
    `INSERT INTO tutor_sessions (id, title, mode, note_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, sessionTitle, safeMode, JSON.stringify(Array.isArray(noteIds) ? noteIds : []), now, now);

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
    note_ids: Array.isArray(noteIds) ? noteIds : [],
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
    session: { ...session, note_ids: JSON.parse(session.note_ids || '[]') },
    messages,
  });
});

// Send message & get AI tutor response
tutorRouter.post('/sessions/:id/chat', async (req, res) => {
  const session = db.prepare(`SELECT * FROM tutor_sessions WHERE id = ?`).get(req.params.id) as any;
  if (!session) return res.status(404).json({ error: '会话不存在' });

  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: '消息内容不能为空' });

  const noteIds: string[] = Array.isArray(req.body?.noteIds)
    ? req.body.noteIds
    : JSON.parse(session.note_ids || '[]');
  const mode: 'qa' | 'feynman' = req.body?.mode === 'feynman' || session.mode === 'feynman' ? 'feynman' : 'qa';

  // Fetch context notes
  let notes: { title: string; content: string }[] = [];
  if (noteIds.length > 0) {
    const ph = noteIds.map(() => '?').join(',');
    notes = db.prepare(`SELECT title, content FROM notes WHERE id IN (${ph})`).all(...noteIds) as any[];
  } else {
    notes = db.prepare(`SELECT title, content FROM notes ORDER BY updated_at DESC LIMIT 4`).all() as any[];
  }

  const history = db
    .prepare(`SELECT role, content FROM tutor_messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(session.id) as { role: 'user' | 'assistant'; content: string }[];

  try {
    const reply = await tutorChatAI(mode, notes, history, message);
    const t1 = nowIso();
    const userMsgId = uid();
    db.prepare(
      `INSERT INTO tutor_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`
    ).run(userMsgId, session.id, message, t1);

    const t2 = new Date(Date.now() + 10).toISOString();
    const aiMsgId = uid();
    db.prepare(
      `INSERT INTO tutor_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)`
    ).run(aiMsgId, session.id, reply, t2);

    db.prepare(`UPDATE tutor_sessions SET note_ids = ?, mode = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(noteIds),
      mode,
      t2,
      session.id
    );
    logStudyActivity('tutor_chat', session.id, null, 60);

    res.json({
      userMessage: { id: userMsgId, session_id: session.id, role: 'user', content: message, created_at: t1 },
      assistantMessage: { id: aiMsgId, session_id: session.id, role: 'assistant', content: reply, created_at: t2 },
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '助教回复失败' });
  }
});

tutorRouter.delete('/sessions/:id', (req, res) => {
  db.prepare(`DELETE FROM tutor_sessions WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});
