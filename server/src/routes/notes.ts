import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import {
  countWords,
  db,
  deleteNoteFts,
  existingCategoryId,
  existingNoteIds,
  inTransaction,
  logStudyActivity,
  nowIso,
  reconcileLibraryReferences,
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
import { readIds } from '../shared/libraryReferences.js';

export const notesRouter = Router();

const originalExtensions = new Set(['.md', '.markdown', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.tiff']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const providedExt = path.extname(file.originalname).toLowerCase();
    let ext = originalExtensions.has(providedExt) ? providedExt : '.upload';
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

function formatSearchResult(row: Record<string, unknown>, query: string) {
  const { id, title, category_id, source_filename, tags, summary, content, source_content, chat_excerpts } = formatNote(row)!;
  const texts = [content, source_content, ...chat_excerpts.map(({ content }: ChatExcerpt) => content)]
    .filter((text): text is string => typeof text === 'string' && Boolean(text.trim()));
  const needle = query.toLowerCase();
  const abstract = typeof summary?.abstract === 'string' ? summary.abstract : '';
  let excerpt = (abstract || texts[0] || '').slice(0, 240);
  if (needle) {
    for (const text of texts) {
      const match = text.toLowerCase().indexOf(needle);
      if (match < 0) continue;
      const offset = Math.max(0, match - 48);
      excerpt = `${offset ? '…' : ''}${text.slice(offset, offset + 240)}${text.length > offset + 240 ? '…' : ''}`;
      break;
    }
  }
  return { id, title, category_id, source_filename, tags, excerpt };
}

function getNoteRow(id: string) {
  return db.prepare(
    `SELECT n.*, c.name as category_name, c.color as category_color
     FROM active_notes n LEFT JOIN categories c ON n.category_id = c.id WHERE n.id = ?`
  ).get(id);
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
  const compact = req.query.view === 'compact';
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : null;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

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

  const select = (textMatch = '', textParams: string[] = []) => {
    const predicates = [textMatch, ...conditions].filter(Boolean);
    const sql = `SELECT n.*, c.name as category_name, c.color as category_color
      FROM active_notes n LEFT JOIN categories c ON n.category_id = c.id
      ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
      ORDER BY n.is_pinned DESC, n.updated_at DESC${limit ? ' LIMIT ?' : ''}`;
    const bindings = limit ? [...textParams, ...params, limit] : [...textParams, ...params];
    const statement = db.prepare(sql);
    if (compact) return Array.from(statement.iterate(...bindings), (row) => formatSearchResult(row, q));
    return statement.all(...bindings).map(formatNote);
  };
  if (!q) return res.json(select());

  const likeParams = Array<string>(5).fill(`%${q}%`);
  const safeFts = q.replace(/["'*():^]/g, ' ').trim();
  if (safeFts) {
    try {
      return res.json(select(`(n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?) OR ${noteMatchesLike})`,
        [`"${safeFts}"`, ...likeParams]));
    } catch {
      // Use substring matching with the same filters if FTS cannot parse the query.
    }
  }
  res.json(select(noteMatchesLike, likeParams));
});

// Get all unique tags
notesRouter.get('/meta/tags', (_req, res) => {
  const rows = db.prepare(`SELECT tags FROM active_notes`).all() as { tags: string }[];
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
      note_ids: existingNoteIds(r.note_ids),
    }))
  );
});

