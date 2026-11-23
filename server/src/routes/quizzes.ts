import { Router } from 'express';
import { db, existingCategoryId, existingNoteIds, inTransaction, logStudyActivity, nowIso, reconcileLibraryReferences, uid, updateConceptMastery } from '../db.js';
import { generateQuizAI, gradeShortAnswerAI } from '../services/ai.js';
import { questionSourceId, readIds } from '../shared/libraryReferences.js';
import { noteStudyText } from '../shared/noteContent.js';
import { rankWeakConcepts, recordMasteryChange, type MasteryChange, type StudyConcept } from '../shared/todayLearning.js';

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
      source_note_ids: existingNoteIds(r.source_note_ids),
    }))
  );
});

// Get single quiz with questions
function getQuiz(id: string) {
  const quiz = db.prepare(`SELECT * FROM quizzes WHERE id = ?`).get(id) as any;
  if (!quiz) return null;
  const questions = db.prepare(`SELECT * FROM quiz_questions WHERE quiz_id = ?`).all(quiz.id) as any[];
  return {
    ...quiz,
    source_note_ids: readIds(quiz.source_note_ids),
    questions: questions.map(formatQuestion),
  };
}

function formatQuiz(quiz: NonNullable<ReturnType<typeof getQuiz>>) {
  const questionNoteIds = quiz.questions.map((question: any) => question.note_id);
  const active = new Set(existingNoteIds([...quiz.source_note_ids, ...questionNoteIds]));
  return {
    ...quiz,
    source_note_ids: quiz.source_note_ids.filter((id: string) => active.has(id)),
    questions: quiz.questions.map((question: any) => ({
      ...question,
      note_id: active.has(question.note_id) ? question.note_id : null,
    })),
  };
}

