import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import {
  countWords,
  db,
  deleteNoteFts,
  logStudyActivity,
  nowIso,
  syncNoteFts,
  uid,
  UPLOADS_DIR,
  upsertConcept,
} from '../db.js';
import { parseUploadedFile } from '../services/parser.js';
import {
  callVisionOCR,
  cleanOcrMarkdown,
  extractSmartTitle,
  summarizeNoteAI,
  synthesizeNotesAI,
} from '../services/ai.js';
import { nextNoteUpdatedAt, noteStudyText, readChatExcerpts, removeLegacyChatExcerpt, type ChatExcerpt } from '../shared/noteContent.js';

export const notesRouter = Router();

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.tiff']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const providedExt = path.extname(file.originalname).toLowerCase();
    let ext = imageExtensions.has(providedExt) ? providedExt : '.upload';
    if (providedExt === '.docx' || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') ext = '.docx';
    if (providedExt === '.pdf' || file.mimetype === 'application/pdf') ext = '.pdf';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024, files: 30 },
});

function formatNote(row: any) {
  if (!row) return null;
  let tags: string[] = [];
  let summary = null;
  try {
    tags = JSON.parse(row.tags || '[]');
  } catch {
    tags = [];
  }
  try {
    summary = row.summary_json ? JSON.parse(row.summary_json) : null;
  } catch {
    summary = null;
  }
  return {
    ...row,
    tags,
    summary,
    chat_excerpts: readChatExcerpts(row.chat_excerpts),
    is_pinned: Boolean(row.is_pinned),
  };
}

function getNoteRow(id: string) {
  return db.prepare(
    `SELECT n.*, c.name as category_name, c.color as category_color
     FROM notes n LEFT JOIN categories c ON n.category_id = c.id WHERE n.id = ?`
  ).get(id);
}

