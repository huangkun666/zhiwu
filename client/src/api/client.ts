import { Capacitor } from '@capacitor/core';
import { localApi } from './localEngine';
import type {
  AISettings,
  AIProviderConfig,
  Category,
  DashboardData,
  Flashcard,
  GraphLink,
  GraphNode,
  Mistake,
  Note,
  Quiz,
  ReviewQueueItem,
  Synthesis,
  TutorMessage,
  TutorSession,
} from '../types';

export const IS_STANDALONE_MODE =
  Capacitor.isNativePlatform() || import.meta.env.VITE_STANDALONE === 'true';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: options?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `请求失败 (${res.status})`);
  }
  return data as T;
}

const serverApi = {
  getDashboard: () => request<DashboardData>('/api/dashboard'),
  seedSampleData: () => request<{ ok: boolean; notesCreated: number }>('/api/dashboard/seed', { method: 'POST' }),

  getCategories: () => request<Category[]>('/api/categories'),
  createCategory: (payload: { name: string; color?: string; description?: string }) =>
    request<Category>('/api/categories', { method: 'POST', body: JSON.stringify(payload) }),
  deleteCategory: (id: string) => request<{ ok: boolean }>(`/api/categories/${id}`, { method: 'DELETE' }),

  getNotes: (params?: { q?: string; categoryId?: string; tag?: string; sourceType?: string; hasSummary?: string }) => {
    const sp = new URLSearchParams();
    if (params?.q) sp.set('q', params.q);
    if (params?.categoryId) sp.set('categoryId', params.categoryId);
    if (params?.tag) sp.set('tag', params.tag);
    if (params?.sourceType) sp.set('sourceType', params.sourceType);
    if (params?.hasSummary) sp.set('hasSummary', params.hasSummary);
    const qs = sp.toString();
    return request<Note[]>(`/api/notes${qs ? `?${qs}` : ''}`);
  },
  getNote: (id: string) => request<Note>(`/api/notes/${id}`),
  getTags: () => request<{ name: string; count: number }[]>('/api/notes/meta/tags'),
  createNote: (payload: { title: string; content: string; categoryId?: string | null; tags?: string[]; sourceType?: string }) =>
    request<Note>('/api/notes', { method: 'POST', body: JSON.stringify(payload) }),
  updateNote: (
    id: string,
    payload: { title?: string; content?: string; categoryId?: string | null; tags?: string[]; isPinned?: boolean }
  ) => request<Note>(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteNote: (id: string) => request<{ ok: boolean }>(`/api/notes/${id}`, { method: 'DELETE' }),
  importFiles: (files: File[], categoryId?: string | null, tags?: string[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    if (categoryId) fd.append('categoryId', categoryId);
    if (tags && tags.length) fd.append('tags', JSON.stringify(tags));
    return request<{ imported: Note[]; warnings: string[] }>('/api/notes/import', { method: 'POST', body: fd });
  },
  rerunOcr: (id: string) => request<Note>(`/api/notes/${id}/ocr`, { method: 'POST' }),
  summarizeNote: (id: string, applyMeta = true) =>
    request<Note>(`/api/notes/${id}/summarize`, { method: 'POST', body: JSON.stringify({ applyMeta }) }),
  synthesizeNotes: (payload: { noteIds?: string[]; categoryId?: string | null; title?: string }) =>
    request<Synthesis>('/api/notes/synthesize', { method: 'POST', body: JSON.stringify(payload) }),
  getSyntheses: () => request<Synthesis[]>('/api/notes/syntheses/list'),
  deleteSynthesis: (id: string) => request<{ ok: boolean }>(`/api/notes/syntheses/${id}`, { method: 'DELETE' }),

  getQuizzes: () => request<Quiz[]>('/api/quizzes'),
  getQuiz: (id: string) => request<Quiz>(`/api/quizzes/${id}`),
  generateQuiz: (payload: {
    noteIds?: string[];
    categoryId?: string | null;
    weakOnly?: boolean;
    focusConcepts?: string[];
    count?: number;
    difficulty?: 'easy' | 'medium' | 'hard';
    types?: ('single' | 'multiple' | 'boolean' | 'short')[];
    title?: string;
  }) => request<Quiz>('/api/quizzes/generate', { method: 'POST', body: JSON.stringify(payload) }),
  submitQuiz: (id: string, answers: Record<string, string>) =>
    request<Quiz>(`/api/quizzes/${id}/submit`, { method: 'POST', body: JSON.stringify({ answers }) }),
  deleteQuiz: (id: string) => request<{ ok: boolean }>(`/api/quizzes/${id}`, { method: 'DELETE' }),

  getMistakes: (params?: { status?: string; concept?: string; dueOnly?: boolean }) => {
    const sp = new URLSearchParams();
    if (params?.status) sp.set('status', params.status);
    if (params?.concept) sp.set('concept', params.concept);
    if (params?.dueOnly) sp.set('dueOnly', 'true');
    const qs = sp.toString();
    return request<Mistake[]>(`/api/mistakes${qs ? `?${qs}` : ''}`);
  },
  bookmarkMistake: (questionId: string) =>
    request<Mistake>('/api/mistakes/bookmark', { method: 'POST', body: JSON.stringify({ questionId }) }),
  updateMistake: (id: string, payload: { userReflection?: string; status?: string }) =>
    request<Mistake>(`/api/mistakes/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  diagnoseMistake: (id: string) => request<Mistake>(`/api/mistakes/${id}/diagnose`, { method: 'POST' }),
  generateVariant: (id: string) =>
    request<{
      conceptName: string;
      type: 'single' | 'multiple' | 'boolean' | 'short';
      stem: string;
      options: string[];
      correctAnswer: string;
      explanation: string;
      memoryTip: string;
    }>(`/api/mistakes/${id}/variant`, { method: 'POST' }),
  reviewMistake: (id: string, rating: 1 | 2 | 3 | 4) =>
    request<{ mistake: Mistake; nextLabel: string }>(`/api/mistakes/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ rating }),
    }),
  deleteMistake: (id: string) => request<{ ok: boolean }>(`/api/mistakes/${id}`, { method: 'DELETE' }),

  getFlashcards: (params?: { noteId?: string; dueOnly?: boolean }) => {
    const sp = new URLSearchParams();
    if (params?.noteId) sp.set('noteId', params.noteId);
    if (params?.dueOnly) sp.set('dueOnly', 'true');
    const qs = sp.toString();
    return request<Flashcard[]>(`/api/flashcards${qs ? `?${qs}` : ''}`);
  },
  getReviewQueue: () =>
    request<{ totalDue: number; dueCardsCount: number; dueMistakesCount: number; items: ReviewQueueItem[] }>(
      '/api/flashcards/queue'
    ),
  createFlashcard: (payload: { front: string; back: string; hint?: string; noteId?: string | null; conceptName?: string }) =>
    request<Flashcard>('/api/flashcards', { method: 'POST', body: JSON.stringify(payload) }),
  generateFlashcards: (noteId: string, count = 6) =>
    request<{ count: number; cards: Flashcard[] }>('/api/flashcards/generate', {
      method: 'POST',
      body: JSON.stringify({ noteId, count }),
    }),
  reviewFlashcard: (id: string, rating: 1 | 2 | 3 | 4) =>
    request<{ card: Flashcard; nextLabel: string }>(`/api/flashcards/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ rating }),
    }),
  deleteFlashcard: (id: string) => request<{ ok: boolean }>(`/api/flashcards/${id}`, { method: 'DELETE' }),

  getGraph: () => request<{ nodes: GraphNode[]; links: GraphLink[]; weakConcepts: GraphNode[] }>('/api/graph'),

  getTutorSessions: () => request<TutorSession[]>('/api/tutor/sessions'),
  createTutorSession: (payload: { title?: string; mode: 'qa' | 'feynman'; noteIds?: string[]; initialPrompt?: string }) =>
    request<TutorSession>('/api/tutor/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  getTutorMessages: (sessionId: string) =>
    request<{ session: TutorSession; messages: TutorMessage[] }>(`/api/tutor/sessions/${sessionId}/messages`),
  sendTutorMessage: (sessionId: string, payload: { message: string; noteIds?: string[]; mode?: 'qa' | 'feynman' }) =>
    request<{ userMessage: TutorMessage; assistantMessage: TutorMessage }>(`/api/tutor/sessions/${sessionId}/chat`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  sendTutorMessageStream: async (
    sessionId: string,
    payload: { message: string; noteIds?: string[]; mode?: 'qa' | 'feynman' },
    onDelta: (delta: string) => void
  ): Promise<{ userMessage: TutorMessage; assistantMessage: TutorMessage }> => {
    const res = await fetch(`/api/tutor/sessions/${sessionId}/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      return serverApi.sendTutorMessage(sessionId, payload);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: { userMessage: TutorMessage; assistantMessage: TutorMessage } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.error) throw new Error(evt.error);
          if (evt.delta) onDelta(evt.delta);
          if (evt.done && evt.userMessage && evt.assistantMessage) {
            finalResult = { userMessage: evt.userMessage, assistantMessage: evt.assistantMessage };
          }
        } catch (err: any) {
          if (err?.message && !err.message.includes('JSON')) throw err;
        }
      }
    }
    if (!finalResult) throw new Error('流式响应中断，请重试。');
    return finalResult;
  },
  deleteTutorSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/tutor/sessions/${sessionId}`, { method: 'DELETE' }),

  getSettings: () => request<AISettings>('/api/settings'),
  saveSettings: (settings: AISettings) =>
    request<AISettings>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  testAI: (provider: AIProviderConfig) =>
    request<{ ok: boolean; latencyMs: number; reply: string }>('/api/settings/test-ai', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
  getNetworkInfo: (port?: string, ip?: string) => {
    const sp = new URLSearchParams();
    if (port) sp.set('port', port);
    if (ip) sp.set('ip', ip);
    const qs = sp.toString();
    return request<{
      adapters?: { name: string; address: string; isVirtual: boolean }[];
      ips: string[];
      primaryIp: string;
      port: string;
      mobileUrl: string;
      qrDataUrl: string;
    }>(`/api/settings/network${qs ? `?${qs}` : ''}`);
  },
  exportJsonBackup: async (): Promise<string> => {
    const data = await request<any>('/api/settings/export-json');
    return JSON.stringify(data, null, 2);
  },
  importJsonBackup: async (jsonText: string): Promise<{ ok: boolean; notesCount: number }> => {
    const parsed = JSON.parse(jsonText);
    return request<{ ok: boolean; notesCount: number }>('/api/settings/import-json', {
      method: 'POST',
      body: JSON.stringify(parsed),
    });
  },
};

export const api = IS_STANDALONE_MODE ? localApi : serverApi;
