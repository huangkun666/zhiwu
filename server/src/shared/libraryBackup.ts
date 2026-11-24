import { readIds } from './libraryReferences.js';
import { readChatExcerpts } from './noteContent.js';
import { readPdfPages } from './pdfPages.js';
import { isTutorMode } from './tutorMode.js';

export type BackupRecord = { id: string } & Record<string, unknown>;

export interface BackupSnapshot {
  categories: BackupRecord[];
  notes: BackupRecord[];
  syntheses: BackupRecord[];
  concepts: BackupRecord[];
  conceptLinks: BackupRecord[];
  quizzes: BackupRecord[];
  flashcards: BackupRecord[];
  mistakes: BackupRecord[];
  tutorSessions: BackupRecord[];
  tutorMessages: Record<string, BackupRecord[]>;
  studyLogs: BackupRecord[];
}

export interface BackupAttachment {
  noteId: string;
  path: string;
  mime: string;
}

export interface BackupMissingAttachment {
  noteId: string;
  filename: string;
}

export interface BackupManifest {
  format: 'zhiwu-backup';
  version: 2;
  exportedAt: string;
  snapshot: BackupSnapshot;
  attachments: BackupAttachment[];
  missingAttachments: BackupMissingAttachment[];
}

interface BackupDescriptionOptions {
  kind: 'archive' | 'legacy';
  exportedAt?: string;
  attachments?: BackupAttachment[];
  missingAttachments?: BackupMissingAttachment[];
}

export interface BackupPreview {
  kind: 'archive' | 'legacy';
  exportedAt?: string;
  counts: {
    notes: number;
    trashedNotes: number;
    attachments: number;
    syntheses: number;
    quizzes: number;
    flashcards: number;
    mistakes: number;
    tutorSessions: number;
    studyLogs: number;
  };
  conflicts: number;
  missingAttachments: BackupMissingAttachment[];
}

const collectionKeys = [
  'categories', 'notes', 'syntheses', 'concepts', 'conceptLinks', 'quizzes', 'flashcards',
  'mistakes', 'tutorSessions', 'studyLogs',
] as const;

const safeMimes = new Set([
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp',
  'image/avif', 'image/tiff', 'image/heic', 'image/heif',
]);

const textFields = [
  'created_at', 'updated_at', 'completed_at', 'last_reviewed_at', 'next_review_at', 'date_key',
  'name', 'title', 'description', 'color', 'content', 'source_content', 'source_filename', 'source_type',
  'concept_name', 'front', 'back', 'hint', 'stem', 'correct_answer', 'wrong_answer', 'user_answer',
  'explanation', 'memory_tip', 'user_reflection', 'ai_diagnosis', 'ai_feedback',
] as const;

