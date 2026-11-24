import { countWords, db, nowIso, reconcileLibraryReferences, restoreReviewedConceptLinks, syncNoteFts } from '../db.js';
import { normalizeBackupSnapshot, type BackupRecord, type BackupSnapshot } from '../shared/libraryBackup.js';
import { readIds } from '../shared/libraryReferences.js';
import { noteStudyText } from '../shared/noteContent.js';

type Table = 'categories' | 'notes' | 'syntheses' | 'concepts' | 'concept_links' | 'quizzes' | 'quiz_questions' |
  'flashcards' | 'mistakes' | 'tutor_sessions' | 'tutor_messages' | 'study_logs';

function rows(table: Table): BackupRecord[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as BackupRecord[];
}

function groupBy(records: BackupRecord[], key: string): Record<string, BackupRecord[]> {
  const groups = Object.create(null) as Record<string, BackupRecord[]>;
  for (const record of records) {
    const id = record[key];
    if (typeof id === 'string') (groups[id] ??= []).push(record);
  }
  return groups;
}

export function readBackupSnapshot(): BackupSnapshot {
  const questions = groupBy(rows('quiz_questions'), 'quiz_id');
  const noteIds = new Map<string, string[]>();
  for (const { concept_id, note_id } of db.prepare('SELECT concept_id, note_id FROM note_concepts').all() as { concept_id: string; note_id: string }[]) {
    const ids = noteIds.get(concept_id) ?? [];
    ids.push(note_id);
    noteIds.set(concept_id, ids);
  }
  return normalizeBackupSnapshot({
    categories: rows('categories'),
    notes: rows('notes'),
    syntheses: rows('syntheses'),
    concepts: rows('concepts').map((concept) => ({ ...concept, note_ids: noteIds.get(concept.id) ?? [] })),
    conceptLinks: rows('concept_links'),
    quizzes: rows('quizzes').map((quiz) => ({ ...quiz, questions: questions[quiz.id] ?? [] })),
    flashcards: rows('flashcards'),
    mistakes: rows('mistakes'),
    tutorSessions: rows('tutor_sessions'),
    tutorMessages: groupBy(rows('tutor_messages'), 'session_id'),
    studyLogs: rows('study_logs'),
  });
}

type Scalar = string | number | null;

function sqliteValue(input: unknown): Scalar | undefined {
  if (input == null) return input === null ? null : undefined;
  if (typeof input === 'boolean') return Number(input);
  if (typeof input === 'number') return Number.isFinite(input) ? input : undefined;
  return typeof input === 'string' ? input : undefined;
}

// Select columns from the local schema so portable records never control SQL identifiers.
function upsert(table: Table, records: BackupRecord[]) {
  if (!records.length) return;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => String(name));
  const idSet = new Set<string>();
  const statements = new Map<string, ReturnType<typeof db.prepare>>();
  for (const record of records) {
    if (idSet.has(record.id)) throw new Error('备份中有记录同时属于多个父记录');
    idSet.add(record.id);
    const entries = columns.flatMap((column) => {
      const value = sqliteValue(record[column]);
      return value === undefined ? [] : [[column, value] as const];
    });
    const names = entries.map(([name]) => name);
    const key = names.join(',');
    let statement = statements.get(key);
    if (!statement) {
      const updates = names.filter((name) => name !== 'id').map((name) => `${name} = excluded.${name}`);
      statement = db.prepare(`INSERT INTO ${table} (${key}) VALUES (${names.map(() => '?').join(',')})
        ON CONFLICT(id) DO ${updates.length ? `UPDATE SET ${updates.join(',')}` : 'NOTHING'}`);
      statements.set(key, statement);
    }
    statement.run(...entries.map(([, value]) => value));
  }
}

function exists(value: unknown, ids: Set<string>): string | null {
  return typeof value === 'string' && ids.has(value) ? value : null;
}

