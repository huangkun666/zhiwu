import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root data directory: f:\Learning\知悟\data
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'zhiwu.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Enable WAL mode & foreign keys for local concurrency and durability
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

export interface AIProviderConfig {
  id: string;
  name: string;
  type: 'openai' | 'gemini';
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsVision: boolean;
  requiresKey?: boolean;
}

export interface AISettings {
  activeProviderId: string;
  providers: AIProviderConfig[];
  dailyGoalMinutes: number;
  dailyReviewTarget: number;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  activeProviderId: 'remote',
  dailyGoalMinutes: 30,
  dailyReviewTarget: 20,
  providers: [
    {
      id: 'remote',
      name: '远程模型',
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      supportsVision: false,
      requiresKey: true,
    },
    {
      id: 'local',
      name: '本地模型',
      type: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: 'qwen2.5:7b',
      supportsVision: false,
      requiresKey: false,
    },
  ],
};

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      color TEXT DEFAULT '#3B5BDB',
      icon TEXT DEFAULT 'folder',
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_content TEXT,
      chat_excerpts TEXT NOT NULL DEFAULT '[]',
      summary_json TEXT,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      tags TEXT DEFAULT '[]',
      source_type TEXT DEFAULT 'markdown',
      source_filename TEXT,
      attachment_path TEXT,
      word_count INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      note_id UNINDEXED,
      title,
      content,
      tags,
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS syntheses (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      note_ids TEXT NOT NULL,
      category_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      category_id TEXT,
      mastery_score REAL DEFAULT 0.5,
      quiz_attempts INTEGER DEFAULT 0,
      quiz_correct INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_concepts (
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      PRIMARY KEY (note_id, concept_id)
    );

    CREATE TABLE IF NOT EXISTS concept_links (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      relation TEXT DEFAULT '相关',
      weight REAL DEFAULT 1.0,
      UNIQUE(source_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_note_ids TEXT DEFAULT '[]',
      category_id TEXT,
      difficulty TEXT DEFAULT 'medium',
      total_questions INTEGER DEFAULT 0,
      score REAL,
      status TEXT DEFAULT 'in_progress',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS quiz_questions (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      note_id TEXT,
      concept_name TEXT DEFAULT '',
      type TEXT NOT NULL,
      stem TEXT NOT NULL,
      options_json TEXT DEFAULT '[]',
      correct_answer TEXT NOT NULL,
      explanation TEXT DEFAULT '',
      memory_tip TEXT DEFAULT '',
      user_answer TEXT,
      is_correct INTEGER,
      ai_feedback TEXT,
      score REAL
    );

    CREATE TABLE IF NOT EXISTS mistakes (
      id TEXT PRIMARY KEY,
      question_id TEXT,
      note_id TEXT,
      concept_name TEXT DEFAULT '',
      type TEXT NOT NULL,
      stem TEXT NOT NULL,
      options_json TEXT DEFAULT '[]',
      correct_answer TEXT NOT NULL,
      wrong_answer TEXT DEFAULT '',
      explanation TEXT DEFAULT '',
      ai_diagnosis TEXT DEFAULT '',
      user_reflection TEXT DEFAULT '',
      status TEXT DEFAULT 'unmastered',
      wrong_count INTEGER DEFAULT 1,
      ease_factor REAL DEFAULT 2.5,
      interval_days INTEGER DEFAULT 1,
      repetitions INTEGER DEFAULT 0,
      next_review_at TEXT NOT NULL,
      last_reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS flashcards (
      id TEXT PRIMARY KEY,
      note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      category_id TEXT,
      concept_name TEXT DEFAULT '',
      front TEXT NOT NULL,
      back TEXT NOT NULL,
      hint TEXT DEFAULT '',
      ease_factor REAL DEFAULT 2.5,
      interval_days INTEGER DEFAULT 0,
      repetitions INTEGER DEFAULT 0,
      next_review_at TEXT NOT NULL,
      last_reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tutor_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT DEFAULT 'qa',
      note_ids TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tutor_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS study_logs (
      id TEXT PRIMARY KEY,
      activity_type TEXT NOT NULL,
      entity_id TEXT,
      duration_seconds INTEGER DEFAULT 0,
      score REAL,
      created_at TEXT NOT NULL,
      date_key TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category_id);
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
    CREATE INDEX IF NOT EXISTS idx_mistakes_review ON mistakes(next_review_at);
    CREATE INDEX IF NOT EXISTS idx_flashcards_review ON flashcards(next_review_at);
    CREATE INDEX IF NOT EXISTS idx_study_logs_date ON study_logs(date_key);
  `);

  const noteColumns = new Set(db.prepare('PRAGMA table_info(notes)').all().map((column) => column.name));
  if (!noteColumns.has('source_content')) db.exec('ALTER TABLE notes ADD COLUMN source_content TEXT');
  if (!noteColumns.has('chat_excerpts')) db.exec("ALTER TABLE notes ADD COLUMN chat_excerpts TEXT NOT NULL DEFAULT '[]'");

  // Initialize default AI settings if absent
  const existing = db.prepare(`SELECT value FROM settings WHERE key = 'ai_settings'`).get() as { value: string } | undefined;
  if (!existing) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_settings', ?)`).run(JSON.stringify(DEFAULT_AI_SETTINGS));
  }
}

export function uid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function countWords(text: string): number {
  const cleaned = text.replace(/[#*`>\-\[\]()!]/g, ' ').trim();
  if (!cleaned) return 0;
  const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonCjk = cleaned
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + nonCjk;
}

export function syncNoteFts(noteId: string, title: string, content: string, tags: string[]) {
  db.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).run(noteId);
  db.prepare(`INSERT INTO notes_fts (note_id, title, content, tags) VALUES (?, ?, ?, ?)`).run(
    noteId,
    title,
    content,
    tags.join(' ')
  );
}

export function deleteNoteFts(noteId: string) {
  db.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).run(noteId);
}

export function logStudyActivity(
  activityType: string,
  entityId: string | null = null,
  score: number | null = null,
  durationSeconds = 0
) {
  db.prepare(
    `INSERT INTO study_logs (id, activity_type, entity_id, duration_seconds, score, created_at, date_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uid(), activityType, entityId, durationSeconds, score, nowIso(), todayKey());
}

export function getAISettings(): AISettings {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ai_settings'`).get() as { value: string } | undefined;
  if (!row) return DEFAULT_AI_SETTINGS;
  try {
    const parsed = JSON.parse(row.value) as Partial<AISettings>;
    const rawProviders = Array.isArray(parsed.providers) ? (parsed.providers as any[]) : [];

    // Already migrated to clean 2-slot ('remote' & 'local') model settings
    const existingRemote = rawProviders.find((p) => p.id === 'remote');
    const existingLocal = rawProviders.find((p) => p.id === 'local');

    if (existingRemote && existingLocal) {
      return {
        ...DEFAULT_AI_SETTINGS,
        ...parsed,
        activeProviderId: parsed.activeProviderId === 'local' ? 'local' : 'remote',
        providers: [
          { ...DEFAULT_AI_SETTINGS.providers[0], ...existingRemote, id: 'remote', name: '远程模型', requiresKey: true },
          { ...DEFAULT_AI_SETTINGS.providers[1], ...existingLocal, id: 'local', name: '本地模型', requiresKey: false },
        ],
      };
    }

    // Migrate legacy multi-vendor presets smoothly into 'remote' + 'local' without losing saved API keys
    const legacyActive = rawProviders.find((p) => p.id === parsed.activeProviderId);
    const legacyRemote =
      (legacyActive && legacyActive.id !== 'ollama' ? legacyActive : null) ||
      rawProviders.find((p) => p.id !== 'ollama' && p.apiKey?.trim()) ||
      rawProviders.find((p) => p.id !== 'ollama');
    const legacyLocal = rawProviders.find((p) => p.id === 'ollama');

    const remote: AIProviderConfig = legacyRemote
      ? {
          id: 'remote',
          name: '远程模型',
          type: legacyRemote.type === 'gemini' ? 'gemini' : 'openai',
          baseUrl: legacyRemote.baseUrl || DEFAULT_AI_SETTINGS.providers[0].baseUrl,
          apiKey: legacyRemote.apiKey || '',
          model: String(legacyRemote.model ?? legacyRemote.chatModel ?? DEFAULT_AI_SETTINGS.providers[0].model),
          supportsVision:
            typeof legacyRemote.supportsVision === 'boolean'
              ? legacyRemote.supportsVision
              : /gemini|4o|vl|vision|omni/i.test(String(legacyRemote.model ?? legacyRemote.chatModel ?? '')),
          requiresKey: true,
        }
      : DEFAULT_AI_SETTINGS.providers[0];

    const local: AIProviderConfig = legacyLocal
      ? {
          id: 'local',
          name: '本地模型',
          type: 'openai',
          baseUrl: legacyLocal.baseUrl || DEFAULT_AI_SETTINGS.providers[1].baseUrl,
          apiKey: legacyLocal.apiKey || 'ollama',
          model: String(legacyLocal.model ?? legacyLocal.chatModel ?? DEFAULT_AI_SETTINGS.providers[1].model),
          supportsVision: Boolean(legacyLocal.supportsVision),
          requiresKey: false,
        }
      : DEFAULT_AI_SETTINGS.providers[1];

    return {
      ...DEFAULT_AI_SETTINGS,
      ...parsed,
      activeProviderId: parsed.activeProviderId === 'ollama' || parsed.activeProviderId === 'local' ? 'local' : 'remote',
      providers: [remote, local],
    };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export function saveAISettings(settings: AISettings) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_settings', ?)`).run(JSON.stringify(settings));
}

export function upsertConcept(
  name: string,
  description = '',
  categoryId: string | null = null,
  noteId: string | null = null
): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const existing = db.prepare(`SELECT id, description, category_id FROM concepts WHERE name = ?`).get(trimmed) as
    | { id: string; description: string; category_id: string | null }
    | undefined;

  let conceptId: string;
  if (existing) {
    conceptId = existing.id;
    if (description && !existing.description) {
      db.prepare(`UPDATE concepts SET description = ? WHERE id = ?`).run(description, conceptId);
    }
    if (categoryId && !existing.category_id) {
      db.prepare(`UPDATE concepts SET category_id = ? WHERE id = ?`).run(categoryId, conceptId);
    }
  } else {
    conceptId = uid();
    db.prepare(
      `INSERT INTO concepts (id, name, description, category_id, mastery_score, quiz_attempts, quiz_correct, created_at)
       VALUES (?, ?, ?, ?, 0.5, 0, 0, ?)`
    ).run(conceptId, trimmed, description, categoryId, nowIso());
  }

  if (noteId) {
    db.prepare(`INSERT OR IGNORE INTO note_concepts (note_id, concept_id) VALUES (?, ?)`).run(noteId, conceptId);
  }
  return conceptId;
}

export function updateConceptMastery(conceptName: string, isCorrect: boolean, categoryId: string | null = null) {
  const trimmed = conceptName.trim();
  if (!trimmed) return;
  const conceptId = upsertConcept(trimmed, '', categoryId);
  const row = db.prepare(`SELECT quiz_attempts, quiz_correct FROM concepts WHERE id = ?`).get(conceptId) as {
    quiz_attempts: number;
    quiz_correct: number;
  };
  const attempts = (row?.quiz_attempts || 0) + 1;
  const correct = (row?.quiz_correct || 0) + (isCorrect ? 1 : 0);
  // Smoothed Bayesian-like mastery score so 1 correct answer doesn't immediately become 100%
  const mastery = Number(((correct + 0.5) / (attempts + 1)).toFixed(3));
  db.prepare(`UPDATE concepts SET quiz_attempts = ?, quiz_correct = ?, mastery_score = ? WHERE id = ?`).run(
    attempts,
    correct,
    mastery,
    conceptId
  );
}
