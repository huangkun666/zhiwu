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
import { callVisionOCR, summarizeNoteAI, synthesizeNotesAI } from '../services/ai.js';

export const notesRouter = Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
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
    is_pinned: Boolean(row.is_pinned),
  };
}

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
    const safeFts = q.replace(/["'*():^]/g, ' ').trim();
    if (safeFts) {
      conditions.push(
        `(n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?) OR n.title LIKE ? OR n.content LIKE ? OR n.tags LIKE ?)`
      );
      params.push(`"${safeFts}"`, likeTerm, likeTerm, likeTerm);
    } else {
      conditions.push(`(n.title LIKE ? OR n.content LIKE ? OR n.tags LIKE ?)`);
      params.push(likeTerm, likeTerm, likeTerm);
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
         WHERE n.title LIKE ? OR n.content LIKE ? OR n.tags LIKE ?
         ORDER BY n.is_pinned DESC, n.updated_at DESC`
      )
      .all(likeTerm, likeTerm, likeTerm);
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
  const row = db
    .prepare(
      `SELECT n.*, c.name as category_name, c.color as category_color
       FROM notes n LEFT JOIN categories c ON n.category_id = c.id
       WHERE n.id = ?`
    )
    .get(req.params.id);
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

  const created = db
    .prepare(`SELECT n.*, c.name as category_name, c.color as category_color FROM notes n LEFT JOIN categories c ON n.category_id = c.id WHERE n.id = ?`)
    .get(id);
  res.status(201).json(formatNote(created));
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
      const parsed = await parseUploadedFile(file.path, originalName, file.mimetype, attachmentUrl);
      if (parsed.warning) warnings.push(`${originalName}: ${parsed.warning}`);

      const id = uid();
      const now = nowIso();
      const keepAttachment = parsed.sourceType === 'pdf' || parsed.sourceType === 'image' || parsed.sourceType === 'docx';
      if (!keepAttachment) {
        fs.unlink(file.path, () => {});
      }

      db.prepare(
        `INSERT INTO notes (
          id, title, content, category_id, tags, source_type, source_filename, attachment_path, word_count, is_pinned, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        id,
        parsed.title,
        parsed.content,
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

      const row = db
        .prepare(`SELECT n.*, c.name as category_name, c.color as category_color FROM notes n LEFT JOIN categories c ON n.category_id = c.id WHERE n.id = ?`)
        .get(id);
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

// Re-run Vision OCR on an image note
notesRouter.post('/:id/ocr', async (req, res) => {
  const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(req.params.id) as any;
  if (!note) return res.status(404).json({ error: '笔记不存在' });
  if (!note.attachment_path) return res.status(400).json({ error: '该笔记没有关联图片附件' });

  const fileName = path.basename(note.attachment_path);
  const fullPath = path.join(UPLOADS_DIR, fileName);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '原始图片文件已不存在' });

  try {
    const ext = path.extname(fullPath).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const base64 = fs.readFileSync(fullPath).toString('base64');
    const ocrText = await callVisionOCR(base64, mime);
    const newContent = `![原始笔记图片](${note.attachment_path})\n\n---\n\n${ocrText}`;
    const now = nowIso();
    db.prepare(`UPDATE notes SET content = ?, word_count = ?, updated_at = ? WHERE id = ?`).run(
      newContent,
      countWords(newContent),
      now,
      note.id
    );
    const tags = JSON.parse(note.tags || '[]');
    syncNoteFts(note.id, note.title, newContent, tags);

    const updated = db
      .prepare(`SELECT n.*, c.name as category_name, c.color as category_color FROM notes n LEFT JOIN categories c ON n.category_id = c.id WHERE n.id = ?`)
      .get(note.id);
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
  const now = nowIso();

  db.prepare(
    `UPDATE notes SET title = ?, content = ?, category_id = ?, tags = ?, word_count = ?, is_pinned = ?, updated_at = ? WHERE id = ?`
  ).run(title, content, categoryId, JSON.stringify(tags), countWords(content), isPinned, now, existing.id);

  syncNoteFts(existing.id, title, content, tags);

  const updated = db
    .prepare(`SELECT n.*, c.name as category_name, c.color as category_color FROM notes n LEFT JOIN categories c ON n.category_id = c.id WHERE n.id = ?`)
    .get(existing.id);
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
      note.content,
      cats.map((c) => c.name)
    );

    let categoryId = note.category_id;
    let tags: string[] = JSON.parse(note.tags || '[]');

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
    syncNoteFts(note.id, note.title, note.content, tags);

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
        content: n.content,
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