function knownIds(value: unknown, ids: Set<string>): string[] {
  return readIds(value).filter((id) => ids.has(id));
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function applyBackupSnapshot(snapshot: BackupSnapshot, changedNotes: BackupRecord[]) {
  const stamp = nowIso();
  const dated = (item: BackupRecord) => {
    const created_at = text(item.created_at, stamp);
    const updated_at = text(item.updated_at ?? item.last_reviewed_at ?? item.completed_at, created_at);
    return { ...item, created_at, updated_at };
  };
  const categories = new Set(snapshot.categories.map(({ id }) => id));
  const noteIds = new Set(snapshot.notes.map(({ id }) => id));
  const categorized = (item: BackupRecord) => ({ ...dated(item), category_id: exists(item.category_id, categories) });
  const linked = (item: BackupRecord) => ({ ...categorized(item), note_id: exists(item.note_id, noteIds) });

  upsert('categories', snapshot.categories.map((item) => ({
    ...dated(item), name: text(item.name, '未命名分类'), parent_id: exists(item.parent_id, categories),
  })));
  const notes = changedNotes.map((item) => {
    const title = text(item.title, '未命名笔记');
    const source_content = typeof item.source_content === 'string' ? item.source_content : null;
    const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const studyText = noteStudyText({
      content: text(item.content, ''),
      source_content,
      chat_excerpts: item.chat_excerpts,
    });
    return {
      title, tags, studyText,
      row: {
        ...categorized(item),
        summary_json: item.summary ? JSON.stringify(item.summary) : null,
        chat_excerpts: JSON.stringify(item.chat_excerpts ?? []),
        tags: JSON.stringify(tags),
        source_content,
        source_pages: item.source_pages ? JSON.stringify(item.source_pages) : null,
        source_filename: item.source_filename ?? null,
        attachment_path: item.attachment_path ?? null,
        word_count: typeof item.word_count === 'number' ? item.word_count : countWords(studyText),
      },
    };
  });
  upsert('notes', notes.map(({ row }) => row));
  for (const { row, title, studyText, tags } of notes) {
    syncNoteFts(row.id, title, studyText, tags);
  }
  upsert('syntheses', snapshot.syntheses.map((item) => ({
    ...categorized(item), title: text(item.title, '专题归纳'), content: text(item.content, ''),
    note_ids: JSON.stringify(knownIds(item.note_ids, noteIds)),
  })));
  upsert('concepts', snapshot.concepts.map(categorized));
  const addConceptNote = db.prepare('INSERT OR IGNORE INTO note_concepts (note_id, concept_id) VALUES (?, ?)');
  for (const concept of snapshot.concepts) {
    for (const noteId of knownIds(concept.note_ids, noteIds)) addConceptNote.run(noteId, concept.id);
  }
  upsert('concept_links', snapshot.conceptLinks.map((item) => ({ ...item, source_id: item.source, target_id: item.target })));
  upsert('quizzes', snapshot.quizzes.map((item) => ({
    ...categorized(item), title: text(item.title, '练习记录'), source_note_ids: JSON.stringify(knownIds(item.source_note_ids, noteIds)),
  })));
  const questions = snapshot.quizzes.flatMap((quiz) => (quiz.questions as BackupRecord[]).map((item) => ({
    ...linked(item), quiz_id: quiz.id, options_json: JSON.stringify(item.options ?? []),
  })));
  upsert('quiz_questions', questions);
  const questionIds = new Set(questions.map(({ id }) => id));
  upsert('flashcards', snapshot.flashcards.map((item) => ({ ...linked(item), next_review_at: text(item.next_review_at, stamp) })));
  upsert('mistakes', snapshot.mistakes.map((item) => ({
    ...linked(item), question_id: exists(item.question_id, questionIds),
    options_json: JSON.stringify(item.options ?? []), next_review_at: text(item.next_review_at, stamp),
  })));
  upsert('tutor_sessions', snapshot.tutorSessions.map((item) => ({
    ...dated(item), title: text(item.title, '学习对话'), note_ids: JSON.stringify(knownIds(item.note_ids, noteIds)),
  })));
  upsert('tutor_messages', snapshot.tutorSessions.flatMap(({ id }) => (snapshot.tutorMessages[id] ?? [])
    .map((item) => ({ ...dated(item), session_id: id }))));
  upsert('study_logs', snapshot.studyLogs.map((item) => ({ ...dated(item), date_key: text(item.date_key, stamp.slice(0, 10)) })));
  reconcileLibraryReferences();
  restoreReviewedConceptLinks();
}