quizzesRouter.get('/:id', (req, res) => {
  const quiz = getQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: '测验不存在' });
  res.json(formatQuiz(quiz));
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
  let targetConcepts = readIds(focusConcepts);
  const requestedNotes = readIds(noteIds);
  let missingSource = '笔记库中暂无可用笔记，请先导入或创建至少一篇笔记。';

  if (weakOnly) {
    const names = JSON.stringify(targetConcepts);
    const matching = db.prepare(`SELECT id, name, quiz_attempts, quiz_correct, mastery_score FROM active_concepts
      WHERE ? = '[]' OR name IN (SELECT value FROM json_each(?))
      ORDER BY mastery_score ASC, quiz_attempts DESC`).all(names, names) as unknown as StudyConcept[];
    const weakRows = (targetConcepts.length > 0 ? matching : rankWeakConcepts(matching)).slice(0, 6);
    targetConcepts = weakRows.map((row) => row.name);
    sourceNotes = db.prepare(`SELECT DISTINCT n.* FROM active_notes n INNER JOIN note_concepts nc ON nc.note_id = n.id
      WHERE nc.concept_id IN (SELECT value FROM json_each(?)) ORDER BY n.updated_at DESC LIMIT 6`)
      .all(JSON.stringify(weakRows.map(({ id }) => id)));
    missingSource = '暂无符合条件的知识点，可按笔记出题';
  } else if (requestedNotes.length > 0) {
    sourceNotes = db.prepare(`SELECT * FROM active_notes WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(requestedNotes));
    missingSource = '所选笔记已不存在，请重新选择';
  } else if (categoryId) {
    sourceNotes = db
      .prepare(`SELECT * FROM active_notes WHERE category_id = ? ORDER BY updated_at DESC LIMIT 6`)
      .all(categoryId) as any[];
    missingSource = '所选分类没有可用笔记，请重新选择';
  } else {
    sourceNotes = db.prepare(`SELECT * FROM active_notes ORDER BY updated_at DESC LIMIT 5`).all() as any[];
  }

  if (sourceNotes.length === 0) {
    return res.status(400).json({ error: missingSource });
  }

  const safeCount = Math.max(1, Math.min(15, Number(count) || 5));
  const safeTypes =
    Array.isArray(types) && types.length > 0 ? types : (['single', 'boolean', 'short'] as const);
  const focusName = weakOnly && targetConcepts.length === 1 ? targetConcepts[0] : null;

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
        ? `${focusName || '薄弱知识点'}专项测验（${generated.length} 题）`
        : sourceNotes.length === 1
        ? `《${sourceNotes[0].title}》动态测验`
        : `综合动态测验（${sourceNotes.length} 篇笔记）`);

    const sourceIds = sourceNotes.map((note) => note.id);
    const quiz = inTransaction(() => {
      if (existingNoteIds(sourceIds).length !== sourceIds.length) return null;
      db.prepare(
        `INSERT INTO quizzes (id, title, source_note_ids, category_id, difficulty, total_questions, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?)`
      ).run(quizId, quizTitle, JSON.stringify(sourceIds), existingCategoryId(categoryId), difficulty, generated.length, now);

      const insertQuestion = db.prepare(`INSERT INTO quiz_questions (
        id, quiz_id, note_id, concept_name, type, stem, options_json, correct_answer, explanation, memory_tip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const q of generated) {
        const noteId = questionSourceId(q.noteId, sourceIds);
        insertQuestion.run(uid(), quizId, noteId, focusName || q.conceptName, q.type, q.stem,
          JSON.stringify(q.options), q.correctAnswer, q.explanation, q.memoryTip);
      }
      return getQuiz(quizId);
    });
    if (!quiz) return res.status(409).json({ error: '出题期间有来源笔记被删除，请重新选择' });
    res.status(201).json(formatQuiz(quiz));
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
  const quiz = getQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: '测验不存在' });
  if (quiz.status === 'completed') return res.json({ ...formatQuiz(quiz), mistakesAdded: 0 });

  const answers: Record<string, string> = req.body?.answers || {};
  const grades = new Map<string, { userAnswer: string; isCorrect: boolean; score: number; feedback: string }>();

  for (const q of quiz.questions) {
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

    grades.set(q.id, { userAnswer, isCorrect, score, feedback });
  }

  const submitted = inTransaction(() => {
    const current = getQuiz(req.params.id);
    if (!current) return null;
    if (current.status === 'completed') return { ...current, mistakesAdded: 0 };

    let totalScore = 0;
    let mistakesAdded = 0;
    const masteryChanges = new Map<string, MasteryChange>();
    const now = nowIso();
    for (const q of current.questions) {
      const grade = grades.get(q.id);
      if (!grade) throw new Error('测验题目已变化，请重新打开后交卷');
      const { userAnswer, isCorrect, score, feedback } = grade;
      totalScore += score;

      db.prepare(
        `UPDATE quiz_questions SET user_answer = ?, is_correct = ?, ai_feedback = ?, score = ? WHERE id = ?`
      ).run(userAnswer, isCorrect ? 1 : 0, feedback, score, q.id);

      if (q.concept_name) {
        recordMasteryChange(masteryChanges, updateConceptMastery(q.concept_name, isCorrect, q.note_id));
      }

      if (isCorrect) continue;
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

    const finalScore = current.questions.length > 0 ? Number((totalScore / current.questions.length).toFixed(3)) : 0;
    db.prepare(`UPDATE quizzes SET score = ?, status = 'completed', completed_at = ? WHERE id = ?`)
      .run(finalScore, now, quiz.id);
    logStudyActivity('quiz_complete', quiz.id, finalScore, current.questions.length * 45);
    return { ...getQuiz(quiz.id), mistakesAdded, masteryChanges: [...masteryChanges.values()] };
  });
  if (!submitted) return res.status(404).json({ error: '测验已被删除' });
  res.json(formatQuiz(submitted));
});

quizzesRouter.delete('/:id', (req, res) => {
  inTransaction(() => {
    db.prepare(`DELETE FROM quizzes WHERE id = ?`).run(req.params.id);
    reconcileLibraryReferences();
  });
  res.json({ ok: true });
});