notesRouter.delete('/syntheses/:id', (req, res) => {
  db.prepare(`DELETE FROM syntheses WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

notesRouter.get('/trash', (_req, res) => {
  const rows = db.prepare(`SELECT n.id, n.title, n.source_type, n.source_filename, n.deleted_at, n.updated_at,
    n.category_id, n.word_count, c.name AS category_name, c.color AS category_color
    FROM notes n LEFT JOIN categories c ON c.id = n.category_id
    WHERE n.deleted_at IS NOT NULL ORDER BY n.deleted_at DESC, n.id`).all();
  res.json(rows);
});

function setNoteTrashed(id: string, trashed: boolean): boolean {
  return inTransaction(() => {
    const note = db.prepare(`SELECT deleted_at, updated_at FROM notes WHERE id = ?`).get(id) as
      { deleted_at: string | null; updated_at: string } | undefined;
    if (!note) return false;
    if ((note.deleted_at !== null) !== trashed) {
      db.prepare(`UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?`)
        .run(trashed ? nowIso() : null, nextNoteUpdatedAt(note.updated_at), id);
    }
    return true;
  });
}

notesRouter.post('/trash/:id/restore', (req, res) => {
  if (!setNoteTrashed(req.params.id, false)) return res.status(404).json({ error: '笔记不存在' });
  res.json({ ok: true });
});

notesRouter.delete('/trash/:id', async (req, res) => {
  const deleted = inTransaction(() => {
    const note = db.prepare(`SELECT id, attachment_path FROM notes WHERE id = ? AND deleted_at IS NOT NULL`).get(req.params.id) as
      { id: string; attachment_path: string | null } | undefined;
    if (!note) return null;
    db.prepare(`DELETE FROM notes WHERE id = ?`).run(note.id);
    deleteNoteFts(note.id);
    reconcileLibraryReferences();
    return note;
  });
  if (!deleted) return res.status(404).json({ error: '回收站中找不到该笔记' });

  const attachment = deleted.attachment_path;
  if (attachment && /^\/uploads\/[a-z0-9][\w.-]*$/i.test(attachment)
    && !db.prepare(`SELECT 1 FROM notes WHERE attachment_path = ? COLLATE NOCASE`).get(attachment)) {
    await fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(attachment))).catch(() => {});
  }
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
  const category = existingCategoryId(categoryId);
  if (categoryId && !category) return res.status(400).json({ error: '分类已不存在，请重新选择' });
  const finalTitle = String(title || '').trim() || '未命名笔记';
  const finalContent = String(content || '');
  const cleanTags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const id = uid();
  const now = nowIso();

  db.prepare(
    `INSERT INTO notes (id, title, content, category_id, tags, source_type, word_count, is_pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, finalTitle, finalContent, category, JSON.stringify(cleanTags), sourceType, countWords(finalContent), now, now);

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
  const compact = req.body?.view === 'compact';
  const skipImageOcr = req.body?.ocrImages === 'false';
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
    // Decode UTF-8 filenames received as Latin-1 while retaining already-decoded Unicode names.
    let originalName = file.originalname;
    if (/^[\x00-\xff]+$/.test(originalName)) {
      try {
        originalName = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(originalName, 'latin1'));
      } catch {
        // Keep valid legacy Latin-1 filenames.
      }
    }

    const attachmentUrl = `/uploads/${file.filename}`;
    try {
      const parsed = await parseUploadedFile(file.path, originalName, file.mimetype, { skipImageOcr });
      if (parsed.warning) warnings.push(`${originalName}: ${parsed.warning}`);

      const id = uid();
      const now = nowIso();
      const isImage = parsed.sourceType === 'image';
      const note = inTransaction(() => {
        const category = existingCategoryId(categoryId);
        if (categoryId && !category) throw new Error('分类已不存在，请重新选择');
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
          category,
          JSON.stringify(extraTags),
          parsed.sourceType,
          originalName,
          attachmentUrl,
          countWords(parsed.content),
          now,
          now
        );
        syncNoteFts(id, parsed.title, parsed.content, extraTags);
        logStudyActivity('note_import', id);
        if (compact) return { id, title: parsed.title, category_id: category, source_filename: originalName };
        return formatNote(getNoteRow(id));
      });
      imported.push(note);
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
  return inTransaction(() => {
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
    const existing = current.chat_excerpts.find(({ id }) => id === excerptId);
    if (existing) {
      return existing.content === content ? current : { error: '该摘录编号已有其他内容，请使用新的摘录编号' };
    }
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
  const note = db.prepare(`SELECT * FROM active_notes WHERE id = ?`).get(req.params.id) as any;
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
    const updated = inTransaction(() => {
      const current = getNoteRow(note.id);
      if (!current) return null;
      const studyText = noteStudyText({ ...current, content: ocrText });
      // Clear stale summary_json so outdated error summaries never remain after re-OCR.
      db.prepare(`UPDATE notes SET title = ?, content = ?, summary_json = NULL, word_count = ?, updated_at = ? WHERE id = ?`)
        .run(newTitle, ocrText, countWords(studyText), nextNoteUpdatedAt(String(current.updated_at)), note.id);
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
  const id = req.params.id;
  const body = req.body || {};
  const result = inTransaction(() => {
    const existing = db.prepare(`SELECT * FROM active_notes WHERE id = ?`).get(id) as any;
    if (!existing) return { status: 404, data: { error: '笔记不存在' } };

    const title = body.title !== undefined ? String(body.title).trim() || existing.title : existing.title;
    const content = body.content !== undefined ? String(body.content) : existing.content;
    const categoryId = body.categoryId !== undefined ? existingCategoryId(body.categoryId) : existing.category_id;
    if (body.categoryId && !categoryId) return { status: 400, data: { error: '分类已不存在，请重新选择' } };
    const tags: string[] = body.tags === undefined
      ? JSON.parse(existing.tags || '[]')
      : (Array.isArray(body.tags) ? body.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean) : []);
    const isPinned = body.isPinned !== undefined ? (body.isPinned ? 1 : 0) : existing.is_pinned;
    const now = nextNoteUpdatedAt(existing.updated_at);
    const studyText = noteStudyText({ ...existing, content });

    db.prepare(
      `UPDATE notes SET title = ?, content = ?, category_id = ?, tags = ?, word_count = ?, is_pinned = ?, updated_at = ? WHERE id = ?`
    ).run(title, content, categoryId, JSON.stringify(tags), countWords(studyText), isPinned, now, id);
    syncNoteFts(id, title, studyText, tags);
    return { status: 200, data: formatNote(getNoteRow(id)) };
  });
  res.status(result.status).json(result.data);
});

// Move note to the recycle bin
notesRouter.delete('/:id', (req, res) => {
  if (!setNoteTrashed(req.params.id, true)) return res.status(404).json({ error: '笔记不存在' });
  res.json({ ok: true });
});

// AI Summarize Single Note + Extract Concepts into Knowledge Graph
notesRouter.post('/:id/summarize', async (req, res) => {
  const note = db.prepare(`SELECT * FROM active_notes WHERE id = ?`).get(req.params.id) as any;
  if (!note) return res.status(404).json({ error: '笔记不存在' });

  const applyMeta = req.body?.applyMeta !== false;
  const cats = db.prepare(`SELECT id, name FROM categories`).all() as { id: string; name: string }[];

  try {
    const summary = await summarizeNoteAI(
      note.title,
      noteStudyText(note),
      cats.map((c) => c.name)
    );

    const updated = inTransaction(() => {
      const current = db.prepare(`SELECT * FROM active_notes WHERE id = ?`).get(note.id) as typeof note;
      if (!current) return null;
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
          const matched = db.prepare(`SELECT id FROM categories WHERE name = ?`).get(summary.suggestedCategory) as { id: string } | undefined;
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

      db.prepare(`UPDATE notes SET summary_json = ?, category_id = ?, tags = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(summary),
        categoryId,
        JSON.stringify(tags),
        nextNoteUpdatedAt(current.updated_at),
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
      return getNoteRow(note.id);
    });
    if (!updated) return res.status(404).json({ error: '笔记不存在' });

    res.json(formatNote(updated));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'AI 总结失败' });
  }
});

// AI Cross-Note Synthesis (多篇笔记归纳)
notesRouter.post('/synthesize', async (req, res) => {
  const { noteIds = [], title, categoryId = null } = req.body || {};
  let targetNotes: any[] = [];

  const requested = readIds(noteIds);
  if (requested.length > 0) {
    targetNotes = db.prepare(`SELECT * FROM active_notes WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(requested));
  } else if (categoryId) {
    targetNotes = db.prepare(`SELECT * FROM active_notes WHERE category_id = ? ORDER BY updated_at DESC LIMIT 10`).all(categoryId) as any[];
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
    const sourceIds = targetNotes.map((note) => note.id);
    const synId = uid();
    const synTitle =
      String(title || '').trim() ||
      (targetNotes.length === 1 ? `《${targetNotes[0].title}》专题归纳` : `专题归纳（${targetNotes.length} 篇笔记）`);
    const now = nowIso();

    const synthesis = inTransaction(() => {
      if (existingNoteIds(sourceIds).length !== sourceIds.length) return null;
      const category = existingCategoryId(categoryId);
      db.prepare(
        `INSERT INTO syntheses (id, title, note_ids, category_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(synId, synTitle, JSON.stringify(sourceIds), category, markdown, now);
      logStudyActivity('note_summary', synId);
      return { id: synId, title: synTitle, note_ids: sourceIds, category_id: category, content: markdown, created_at: now };
    });
    if (!synthesis) return res.status(409).json({ error: '归纳期间有来源笔记被删除，请重新选择' });

    res.status(201).json(synthesis);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '多篇笔记归纳失败' });
  }
});
