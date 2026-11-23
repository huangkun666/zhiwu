import { Router } from 'express';
import { db, logStudyActivity, nowIso, uid, updateConceptMastery } from '../db.js';
import { diagnoseMistakeAI, generateVariantQuestionAI } from '../services/ai.js';
import { computeSM2, previewSM2Intervals } from '../services/sm2.js';
import { noteStudyText } from '../shared/noteContent.js';

export const mistakesRouter = Router();

const mistakeSelect = `SELECT m.*, n.id AS active_note_id, n.title AS note_title
  FROM mistakes m LEFT JOIN active_notes n ON m.note_id = n.id`;

function formatMistake(row: any) {
  const { active_note_id, ...mistake } = row;
  const options = JSON.parse(row.options_json || '[]');
  return {
    ...mistake,
    note_id: active_note_id,
    options,
    interval_previews: previewSM2Intervals({
      easeFactor: row.ease_factor,
      intervalDays: row.interval_days,
      repetitions: row.repetitions,
    }),
  };
}

function getMistake(id: string) {
  return formatMistake(db.prepare(`${mistakeSelect} WHERE m.id = ?`).get(id));
}

// List mistakes with optional status / concept filter
mistakesRouter.get('/', (req, res) => {
  const status = String(req.query.status || '').trim();
  const concept = String(req.query.concept || '').trim();
  const dueOnly = req.query.dueOnly === 'true';

  const conds: string[] = [];
  const params: any[] = [];

  if (status && status !== 'all') {
    conds.push(`m.status = ?`);
    params.push(status);
  }
  if (concept) {
    conds.push(`m.concept_name LIKE ?`);
    params.push(`%${concept}%`);
  }
  if (dueOnly) {
    conds.push(`m.status != 'mastered' AND m.next_review_at <= ?`);
    params.push(nowIso());
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `${mistakeSelect} ${where}
       ORDER BY m.status ASC, m.next_review_at ASC`
    )
    .all(...params);

  res.json(rows.map(formatMistake));
});

// Manually bookmark a quiz question into Mistake Notebook
mistakesRouter.post('/bookmark', (req, res) => {
  const { questionId } = req.body || {};
  const q = db.prepare(`SELECT * FROM quiz_questions WHERE id = ?`).get(questionId) as any;
  if (!q) return res.status(404).json({ error: '题目不存在' });

  const existing = db.prepare(`${mistakeSelect} WHERE m.question_id = ?`).get(questionId);
  if (existing) return res.json(formatMistake(existing));

  const id = uid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO mistakes (
      id, question_id, note_id, concept_name, type, stem, options_json,
      correct_answer, wrong_answer, explanation, status, wrong_count, next_review_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reviewing', 1, ?, ?, ?)`
  ).run(
    id,
    q.id,
    q.note_id || null,
    q.concept_name || '收藏题目',
    q.type,
    q.stem,
    q.options_json || '[]',
    q.correct_answer,
    q.user_answer || '手动收藏',
    q.explanation || '',
    now,
    now,
    now
  );
  res.status(201).json(getMistake(id));
});

// Update reflection or status
mistakesRouter.put('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM mistakes WHERE id = ?`).get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: '错题不存在' });

  const userReflection = req.body.userReflection !== undefined ? String(req.body.userReflection) : existing.user_reflection;
  const status = req.body.status !== undefined ? String(req.body.status) : existing.status;

  db.prepare(`UPDATE mistakes SET user_reflection = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    userReflection,
    status,
    nowIso(),
    existing.id
  );
  res.json(getMistake(existing.id));
});

// Deep AI Diagnosis for a mistake
mistakesRouter.post('/:id/diagnose', async (req, res) => {
  const m = db.prepare(`SELECT * FROM mistakes WHERE id = ?`).get(req.params.id) as any;
  if (!m) return res.status(404).json({ error: '错题不存在' });

  let noteExcerpt = '';
  if (m.note_id) {
    const note = db.prepare(`SELECT content, source_content, chat_excerpts FROM active_notes WHERE id = ?`).get(m.note_id) as
      Parameters<typeof noteStudyText>[0] | undefined;
    if (note) noteExcerpt = noteStudyText(note);
  }

  try {
    const diagnosis = await diagnoseMistakeAI({
      stem: m.stem,
      options: JSON.parse(m.options_json || '[]'),
      correctAnswer: m.correct_answer,
      wrongAnswer: m.wrong_answer,
      conceptName: m.concept_name,
      noteExcerpt,
    });
    db.prepare(`UPDATE mistakes SET ai_diagnosis = ?, updated_at = ? WHERE id = ?`).run(diagnosis, nowIso(), m.id);
    res.json(getMistake(m.id));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'AI 错题深度剖析失败' });
  }
});

// Generate a similar variant question (举一反三同类变式题)
mistakesRouter.post('/:id/variant', async (req, res) => {
  const m = db.prepare(`SELECT * FROM mistakes WHERE id = ?`).get(req.params.id) as any;
  if (!m) return res.status(404).json({ error: '错题不存在' });

  try {
    const variant = await generateVariantQuestionAI({
      type: m.type,
      stem: m.stem,
      correctAnswer: m.correct_answer,
      conceptName: m.concept_name,
      explanation: m.explanation,
    });
    res.json(variant);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '生成变式题失败' });
  }
});

// SM-2 Review rating for a mistake
mistakesRouter.post('/:id/review', (req, res) => {
  const m = db.prepare(`SELECT * FROM mistakes WHERE id = ?`).get(req.params.id) as any;
  if (!m) return res.status(404).json({ error: '错题不存在' });

  const rating = Number(req.body?.rating) as 1 | 2 | 3 | 4;
  if (![1, 2, 3, 4].includes(rating)) {
    return res.status(400).json({ error: '评分必须为 1-4' });
  }

  const next = computeSM2(
    {
      easeFactor: m.ease_factor,
      intervalDays: m.interval_days,
      repetitions: m.repetitions,
    },
    rating
  );

  let nextStatus = m.status;
  if (rating === 1) nextStatus = 'unmastered';
  else if (rating === 4 || next.repetitions >= 3) nextStatus = 'mastered';
  else nextStatus = 'reviewing';

  const now = nowIso();
  db.prepare(
    `UPDATE mistakes
     SET ease_factor = ?, interval_days = ?, repetitions = ?, next_review_at = ?, last_reviewed_at = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(next.easeFactor, next.intervalDays, next.repetitions, next.nextReviewAt, now, nextStatus, now, m.id);

  if (m.concept_name) {
    updateConceptMastery(m.concept_name, rating >= 3, m.note_id);
  }
  logStudyActivity('mistake_review', m.id, rating >= 3 ? 1 : 0, 30);

  res.json({
    mistake: getMistake(m.id),
    nextLabel: next.label,
  });
});

mistakesRouter.delete('/:id', (req, res) => {
  db.prepare(`DELETE FROM mistakes WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});
