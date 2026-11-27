import type { ChatExcerpt } from '../../server/src/shared/noteContent';
import type { PdfPage } from '../../server/src/shared/pdfPages';
import type { MasteryChange, StudyConcept, TodayProgress } from '../../server/src/shared/todayLearning';
import type { TutorMode } from '../../server/src/shared/tutorMode';

export type { TutorMode } from '../../server/src/shared/tutorMode';

export type PageId =
  | 'home'
  | 'notes'
  | 'practice'
  | 'review'
  | 'tutor'
  | 'settings';

export interface PracticeContext {
  subTab?: 'quiz' | 'mistakes';
  noteIds?: string[];
  weakOnly?: boolean;
  focusConcepts?: string[];
  count?: number;
}

export interface Category {
  id: string;
  name: string;
  parent_id?: string | null;
  color: string;
  icon: string;
  description?: string;
  note_count?: number;
  created_at: string;
  updated_at?: string | null;
}

export interface NoteSummary {
  abstract: string;
  keyPoints: string[];
  concepts: { name: string; definition: string }[];
  relations?: { source: string; target: string; relation: string }[];
  outline: string[];
  suggestedCategory?: string;
  suggestedTags?: string[];
  difficulty?: '基础' | '进阶' | '高阶';
}

export interface Note {
  knowledge_index?: import('../../server/src/shared/knowledgePoints').KnowledgeIndex | null;
  id: string;
  title: string;
  content: string;
  source_content?: string | null;
  source_pages?: PdfPage[] | null;
  chat_excerpts?: ChatExcerpt[];
  summary: NoteSummary | null;
  category_id: string | null;
  category_name?: string | null;
  category_color?: string | null;
  tags: string[];
  source_type: 'markdown' | 'text' | 'pdf' | 'docx' | 'image';
  source_filename?: string | null;
  attachment_path?: string | null;
  word_count: number;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export type TrashedNote = Pick<Note, 'id' | 'title' | 'source_type' | 'source_filename' | 'word_count' | 'category_name'> & {
  deleted_at: string;
};

export interface Synthesis {
  id: string;
  title: string;
  note_ids: string[];
  category_id: string | null;
  content: string;
  created_at: string;
}

export interface QuizQuestion {
  id: string;
  quiz_id: string;
  note_id?: string | null;
  concept_name: string;
  type: 'single' | 'multiple' | 'boolean' | 'short';
  stem: string;
  options: string[];
  correct_answer: string;
  explanation: string;
  memory_tip: string;
  user_answer?: string | null;
  is_correct?: boolean | null;
  ai_feedback?: string | null;
  score?: number | null;
}

export interface Quiz {
  id: string;
  title: string;
  source_note_ids: string[];
  category_id?: string | null;
  difficulty: 'easy' | 'medium' | 'hard';
  total_questions: number;
  score: number | null;
  status: 'in_progress' | 'completed';
  created_at: string;
  completed_at?: string | null;
  questions?: QuizQuestion[];
  mistakesAdded?: number;
  masteryChanges?: MasteryChange[];
}

export interface Mistake {
  id: string;
  question_id?: string | null;
  note_id?: string | null;
  note_title?: string | null;
  concept_name: string;
  type: 'single' | 'multiple' | 'boolean' | 'short';
  stem: string;
  options: string[];
  correct_answer: string;
  wrong_answer: string;
  explanation: string;
  ai_diagnosis: string;
  user_reflection: string;
  status: 'unmastered' | 'reviewing' | 'mastered';
  wrong_count: number;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_at: string;
  last_reviewed_at?: string | null;
  created_at: string;
  updated_at?: string;
  interval_previews?: Record<1 | 2 | 3 | 4, string>;
}

export interface Flashcard {
  id: string;
  note_id?: string | null;
  note_title?: string | null;
  category_id?: string | null;
  concept_name: string;
  front: string;
  back: string;
  hint: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_at: string;
  last_reviewed_at?: string | null;
  created_at: string;
  updated_at?: string;
  interval_previews?: Record<1 | 2 | 3 | 4, string>;
}

export interface ReviewQueueItem {
  itemType: 'flashcard' | 'mistake';
  id: string;
  note_id?: string | null;
  note_title?: string | null;
  concept_name: string;
  // Flashcard fields
  front?: string;
  back?: string;
  hint?: string;
  // Mistake fields
  type?: string;
  stem?: string;
  options?: string[];
  correct_answer?: string;
  wrong_answer?: string;
  explanation?: string;
  ai_diagnosis?: string;
  interval_previews?: Record<1 | 2 | 3 | 4, string>;
}

export interface GraphNode {
  id: string;
  name: string;
  description: string;
  category_id?: string | null;
  category_name?: string | null;
  category_color?: string | null;
  mastery_score: number;
  quiz_attempts: number;
  quiz_correct: number;
  note_count: number;
  active_mistakes: number;
  notes: { id: string; title: string }[];
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface TutorSession {
  selection_ids?: string[];
  id: string;
  title: string;
  mode: TutorMode;
  note_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface TutorHistoryItem extends TutorSession {
  matchSnippet?: string;
}

export interface TutorHistoryPage {
  items: TutorHistoryItem[];
  nextCursor: string | null;
}

export interface TutorMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

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

export interface ActiveModelCapability {
  providerId: string;
  providerName: string;
  model: string;
  supportsVision: boolean;
  configured: boolean;
}

export interface AISettings {
  activeProviderId: string;
  providers: AIProviderConfig[];
  dailyGoalMinutes: number;
  dailyReviewTarget: number;
  activeCapability?: ActiveModelCapability;
}

export interface DashboardData {
  stats: {
    totalNotes: number;
    summarizedNotes: number;
    totalFlashcards: number;
    dueFlashcards: number;
    totalMistakes: number;
    activeMistakes: number;
    dueMistakes: number;
    totalDueReviews: number;
    totalQuizzes: number;
    avgAccuracy: number | null;
    todayActions: number;
    streak: number;
  };
  heatmap: { date: string; count: number }[];
  quizTrend: { date: string; accuracy: number }[];
  subjectMastery: {
    id: string; name: string; color: string; note_count: number;
    mastery: number | null; concept_count: number; tested_count: number;
  }[];
  weakConcepts: StudyConcept[];
  untestedConcepts: Pick<StudyConcept, 'id' | 'name'>[];
  untestedCount: number;
  todayProgress: TodayProgress;
  recentNotes: {
    id: string;
    title: string;
    source_type: string;
    updated_at: string;
    has_summary: number;
    category_name?: string;
    category_color?: string;
  }[];
}