export function safeAttachmentMime(value: unknown): string {
  const mime = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (mime === 'image/jpg') return 'image/jpeg';
  return safeMimes.has(mime) ? mime : 'application/octet-stream';
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function strings(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function records(value: unknown): BackupRecord[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('备份中的记录列表无效');
  const byId = new Map<string, BackupRecord>();
  for (const item of value) {
    const record = object(item);
    if (typeof record.id !== 'string' || !record.id.trim() || byId.has(record.id)) {
      throw new Error('备份中存在缺少 ID 或 ID 重复的记录');
    }
    if (textFields.some((field) => record[field] != null && typeof record[field] !== 'string')) {
      throw new Error('备份中的记录字段格式无效');
    }
    byId.set(record.id, { ...record, id: record.id });
  }
  return [...byId.values()];
}

function normalizeSummary(value: unknown) {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const summary = object(parsed);
  const concepts = Array.isArray(summary.concepts) ? summary.concepts.filter((entry) =>
    typeof entry?.name === 'string' && typeof entry?.definition === 'string') : [];
  return {
    ...summary,
    abstract: typeof summary.abstract === 'string' ? summary.abstract : '',
    keyPoints: strings(summary.keyPoints),
    concepts,
    outline: strings(summary.outline),
    difficulty: typeof summary.difficulty === 'string' ? summary.difficulty : undefined,
  };
}

function normalizeNote(record: BackupRecord): BackupRecord {
  const { summary_json, ...note } = record;
  const deletedAt = note.deleted_at;
  return {
    ...note,
    source_pages: note.source_type === 'pdf' ? readPdfPages(note.source_pages, String(note.source_content ?? '')) : null,
    title: typeof note.title === 'string' ? note.title : '未命名笔记',
    content: typeof note.content === 'string' ? note.content : '',
    summary: normalizeSummary(note.summary ?? summary_json),
    tags: strings(note.tags),
    chat_excerpts: readChatExcerpts(note.chat_excerpts),
    is_pinned: note.is_pinned === true || note.is_pinned === 1,
    deleted_at: typeof deletedAt === 'string' && Number.isFinite(Date.parse(deletedAt))
      ? deletedAt : deletedAt === null ? null : undefined,
  };
}

function normalizeQuestion(record: BackupRecord, quizId: string): BackupRecord {
  const { options_json, ...question } = record;
  return {
    ...question,
    quiz_id: quizId,
    options: strings(question.options ?? options_json),
    is_correct: question.is_correct == null ? null : question.is_correct === true || question.is_correct === 1,
  };
}

export function normalizeBackupSnapshot(value: unknown): BackupSnapshot {
  const data = object(value);
  if (!Array.isArray(data.notes)) throw new Error('备份中缺少笔记列表');
  const messages = Object.create(null) as Record<string, BackupRecord[]>;
  for (const [id, list] of Object.entries(object(data.tutorMessages))) {
    messages[id] = records(list).map((message) => ({ ...message, session_id: id }));
  }
  return {
    categories: records(data.categories).map((category) => ({ ...category, updated_at: category.updated_at ?? category.created_at })),
    notes: records(data.notes).map(normalizeNote),
    syntheses: records(data.syntheses).map((item) => ({ ...item, note_ids: readIds(item.note_ids) })),
    concepts: records(data.concepts).map((item) => ({ ...item, note_ids: readIds(item.note_ids) })),
    conceptLinks: records(data.conceptLinks).map((item) => ({ ...item, source: item.source ?? item.source_id, target: item.target ?? item.target_id })),
    quizzes: records(data.quizzes).map((item) => ({
      ...item,
      source_note_ids: readIds(item.source_note_ids),
      questions: records(item.questions).map((question) => normalizeQuestion(question, item.id)),
    })),
    flashcards: records(data.flashcards),
    mistakes: records(data.mistakes).map(({ options_json, ...item }) => ({ ...item, options: strings(item.options ?? options_json) })),
    tutorSessions: records(data.tutorSessions).map((item) => ({
      ...item, mode: isTutorMode(item.mode) ? item.mode : 'qa', note_ids: readIds(item.note_ids),
    })),
    tutorMessages: messages,
    studyLogs: records(data.studyLogs),
  };
}

export function createBackupManifest(
  snapshot: BackupSnapshot,
  attachments: BackupAttachment[],
  missingAttachments: BackupMissingAttachment[],
  exportedAt = new Date().toISOString(),
): BackupManifest {
  const portable = normalizeBackupSnapshot(snapshot);
  portable.notes = portable.notes.map(({ attachment_path, ...note }) => ({ ...note, deleted_at: note.deleted_at ?? null }));
  return { format: 'zhiwu-backup', version: 2, exportedAt, snapshot: portable, attachments, missingAttachments };
}

export function parseBackupManifest(value: unknown): BackupManifest {
  const manifest = object(value);
  if (manifest.format !== 'zhiwu-backup' || manifest.version !== 2 || typeof manifest.exportedAt !== 'string' ||
      !Array.isArray(manifest.attachments) || !Array.isArray(manifest.missingAttachments)) {
    throw new Error('当前版本无法读取此备份格式');
  }
  const snapshot = normalizeBackupSnapshot(manifest.snapshot);
  const noteIds = new Set(snapshot.notes.map(({ id }) => id));
  const referencedNotes = new Set<string>();
  const paths = new Set<string>();
  const attachments = manifest.attachments.map((value: unknown) => {
    const { noteId, path, mime } = object(value);
    if (typeof noteId !== 'string' || !noteIds.has(noteId) || referencedNotes.has(noteId) ||
        typeof path !== 'string' || !/^attachments\/\d+(?:\.[a-z0-9]{1,8})?$/i.test(path) || paths.has(path)) {
      throw new Error('备份中的附件索引无效');
    }
    referencedNotes.add(noteId);
    paths.add(path);
    return { noteId, path, mime: safeAttachmentMime(mime) };
  });
  const missingAttachments = manifest.missingAttachments.map((value: unknown) => {
    const { noteId, filename } = object(value);
    if (typeof noteId !== 'string' || !noteIds.has(noteId) || typeof filename !== 'string' || referencedNotes.has(noteId)) {
      throw new Error('备份中的缺失附件列表无效');
    }
    referencedNotes.add(noteId);
    return { noteId, filename };
  });
  snapshot.notes = snapshot.notes.map(({ attachment_path, ...note }) => note);
  return { format: 'zhiwu-backup', version: 2, exportedAt: manifest.exportedAt, snapshot, attachments, missingAttachments };
}

function timestamp(item: BackupRecord): number {
  let latest = 0;
  for (const value of [item.updated_at, item.last_reviewed_at, item.completed_at, item.deleted_at, item.created_at]) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(time)) latest = Math.max(latest, time);
  }
  return latest;
}

