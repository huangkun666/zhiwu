import { Router } from 'express';
import { db, existingCategoryId, existingNoteIds, inTransaction, logStudyActivity, nowIso, uid, updateConceptMastery } from '../db.js';
import { generateFlashcardsAI } from '../services/ai.js';
import { computeSM2, previewSM2Intervals } from '../services/sm2.js';
import { noteStudyText } from '../shared/noteContent.js';

export const flashcardsRouter = Router();

const cardSelect = `SELECT f.*, n.id AS active_note_id, n.title AS note_title
  FROM flashcards f LEFT JOIN active_notes n ON f.note_id = n.id`;

function formatCard(row: any) {
  const { active_note_id, ...card } = row;
  return {
    ...card,
    note_id: active_note_id,
    interval_previews: previewSM2Intervals({
      easeFactor: row.ease_factor,
      intervalDays: row.interval_days,
      repetitions: row.repetitions,
    }),
  };
}

function getCard(id: string) {
  return formatCard(db.prepare(`${cardSelect} WHERE f.id = ?`).get(id));
}

// List flashcards
flashcardsRouter.get('/', (req, res) => {
  const noteId = String(req.query.noteId || '').trim();
  const dueOnly = req.query.dueOnly === 'true';
  const conds: string[] = [];
  const params: any[] = [];

  if (noteId) {
    conds.push(`n.id = ?`);
    params.push(noteId);
  }
  if (dueOnly) {
    conds.push(`f.next_review_at <= ?`);
    params.push(nowIso());
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `${cardSelect} ${where}
       ORDER BY f.next_review_at ASC`
    )
    .all(...params);
  res.json(rows.map(formatCard));
});

// Unified daily spaced repetition queue (Flashcards + Mistakes)
flashcardsRouter.get('/queue', (_req, res) => {
  const now = nowIso();
  const dueCards = db
    .prepare(
      `${cardSelect} WHERE f.next_review_at <= ?
       ORDER BY f.next_review_at ASC
       LIMIT 40`
    )
    .all(now)
    .map((r: any) => ({ itemType: 'flashcard' as const, ...formatCard(r) }));

  const dueMistakes = db
    .prepare(
      `SELECT m.*, n.id AS active_note_id, n.title AS note_title
       FROM mistakes m
       LEFT JOIN active_notes n ON m.note_id = n.id
       WHERE m.status != 'mastered' AND m.next_review_at <= ?
       ORDER BY m.next_review_at ASC
       LIMIT 30`
    )
    .all(now)
    .map(({ active_note_id, ...r }: any) => ({
      itemType: 'mistake' as const,
      ...r,
      note_id: active_note_id,
      options: JSON.parse(r.options_json || '[]'),
      interval_previews: previewSM2Intervals({
        easeFactor: r.ease_factor,
        intervalDays: r.interval_days,
        repetitions: r.repetitions,
      }),
    }));

  res.json({
    totalDue: dueCards.length + dueMistakes.length,
    dueCardsCount: dueCards.length,
    dueMistakesCount: dueMistakes.length,
    items: [...dueMistakes, ...dueCards],
  });
});

// Create manual flashcard
flashcardsRouter.post('/', (req, res) => {
  const { front, back, hint = '', noteId = null, categoryId = null, conceptName = '' } = req.body || {};
  if (!front?.trim() || !back?.trim()) {
    return res.status(400).json({ error: '闪卡正面与背面均不能为空' });
  }
  const [sourceId] = existingNoteIds([noteId]);
  if (noteId && !sourceId) return res.status(400).json({ error: '来源笔记已不存在' });
  const category = existingCategoryId(categoryId);
  if (categoryId && !category) return res.status(400).json({ error: '分类已不存在' });
  const id = uid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO flashcards (id, note_id, category_id, concept_name, front, back, hint, next_review_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sourceId || null, category, conceptName, front.trim(), back.trim(), hint, now, now, now);

  res.status(201).json(getCard(id));
});

// Generate flashcards from a note via AI
flashcardsRouter.post('/generate', async (req, res) => {
  const { noteId, count = 6 } = req.body || {};
  const note = db.prepare(`SELECT * FROM active_notes WHERE id = ?`).get(noteId) as any;
  if (!note) return res.status(404).json({ error: '笔记不存在' });

  try {
    const cards = await generateFlashcardsAI(note.title, noteStudyText(note), Math.max(2, Math.min(12, Number(count) || 6)));
    const created = inTransaction(() => {
      const current = db.prepare(`SELECT id, category_id FROM active_notes WHERE id = ?`).get(note.id) as
        { id: string; category_id: string | null } | undefined;
      if (!current) return null;
      const now = nowIso();
      const insert = db.prepare(
        `INSERT INTO flashcards (id, note_id, category_id, concept_name, front, back, hint, next_review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      return cards.map((c) => {
        const id = uid();
        insert.run(id, current.id, current.category_id, c.conceptName, c.front, c.back, c.hint, now, now, now);
        return getCard(id);
      });
    });
    if (!created) return res.status(409).json({ error: '来源笔记已被删除' });
    res.status(201).json({ count: created.length, cards: created });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '生成闪卡失败' });
  }
});

// SM-2 Review rating for a flashcard
flashcardsRouter.post('/:id/review', (req, res) => {
  const card = db.prepare(`SELECT * FROM flashcards WHERE id = ?`).get(req.params.id) as any;
  if (!card) return res.status(404).json({ error: '闪卡不存在' });

  const rating = Number(req.body?.rating) as 1 | 2 | 3 | 4;
  if (![1, 2, 3, 4].includes(rating)) {
    return res.status(400).json({ error: '评分必须为 1-4' });
  }

  const next = computeSM2(
    {
      easeFactor: card.ease_factor,
      intervalDays: card.interval_days,
      repetitions: card.repetitions,
    },
    rating
  );

  const now = nowIso();
  db.prepare(
    `UPDATE flashcards
     SET ease_factor = ?, interval_days = ?, repetitions = ?, next_review_at = ?, last_reviewed_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(next.easeFactor, next.intervalDays, next.repetitions, next.nextReviewAt, now, now, card.id);

  const masteryChange = card.concept_name ? updateConceptMastery(card.concept_name, rating >= 3, card.note_id) : undefined;
  logStudyActivity('flashcard_review', card.id, rating >= 3 ? 1 : 0, 20);

  res.json({
    card: getCard(card.id),
    nextLabel: next.label,
    masteryChange,
  });
});

flashcardsRouter.put('/:id', (req, res) => {
  const card = db.prepare(`SELECT * FROM flashcards WHERE id = ?`).get(req.params.id) as any;
  if (!card) return res.status(404).json({ error: '闪卡不存在' });
  db.prepare(`UPDATE flashcards SET front = ?, back = ?, hint = ?, updated_at = ? WHERE id = ?`).run(
    req.body.front ?? card.front,
    req.body.back ?? card.back,
    req.body.hint ?? card.hint,
    nowIso(),
    card.id
  );
  res.json(getCard(card.id));
});

flashcardsRouter.delete('/:id', (req, res) => {
  db.prepare(`DELETE FROM flashcards WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});