function inNoteTransaction<T>(write: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const noteMatchesLike = `(n.title LIKE ? OR n.content LIKE ? OR n.source_content LIKE ? OR n.tags LIKE ? OR EXISTS (
  SELECT 1 FROM json_each(n.chat_excerpts) AS excerpt WHERE json_extract(excerpt.value, '$.content') LIKE ?
))`;

// List & Search Notes
notesRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const categoryId = String(req.query.categoryId || '').trim();
  const tag = String(req.query.tag || '').trim();
  const sourceType = String(req.query.sourceType || '').trim();
  const hasSummary = String(req.query.hasSummary || '').trim();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (q) {
    // Combine FTS5 match + LIKE fallback so Chinese substring search is 100% accurate
    const likeTerm = `%${q}%`;
    const likeParams = Array<string>(5).fill(likeTerm);
    const safeFts = q.replace(/["'*():^]/g, ' ').trim();
    if (safeFts) {
      conditions.push(
        `(n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?) OR ${noteMatchesLike})`
      );
      params.push(`"${safeFts}"`, ...likeParams);
    } else {
      conditions.push(noteMatchesLike);
      params.push(...likeParams);
    }
  }

  if (categoryId === 'uncategorized') {
    conditions.push(`n.category_id IS NULL`);
  } else if (categoryId) {
    conditions.push(`n.category_id = ?`);
    params.push(categoryId);
  }

  if (tag) {
    conditions.push(`n.tags LIKE ?`);
    params.push(`%"${tag}"%`);
  }

  if (sourceType) {
    conditions.push(`n.source_type = ?`);
    params.push(sourceType);
  }

  if (hasSummary === 'true') {
    conditions.push(`n.summary_json IS NOT NULL`);
  } else if (hasSummary === 'false') {
    conditions.push(`n.summary_json IS NULL`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT n.*, c.name as category_name, c.color as category_color
    FROM notes n
    LEFT JOIN categories c ON n.category_id = c.id
    ${where}
    ORDER BY n.is_pinned DESC, n.updated_at DESC
  `;

  try {
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(formatNote));
  } catch {
    // Fallback without FTS if special query syntax occurs
    const likeTerm = `%${q}%`;
    const fallbackRows = db
      .prepare(
        `SELECT n.*, c.name as category_name, c.color as category_color
         FROM notes n LEFT JOIN categories c ON n.category_id = c.id
         WHERE ${noteMatchesLike}
         ORDER BY n.is_pinned DESC, n.updated_at DESC`
      )
      .all(...Array<string>(5).fill(likeTerm));
    res.json(fallbackRows.map(formatNote));
  }
});

// Get all unique tags
notesRouter.get('/meta/tags', (_req, res) => {
  const rows = db.prepare(`SELECT tags FROM notes`).all() as { tags: string }[];
  const counts: Record<string, number> = {};
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.tags || '[]') as string[];
      for (const t of arr) {
        counts[t] = (counts[t] || 0) + 1;
      }
    } catch {
      // ignore
    }
  }
  const result = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  res.json(result);
});

// List Syntheses (Multi-note induction reports)
notesRouter.get('/syntheses/list', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM syntheses ORDER BY created_at DESC`).all() as any[];
  res.json(
    rows.map((r) => ({
      ...r,
      note_ids: JSON.parse(r.note_ids || '[]'),
    }))
  );
});

notesRouter.delete('/syntheses/:id', (req, res) => {
  db.prepare(`DELETE FROM syntheses WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Get single note
notesRouter.get('/:id', (req, res) => {
  const row = getNoteRow(req.params.id);
  if (!row) return res.status(404).json({ error: '笔记不存在' });
  res.json(formatNote(row));
});

// Create note (paste / manual)
notesRouter.post('/', (req, res) => {
  const { title, content = '', categoryId = null, tags = [], sourceType = 'markdown' } = req.body || {};
  const finalTitle = String(title || '').trim() || '未命名笔记';
  const finalContent = String(content || '');
  const cleanTags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const id = uid();
  const now = nowIso();

  db.prepare(
    `INSERT INTO notes (id, title, content, category_id, tags, source_type, word_count, is_pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, finalTitle, finalContent, categoryId || null, JSON.stringify(cleanTags), sourceType, countWords(finalContent), now, now);

  syncNoteFts(id, finalTitle, finalContent, cleanTags);
  logStudyActivity('note_import', id);

  res.status(201).json(formatNote(getNoteRow(id)));
});

// Upload & Import files (supports batch MD/TXT/PDF/DOCX/Images + mobile camera photos!)
notesRouter.post('/import', upload.array('files', 30), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) {
    return res.status(400).json({ error: '请至少选择一个文件' });
  }

  const categoryId = req.body?.categoryId ? String(req.body.categoryId) : null;
  let extraTags: string[] = [];
  if (req.body?.tags) {
    try {
      extraTags = JSON.parse(req.body.tags);
    } catch {
      extraTags = String(req.body.tags)
        .split(/[,，\s]+/)
        .filter(Boolean);
    }
  }

  const imported: any[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    // Fix UTF-8 filename encoding quirk in multer/busboy on Windows/browsers
    let originalName = file.originalname;
    try {
      const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
      if (!decoded.includes('\uFFFD') && /[\u4e00-\u9fff]/.test(decoded)) {
        originalName = decoded;
      }
    } catch {
      // keep original
    }

    const attachmentUrl = `/uploads/${file.filename}`;
    try {
      const parsed = await parseUploadedFile(file.path, originalName, file.mimetype);
      if (parsed.warning) warnings.push(`${originalName}: ${parsed.warning}`);

      const id = uid();
      const now = nowIso();
      const keepAttachment = parsed.sourceType === 'pdf' || parsed.sourceType === 'image' || parsed.sourceType === 'docx';
      const isImage = parsed.sourceType === 'image';
      const row = inNoteTransaction(() => {
        db.prepare(
          `INSERT INTO notes (
            id, title, content, source_content, category_id, tags, source_type, source_filename,
            attachment_path, word_count, is_pinned, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run(
          id,
          parsed.title,
          isImage ? parsed.content : '',
          isImage ? null : parsed.content,
          categoryId || null,
          JSON.stringify(extraTags),
          parsed.sourceType,
          originalName,
          keepAttachment ? attachmentUrl : null,
          countWords(parsed.content),
          now,
          now
        );
        syncNoteFts(id, parsed.title, parsed.content, extraTags);
        logStudyActivity('note_import', id);
        return getNoteRow(id);
      });
      if (!keepAttachment) fs.unlink(file.path, () => {});
      imported.push(formatNote(row));
    } catch (err: any) {
      // Remove uploaded temp file on rejection/failure
      fs.unlink(file.path, () => {});
      warnings.push(`${originalName}：${err?.message || '解析失败'}`);
    }
  }

  if (imported.length === 0 && warnings.length > 0) {
    return res.status(400).json({ error: warnings.join('；') });
  }

  res.status(201).json({ imported, warnings });
});

type NoteChatText = { content: string; chat_excerpts: ChatExcerpt[] };

function editNoteChat(id: string, edit: (text: NoteChatText, updatedAt: string) => NoteChatText | { error: string }) {
  return inNoteTransaction(() => {
    const row = getNoteRow(id) as {
      title: string; content: string; source_content: string | null; chat_excerpts: string; tags: string; updated_at: string;
    } | undefined;
    if (!row) return { status: 404, data: { error: '笔记不存在' } };

    const current = { content: row.content, chat_excerpts: readChatExcerpts(row.chat_excerpts) };
    const updated = edit(current, row.updated_at);
    if ('error' in updated) return { status: 409, data: updated };
    if (updated === current) return { status: 200, data: formatNote(row) };

    const studyText = noteStudyText({ ...row, ...updated });
    db.prepare(`UPDATE notes SET content = ?, chat_excerpts = ?, word_count = ?, updated_at = ? WHERE id = ?`)
      .run(updated.content, JSON.stringify(updated.chat_excerpts), countWords(studyText), nextNoteUpdatedAt(row.updated_at), id);
    syncNoteFts(id, row.title, studyText, JSON.parse(row.tags || '[]'));
    return { status: 200, data: formatNote(getNoteRow(id)) };
  });
}

notesRouter.put('/:id/chat-excerpts/:excerptId', (req, res) => {
  const { id, excerptId } = req.params;
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: '聊天内容不能为空' });
  }

  const result = editNoteChat(id, (current) => {
    if (current.chat_excerpts.some((excerpt) => excerpt.id === excerptId)) return current;
    const excerpt = { id: excerptId, content, created_at: nowIso() };
    return { ...current, chat_excerpts: [...current.chat_excerpts, excerpt] };
  });
  res.status(result.status).json(result.data);
});

notesRouter.delete('/:id/chat-excerpts/:excerptId', (req, res) => {
  const { id, excerptId } = req.params;
  const result = editNoteChat(id, (current) => {
    const chat_excerpts = current.chat_excerpts.filter((excerpt) => excerpt.id !== excerptId);
    return chat_excerpts.length === current.chat_excerpts.length ? current : { ...current, chat_excerpts };
  });
  res.status(result.status).json(result.data);
});

notesRouter.delete('/:id/legacy-chat-excerpts/:offset', (req, res) => {
  const offset = Number(req.params.offset);
  const { block, updatedAt } = req.body || {};
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof block !== 'string' || !block || typeof updatedAt !== 'string') {
    return res.status(400).json({ error: '无效的旧版聊天段落' });
  }

  const result = editNoteChat(req.params.id, (current, currentUpdatedAt) => {
    if (updatedAt !== currentUpdatedAt) return { error: '笔记已更新，请重新打开笔记后再试' };
    const removal = removeLegacyChatExcerpt(current.content, offset, block, (text) => {
      const replies = db.prepare(`SELECT content FROM tutor_messages WHERE role = 'assistant' AND instr(?, content) = 1`)
        .all(text) as { content: string }[];
      return replies.map((reply) => reply.content);
    });
    return 'error' in removal ? removal : { ...current, content: removal.content };
  });
  res.status(result.status).json(result.data);
});

// Re-run Vision OCR on an image note
notesRouter.post('/:id/ocr', async (req, res) => {
  const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(req.params.id) as any;
  if (!note) return res.status(404).json({ error: '笔记不存在' });
  if (note.source_type !== 'image' || !note.attachment_path) return res.status(400).json({ error: '该笔记没有关联图片附件' });

  const fileName = path.basename(note.attachment_path);
  const fullPath = path.join(UPLOADS_DIR, fileName);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '原始图片文件已不存在' });

  try {
    const ext = path.extname(fullPath).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const base64 = fs.readFileSync(fullPath).toString('base64');
    const ocrText = cleanOcrMarkdown(await callVisionOCR(base64, mime));
    const isGenericTitle = /^(JPEG_|IMG_|Screenshot|图片笔记|微信图片|Photo)/i.test(note.title);
    const newTitle = isGenericTitle ? extractSmartTitle(ocrText, note.title) : note.title;
    const now = nowIso();
    const updated = inNoteTransaction(() => {
      const current = getNoteRow(note.id);
      if (!current) return null;
      const studyText = noteStudyText({ ...current, content: ocrText });
      // Clear stale summary_json so outdated error summaries never remain after re-OCR.
      db.prepare(`UPDATE notes SET title = ?, content = ?, summary_json = NULL, word_count = ?, updated_at = ? WHERE id = ?`)
        .run(newTitle, ocrText, countWords(studyText), now, note.id);
      syncNoteFts(note.id, newTitle, studyText, JSON.parse(String(current.tags || '[]')));
      return getNoteRow(note.id);
    });
    if (!updated) return res.status(404).json({ error: '笔记不存在' });
    res.json(formatNote(updated));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '图片识别失败' });
  }
});

// Update note
notesRouter.put('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: '笔记不存在' });

  const title = req.body.title !== undefined ? String(req.body.title).trim() || existing.title : existing.title;
  const content = req.body.content !== undefined ? String(req.body.content) : existing.content;
  const categoryId = req.body.categoryId !== undefined ? req.body.categoryId || null : existing.category_id;
  const tags: string[] =
    req.body.tags !== undefined
      ? Array.isArray(req.body.tags)
        ? req.body.tags.map((t: any) => String(t).trim()).filter(Boolean)
        : []
      : JSON.parse(existing.tags || '[]');
  const isPinned = req.body.isPinned !== undefined ? (req.body.isPinned ? 1 : 0) : existing.is_pinned;
  const now = nextNoteUpdatedAt(existing.updated_at);
  const studyText = noteStudyText({ ...existing, content });

  const updated = inNoteTransaction(() => {
    db.prepare(
      `UPDATE notes SET title = ?, content = ?, category_id = ?, tags = ?, word_count = ?, is_pinned = ?, updated_at = ? WHERE id = ?`
    ).run(title, content, categoryId, JSON.stringify(tags), countWords(studyText), isPinned, now, existing.id);
    syncNoteFts(existing.id, title, studyText, tags);
    return getNoteRow(existing.id);
  });
  res.json(formatNote(updated));
});

// Delete note
notesRouter.delete('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: '笔记不存在' });

  if (existing.attachment_path) {
    const fp = path.join(UPLOADS_DIR, path.basename(existing.attachment_path));
    if (fs.existsSync(fp)) fs.unlink(fp, () => {});
  }
  deleteNoteFts(existing.id);
  db.prepare(`DELETE FROM notes WHERE id = ?`).run(existing.id);
  res.json({ ok: true });
});

// AI Summarize Single Note + Extract Concepts into Knowledge Graph
notesRouter.post('/:id/summarize', async (req, res) => {
  const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(req.params.id) as any;
  if (!note) return res.status(404).json({ error: '笔记不存在' });

  const applyMeta = req.body?.applyMeta !== false;
  const cats = db.prepare(`SELECT id, name FROM categories`).all() as { id: string; name: string }[];

  try {
    const summary = await summarizeNoteAI(
      note.title,
      noteStudyText(note),
      cats.map((c) => c.name)
    );

    const current = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(note.id) as typeof note;
    if (!current) return res.status(404).json({ error: '笔记不存在' });
    let categoryId = current.category_id;
    let tags: string[] = JSON.parse(current.tags || '[]');

    if (applyMeta) {
      // Auto-merge suggested tags
      if (summary.suggestedTags?.length) {
        const merged = new Set([...tags, ...summary.suggestedTags]);
        tags = Array.from(merged).slice(0, 8);
      }
      // Auto-assign category if note currently uncategorized
      if (!categoryId && summary.suggestedCategory) {
        const matched = cats.find((c) => c.name === summary.suggestedCategory);
        if (matched) {
          categoryId = matched.id;
        } else {
          const newCatId = uid();
          db.prepare(`INSERT INTO categories (id, name, color, icon, created_at) VALUES (?, ?, '#3B5BDB', 'folder', ?)`).run(
            newCatId,
            summary.suggestedCategory,
            nowIso()
          );
          categoryId = newCatId;
        }
      }
    }

    const now = nowIso();
    db.prepare(`UPDATE notes SET summary_json = ?, category_id = ?, tags = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(summary),
      categoryId,
      JSON.stringify(tags),
      now,
      note.id
    );
    syncNoteFts(note.id, current.title, noteStudyText(current), tags);

    // Populate Knowledge Graph concepts & relations
    const nameToId: Record<string, string> = {};
    for (const c of summary.concepts || []) {
      const cid = upsertConcept(c.name, c.definition, categoryId, note.id);
      if (cid) nameToId[c.name] = cid;
    }
    for (const rel of summary.relations || []) {
      const src = nameToId[rel.source];
      const tgt = nameToId[rel.target];
      if (src && tgt && src !== tgt) {
        db.prepare(
          `INSERT OR IGNORE INTO concept_links (id, source_id, target_id, relation, weight) VALUES (?, ?, ?, ?, 1.0)`
        ).run(uid(), src, tgt, rel.relation || '相关');
      }
    }

    logStudyActivity('note_summary', note.id);

    const updated = db
      .prepare(`SELECT n.*, c.name as category_name, c.color as category_color FROM notes n LEFT JOIN categories c ON n.category_id = c.id WHERE n.id = ?`)
      .get(note.id);
    res.json(formatNote(updated));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'AI 总结失败' });
  }
});

// AI Cross-Note Synthesis (多篇笔记归纳)
notesRouter.post('/synthesize', async (req, res) => {
  const { noteIds = [], title, categoryId = null } = req.body || {};
  let targetNotes: any[] = [];

  if (Array.isArray(noteIds) && noteIds.length > 0) {
    const placeholders = noteIds.map(() => '?').join(',');
    targetNotes = db.prepare(`SELECT * FROM notes WHERE id IN (${placeholders})`).all(...noteIds) as any[];
  } else if (categoryId) {
    targetNotes = db.prepare(`SELECT * FROM notes WHERE category_id = ? ORDER BY updated_at DESC LIMIT 10`).all(categoryId) as any[];
  }

  if (targetNotes.length < 1) {
    return res.status(400).json({ error: '请至少选择 1 篇笔记进行归纳' });
  }

  try {
    const markdown = await synthesizeNotesAI(
      targetNotes.map((n) => ({
        title: n.title,
        content: noteStudyText(n),
        tags: JSON.parse(n.tags || '[]'),
      }))
    );

    const synId = uid();
    const synTitle =
      String(title || '').trim() ||
      (targetNotes.length === 1 ? `《${targetNotes[0].title}》专题归纳` : `专题归纳（${targetNotes.length} 篇笔记）`);
    const now = nowIso();

    db.prepare(
      `INSERT INTO syntheses (id, title, note_ids, category_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(synId, synTitle, JSON.stringify(targetNotes.map((n) => n.id)), categoryId || null, markdown, now);

    logStudyActivity('note_summary', synId);

    res.status(201).json({
      id: synId,
      title: synTitle,
      note_ids: targetNotes.map((n) => n.id),
      category_id: categoryId,
      content: markdown,
      created_at: now,
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '多篇笔记归纳失败' });
  }
});