function newer(current: BackupRecord, incoming: BackupRecord): BackupRecord {
  return timestamp(incoming) > timestamp(current) ? incoming : current;
}

function mergeRecords(
  current: BackupRecord[],
  incoming: BackupRecord[],
  choose = newer,
): BackupRecord[] {
  const merged = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const existing = merged.get(record.id);
    merged.set(record.id, existing ? choose(existing, record) : record);
  }
  return [...merged.values()];
}

function mergeNotes(current: BackupRecord, incoming: BackupRecord): BackupRecord {
  const primary = newer(current, incoming);
  const fallback = primary === current ? incoming : current;
  const missing: Record<string, unknown> = {};
  for (const field of ['attachment_path', 'source_content', 'source_filename', 'source_type']) {
    if (primary[field] == null && fallback[field] != null) missing[field] = fallback[field];
  }
  if (primary.source_pages == null && fallback.source_pages != null &&
      (primary.source_type ?? missing.source_type) === 'pdf' &&
      (!primary.attachment_path || primary.attachment_path === fallback.attachment_path) &&
      (primary.source_content ?? missing.source_content) === fallback.source_content) {
    missing.source_pages = fallback.source_pages;
  }
  if (primary === incoming && incoming.deleted_at === undefined && current.deleted_at !== undefined) {
    missing.deleted_at = current.deleted_at;
  }
  return Object.keys(missing).length ? { ...primary, ...missing } : primary;
}

function mergeQuizzes(current: BackupRecord, incoming: BackupRecord): BackupRecord {
  const complete = [current, incoming].filter(({ status }) => status === 'completed');
  const selected = complete.length === 1 ? complete[0] : newer(current, incoming);
  const other = selected === current ? incoming : current;
  const questions = mergeRecords(records(selected.questions), records(other.questions), (known) => known);
  return { ...selected, questions };
}

