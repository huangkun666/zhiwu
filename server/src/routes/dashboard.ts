import { Router } from 'express';
import { db, nowIso, todayKey } from '../db.js';
import { seedSampleData } from '../services/seed.js';
import { splitStudyConcepts, type StudyConcept, type TodayProgress } from '../shared/todayLearning.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', (_req, res) => {
  const now = nowIso();
  const today = todayKey();

  const totalNotes = (db.prepare(`SELECT COUNT(*) as c FROM active_notes`).get() as any).c;
  const summarizedNotes = (db.prepare(`SELECT COUNT(*) as c FROM active_notes WHERE summary_json IS NOT NULL`).get() as any).c;
  const totalFlashcards = (db.prepare(`SELECT COUNT(*) as c FROM flashcards`).get() as any).c;
  const dueFlashcards = (
    db.prepare(`SELECT COUNT(*) as c FROM flashcards WHERE next_review_at <= ?`).get(now) as any
  ).c;
  const totalMistakes = (db.prepare(`SELECT COUNT(*) as c FROM mistakes`).get() as any).c;
  const activeMistakes = (
    db.prepare(`SELECT COUNT(*) as c FROM mistakes WHERE status != 'mastered'`).get() as any
  ).c;
  const dueMistakes = (
    db.prepare(`SELECT COUNT(*) as c FROM mistakes WHERE status != 'mastered' AND next_review_at <= ?`).get(now) as any
  ).c;
  const totalQuizzes = (db.prepare(`SELECT COUNT(*) as c FROM quizzes WHERE status = 'completed'`).get() as any).c;
  const avgScoreRow = db
    .prepare(`SELECT AVG(score) as avg_score FROM quizzes WHERE status = 'completed' AND score IS NOT NULL`)
    .get() as { avg_score: number | null };

  const todayActions = (
    db.prepare(`SELECT COUNT(*) as c FROM study_logs WHERE date_key = ?`).get(today) as any
  ).c;
  const completedToday = db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN activity_type = 'flashcard_review' THEN COALESCE(entity_id,id) END) AS reviewedCards,
      COUNT(DISTINCT CASE WHEN activity_type = 'mistake_review' THEN COALESCE(entity_id,id) END) AS reviewedMistakes,
      COUNT(DISTINCT CASE WHEN activity_type = 'quiz_complete' THEN COALESCE(entity_id,id) END) AS quizzesCompleted
    FROM study_logs WHERE date_key = ?`).get(today) as Omit<TodayProgress, 'nextReviewAt'>;
  const { nextReviewAt } = db.prepare(`SELECT MIN(next_review_at) AS nextReviewAt FROM (
    SELECT next_review_at FROM flashcards WHERE next_review_at > ?
    UNION ALL SELECT next_review_at FROM mistakes WHERE status != 'mastered' AND next_review_at > ?
  )`).get(now, now) as Pick<TodayProgress, 'nextReviewAt'>;

  // Heatmap for past 112 days (16 weeks)
  const heatmapRows = db
    .prepare(
      `SELECT date_key, COUNT(*) as count
       FROM study_logs
       WHERE date_key >= date('now', '-112 days', 'localtime')
       GROUP BY date_key`
    )
    .all() as { date_key: string; count: number }[];

  const heatmapMap: Record<string, number> = {};
  for (const r of heatmapRows) heatmapMap[r.date_key] = r.count;

  const heatmap: { date: string; count: number }[] = [];
  for (let i = 111; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const dk = todayKey(d);
    heatmap.push({ date: dk, count: heatmapMap[dk] || 0 });
  }

  // Compute current study streak
  let streak = 0;
  for (let i = 0; i < 112; i++) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const dk = todayKey(d);
    if ((heatmapMap[dk] || 0) > 0) {
      streak++;
    } else if (i > 0) {
      break;
    }
  }

  // Quiz trends are historical study events and can be restored from a backup.
  const quizTrend = db
    .prepare(
      `SELECT date_key as date, ROUND(AVG(score) * 100, 1) as accuracy
       FROM study_logs
       WHERE activity_type = 'quiz_complete' AND score IS NOT NULL
       GROUP BY date_key
       ORDER BY date_key DESC
       LIMIT 10`
    )
    .all()
    .reverse();

  // Subject mastery breakdown
  const subjectMastery = db
    .prepare(
      `WITH note_counts AS (
        SELECT category_id, COUNT(*) AS note_count FROM active_notes GROUP BY category_id
       ), category_concepts AS (
        SELECT DISTINCT n.category_id, nc.concept_id FROM note_concepts nc INNER JOIN active_notes n ON n.id = nc.note_id
       ), scores AS (
        SELECT cc.category_id, ROUND(AVG(CASE WHEN c.quiz_attempts > 0 THEN c.mastery_score END) * 100) AS mastery,
          COUNT(*) AS concept_count, COUNT(CASE WHEN c.quiz_attempts > 0 THEN 1 END) AS tested_count
        FROM category_concepts cc INNER JOIN concepts c ON c.id = cc.concept_id GROUP BY cc.category_id
       )
       SELECT cat.id, cat.name, cat.color, counts.note_count, scores.mastery,
         COALESCE(scores.concept_count, 0) AS concept_count, COALESCE(scores.tested_count, 0) AS tested_count
       FROM categories cat INNER JOIN note_counts counts ON counts.category_id = cat.id
       LEFT JOIN scores ON scores.category_id = cat.id
       ORDER BY counts.note_count DESC, cat.created_at ASC`
    )
    .all();

  const concepts = db
    .prepare(
      `SELECT id, name, mastery_score, quiz_attempts, quiz_correct
       FROM active_concepts
       ORDER BY created_at DESC, id ASC`
    )
    .all() as unknown as StudyConcept[];

  // Recent notes
  const recentNotes = db
    .prepare(
      `SELECT n.id, n.title, n.source_type, n.updated_at, n.summary_json IS NOT NULL as has_summary,
              c.name as category_name, c.color as category_color
       FROM active_notes n
       LEFT JOIN categories c ON n.category_id = c.id
       ORDER BY n.updated_at DESC
       LIMIT 5`
    )
    .all();

  res.json({
    stats: {
      totalNotes,
      summarizedNotes,
      totalFlashcards,
      dueFlashcards,
      totalMistakes,
      activeMistakes,
      dueMistakes,
      totalDueReviews: dueFlashcards + dueMistakes,
      totalQuizzes,
      avgAccuracy: avgScoreRow?.avg_score !== null && avgScoreRow?.avg_score !== undefined ? Math.round(avgScoreRow.avg_score * 100) : null,
      todayActions,
      streak,
    },
    heatmap,
    quizTrend,
    subjectMastery,
    ...splitStudyConcepts(concepts),
    todayProgress: { ...completedToday, nextReviewAt },
    recentNotes,
  });
});

// Load optional sample Chinese learning dataset
dashboardRouter.post('/seed', (_req, res) => {
  const existingCount = (db.prepare(`SELECT COUNT(*) as c FROM notes`).get() as any).c;
  if (existingCount > 0) {
    return res.status(400).json({ error: '当前笔记库已有内容，为避免覆盖现有数据，仅支持在空库时加载示例数据。' });
  }
  const result = seedSampleData();
  res.json({ ok: true, ...result });
});
