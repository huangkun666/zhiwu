import { Router } from 'express';
import { db, logStudyActivity, nowIso, uid, updateConceptMastery } from '../db.js';
import { generateQuizAI, gradeShortAnswerAI } from '../services/ai.js';
import { noteStudyText } from '../shared/noteContent.js';

export const quizzesRouter = Router();

function formatQuestion(q: any) {
  return {
    ...q,
    options: JSON.parse(q.options_json || '[]'),
    is_correct: q.is_correct === null ? null : Boolean(q.is_correct),
  };
}

// List quiz history
quizzesRouter.get('/', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM quizzes ORDER BY created_at DESC LIMIT 50`).all() as any[];
  res.json(
    rows.map((r) => ({
      ...r,
      source_note_ids: JSON.parse(r.source_note_ids || '[]'),
    }))
  );
});

// Get single quiz with questions
quizzesRouter.get('/:id', (req, res) => {
  const quiz = db.prepare(`SELECT * FROM quizzes WHERE id = ?`).get(req.params.id) as any;
  if (!quiz) return res.status(404).json({ error: '测验不存在' });
  const questions = db.prepare(`SELECT * FROM quiz_questions WHERE quiz_id = ?`).all(quiz.id) as any[];
  res.json({
    ...quiz,
    source_note_ids: JSON.parse(quiz.source_note_ids || '[]'),
    questions: questions.map(formatQuestion),
  });
});

// Generate a dynamic quiz from notes / category / weak concepts
quizzesRouter.post('/generate', async (req, res) => {
  const {
    noteIds = [],
    categoryId = null,
    weakOnly = false,
    focusConcepts = [],
    count = 5,
    difficulty = 'medium',
    types = ['single', 'multiple', 'boolean', 'short'],
    title,
  } = req.body || {};

  let sourceNotes: any[] = [];
  let targetConcepts: string[] = Array.isArray(focusConcepts) ? focusConcepts : [];

  if (weakOnly) {
    const weakRows = db
      .prepare(`SELECT id, name FROM concepts ORDER BY mastery_score ASC, quiz_attempts DESC LIMIT 6`)
      .all() as { id: string; name: string }[];
    if (targetConcepts.length === 0) {
      targetConcepts = weakRows.map((w) => w.name);
    }
    if (weakRows.length > 0) {
      const ph = weakRows.map(() => '?').join(',');
      sourceNotes = db
        .prepare(
          `SELECT DISTINCT n.* FROM notes n
           INNER JOIN note_concepts nc ON nc.note_id = n.id
           WHERE nc.concept_id IN (${ph})
           LIMIT 6`
        )
        .all(...weakRows.map((w) => w.id)) as any[];
    }
  }

  if (sourceNotes.length === 0 && Array.isArray(noteIds) && noteIds.length > 0) {
    const ph = noteIds.map(() => '?').join(',');
    sourceNotes = db.prepare(`SELECT * FROM notes WHERE id IN (${ph})`).all(...noteIds) as any[];
  } else if (sourceNotes.length === 0 && categoryId) {
    sourceNotes = db
      .prepare(`SELECT * FROM notes WHERE category_id = ? ORDER BY updated_at DESC LIMIT 6`)
      .all(categoryId) as any[];
  } else if (sourceNotes.length === 0) {
    sourceNotes = db.prepare(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT 5`).all() as any[];
  }

  if (sourceNotes.length === 0) {
    return res.status(400).json({ error: '笔记库中暂无可用笔记，请先导入或创建至少一篇笔记。' });
  }

  const safeCount = Math.max(1, Math.min(15, Number(count) || 5));
  const safeTypes =
    Array.isArray(types) && types.length > 0 ? types : (['single', 'boolean', 'short'] as const);

  try {
    const generated = await generateQuizAI(
      sourceNotes.map((n) => ({ id: n.id, title: n.title, content: noteStudyText(n) })),
      {
        count: safeCount,
        difficulty: ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium',
        types: safeTypes as any,
        focusConcepts: targetConcepts,
      }
    );

    if (generated.length === 0) {
      return res.status(500).json({ error: 'AI 未能生成有效题目，请重试。' });
    }

    const quizId = uid();
    const now = nowIso();
    const quizTitle =
      String(title || '').trim() ||
      (weakOnly
        ? `薄弱项专项突破测验（${generated.length} 题）`
        : sourceNotes.length === 1
        ? `《${sourceNotes[0].title}》动态测验`
        : `综合动态测验（${sourceNotes.length} 篇笔记）`);

    db.prepare(
      `INSERT INTO quizzes (id, title, source_note_ids, category_id, difficulty, total_questions, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?)`
    ).run(quizId, quizTitle, JSON.stringify(sourceNotes.map((n) => n.id)), categoryId || null, difficulty, generated.length, now);

    const savedQuestions: any[] = [];
    for (const q of generated) {
      const qid = uid();
      db.prepare(
        `INSERT INTO quiz_questions (
          id, quiz_id, note_id, concept_name, type, stem, options_json, correct_answer, explanation, memory_tip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        qid,
        quizId,
        q.noteId || sourceNotes[0].id,
        q.conceptName,
        q.type,
        q.stem,
        JSON.stringify(q.options),
        q.correctAnswer,
        q.explanation,
        q.memoryTip
      );
      savedQuestions.push(
        formatQuestion(db.prepare(`SELECT * FROM quiz_questions WHERE id = ?`).get(qid))
      );
    }

    res.status(201).json({
      id: quizId,
      title: quizTitle,
      source_note_ids: sourceNotes.map((n) => n.id),
      difficulty,
      total_questions: generated.length,
      status: 'in_progress',
      created_at: now,
      questions: savedQuestions,
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '动态出题失败' });
  }
});

function normalizeChoiceAnswer(ans: string): string {
  return ans
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .split('')
    .sort()
    .join(',');
}

// Submit answers & grade (auto-adds wrong questions to Mistake Notebook!)
quizzesRouter.post('/:id/submit', async (req, res) => {
  const quiz = db.prepare(`SELECT * FROM quizzes WHERE id = ?`).get(req.params.id) as any;
  if (!quiz) return res.status(404).json({ error: '测验不存在' });

  const answers: Record<string, string> = req.body?.answers || {};
  const questions = db.prepare(`SELECT * FROM quiz_questions WHERE quiz_id = ?`).all(quiz.id) as any[];

  let totalScore = 0;
  let mistakesAdded = 0;
  const now = nowIso();

  for (const q of questions) {
    const userAnswer = String(answers[q.id] ?? '').trim();
    let isCorrect = false;
    let score = 0;
    let feedback = '';

    if (q.type === 'single' || q.type === 'multiple') {
      const normUser = normalizeChoiceAnswer(userAnswer);
      const normCorrect = normalizeChoiceAnswer(String(q.correct_answer));
      isCorrect = normUser !== '' && normUser === normCorrect;
      score = isCorrect ? 1 : 0;
    } else if (q.type === 'boolean') {
      const mapBool = (s: string) => {
        const lower = s.trim().toLowerCase();
        if (['对', '正确', 'true', 't', 'yes', '√'].includes(lower)) return '对';
        if (['错', '错误', 'false', 'f', 'no', '×'].includes(lower)) return '错';
        return lower;
      };
      isCorrect = mapBool(userAnswer) === mapBool(String(q.correct_answer));
      score = isCorrect ? 1 : 0;
    } else {
      // Short answer: AI grading with graceful fallback
      try {
        const graded = await gradeShortAnswerAI(q.stem, q.correct_answer, userAnswer);
        score = graded.score;
        isCorrect = graded.isCorrect;
        feedback = graded.feedback;
      } catch {
        // Fallback if AI offline
        isCorrect = userAnswer.length >= 6 && userAnswer.toLowerCase().includes(String(q.correct_answer).slice(0, 4).toLowerCase());
        score = isCorrect ? 1 : 0;
        feedback = '已记录作答，请对照参考答案自评关键要点。';
      }
    }

    totalScore += score;

    db.prepare(
      `UPDATE quiz_questions SET user_answer = ?, is_correct = ?, ai_feedback = ?, score = ? WHERE id = ?`
    ).run(userAnswer, isCorrect ? 1 : 0, feedback, score, q.id);

    // Update concept mastery in Knowledge Graph
    if (q.concept_name) {
      updateConceptMastery(q.concept_name, isCorrect, quiz.category_id || null);
    }

    // Automatically add wrong answers to Mistake Notebook
    if (!isCorrect) {
      const existingMistake = db
        .prepare(`SELECT id, wrong_count FROM mistakes WHERE question_id = ?`)
        .get(q.id) as { id: string; wrong_count: number } | undefined;

      if (existingMistake) {
        db.prepare(
          `UPDATE mistakes SET wrong_answer = ?, wrong_count = ?, status = 'unmastered', next_review_at = ?, updated_at = ? WHERE id = ?`
        ).run(userAnswer || '未作答', existingMistake.wrong_count + 1, now, now, existingMistake.id);
      } else {
        db.prepare(
          `INSERT INTO mistakes (
            id, question_id, note_id, concept_name, type, stem, options_json,
            correct_answer, wrong_answer, explanation, ai_diagnosis, status,
            wrong_count, next_review_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unmastered', 1, ?, ?, ?)`
        ).run(
          uid(),
          q.id,
          q.note_id || null,
          q.concept_name || '综合知识',
          q.type,
          q.stem,
          q.options_json || '[]',
          q.correct_answer,
          userAnswer || '未作答',
          q.explanation || '',
          feedback || '',
          now,
          now,
          now
        );
        mistakesAdded++;
      }
    }
  }

  const finalScore = questions.length > 0 ? Number((totalScore / questions.length).toFixed(3)) : 0;
  db.prepare(`UPDATE quizzes SET score = ?, status = 'completed', completed_at = ? WHERE id = ?`).run(
    finalScore,
    now,
    quiz.id
  );
  logStudyActivity('quiz_complete', quiz.id, finalScore, questions.length * 45);

  const updatedQuestions = db.prepare(`SELECT * FROM quiz_questions WHERE quiz_id = ?`).all(quiz.id) as any[];
  res.json({
    ...quiz,
    score: finalScore,
    status: 'completed',
    completed_at: now,
    mistakesAdded,
    questions: updatedQuestions.map(formatQuestion),
  });
});

quizzesRouter.delete('/:id', (req, res) => {
  db.prepare(`DELETE FROM quizzes WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});