function mergeConcepts(current: BackupSnapshot, incoming: BackupSnapshot) {
  const byId = new Map(current.concepts.map((concept) => [concept.id, concept]));
  const byName = new Map(current.concepts.map((concept) => [concept.name, concept.id]));
  const incomingIds = new Map<string, string>();
  for (const concept of incoming.concepts) {
    const name = typeof concept.name === 'string' ? concept.name.trim() : '';
    if (!name) continue;
    const id = byName.get(name) ?? concept.id;
    const previous = byId.get(id);
    incomingIds.set(concept.id, id);
    if (!previous) {
      byId.set(id, { ...concept, name });
      byName.set(name, id);
      continue;
    }
    const attempts = (item: BackupRecord) => typeof item.quiz_attempts === 'number' ? item.quiz_attempts : 0;
    const progress = attempts(concept) > attempts(previous) ? concept : previous;
    byId.set(id, {
      ...progress,
      id,
      name: previous.name,
      description: previous.description || concept.description,
      category_id: previous.category_id ?? concept.category_id ?? null,
      note_ids: readIds([...readIds(previous.note_ids), ...readIds(concept.note_ids)]),
    });
  }

  const links = new Map<string, BackupRecord>();
  const linkIds = new Set<string>();
  function addLink(record: BackupRecord, remap: boolean) {
    if (typeof record.source !== 'string' || typeof record.target !== 'string') return;
    const source = remap ? incomingIds.get(record.source) ?? record.source : record.source;
    const target = remap ? incomingIds.get(record.target) ?? record.target : record.target;
    if (source === target || !byId.has(source) || !byId.has(target)) return;
    const pair = JSON.stringify([source, target]);
    if (!links.has(pair) && !linkIds.has(record.id)) {
      links.set(pair, { ...record, source, target });
      linkIds.add(record.id);
    }
  }
  current.conceptLinks.forEach((record) => addLink(record, false));
  incoming.conceptLinks.forEach((record) => addLink(record, true));
  return { concepts: [...byId.values()], conceptLinks: [...links.values()] };
}

export function mergeBackupSnapshots(current: BackupSnapshot, incoming: BackupSnapshot): { snapshot: BackupSnapshot; notesCount: number } {
  const notes = mergeRecords(current.notes, incoming.notes, mergeNotes);
  const originals = new Map(current.notes.map((item) => [item.id, item]));
  const notesCount = notes.filter((item) => originals.get(item.id) !== item).length;
  const tutorSessions = mergeRecords(current.tutorSessions, incoming.tutorSessions);
  const tutorMessages = Object.create(null) as Record<string, BackupRecord[]>;
  for (const { id } of tutorSessions) {
    const messages = mergeRecords(current.tutorMessages[id] ?? [], incoming.tutorMessages[id] ?? []);
    if (messages.length) tutorMessages[id] = messages.sort((a, b) => timestamp(a) - timestamp(b));
  }
  const snapshot: BackupSnapshot = {
    categories: mergeRecords(current.categories, incoming.categories),
    notes,
    syntheses: mergeRecords(current.syntheses, incoming.syntheses),
    ...mergeConcepts(current, incoming),
    quizzes: mergeRecords(current.quizzes, incoming.quizzes, mergeQuizzes),
    flashcards: mergeRecords(current.flashcards, incoming.flashcards),
    mistakes: mergeRecords(current.mistakes, incoming.mistakes),
    tutorSessions,
    tutorMessages,
    studyLogs: mergeRecords(current.studyLogs, incoming.studyLogs),
  };
  return { snapshot, notesCount };
}

export function describeBackup(snapshot: BackupSnapshot, current: BackupSnapshot, options: BackupDescriptionOptions): BackupPreview {
  let conflicts = 0;
  for (const key of collectionKeys) {
    const existing = new Set(current[key].map(({ id }) => id));
    conflicts += snapshot[key].filter(({ id }) => existing.has(id)).length;
  }
  return {
    kind: options.kind,
    exportedAt: options.exportedAt,
    counts: {
      notes: snapshot.notes.length,
      trashedNotes: snapshot.notes.filter((note) => Boolean(note.deleted_at)).length,
      attachments: options.attachments?.length ?? 0,
      syntheses: snapshot.syntheses.length,
      quizzes: snapshot.quizzes.length,
      flashcards: snapshot.flashcards.length,
      mistakes: snapshot.mistakes.length,
      tutorSessions: snapshot.tutorSessions.length,
      studyLogs: snapshot.studyLogs.length,
    },
    conflicts,
    missingAttachments: options.missingAttachments ?? [],
  };
}
