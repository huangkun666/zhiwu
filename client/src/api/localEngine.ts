import type {
  ActiveModelCapability,
  AIProviderConfig,
  AISettings,
  Category,
  DashboardData,
  Flashcard,
  GraphLink,
  GraphNode,
  Mistake,
  Note,
  NoteSummary,
  Quiz,
  QuizQuestion,
  ReviewQueueItem,
  Synthesis,
  TutorMessage,
  TutorSession,
} from '../types';

// --- IndexedDB Persistence (handles large notes & images on Android without 5MB localStorage limit) ---
const IDB_NAME = 'zhiwu_on_device_db';
const IDB_STORE = 'kv';
const STATE_KEY = 'zhiwu_state_v1';

interface ConceptRecord {
  id: string;
  name: string;
  description: string;
  category_id: string | null;
  mastery_score: number;
  quiz_attempts: number;
  quiz_correct: number;
  note_ids: string[];
  created_at: string;
}

interface StudyLogRecord {
  id: string;
  activity_type: string;
  entity_id: string | null;
  score: number | null;
  duration_seconds: number;
  created_at: string;
  date_key: string;
}

interface LocalDBState {
  settings: AISettings;
  categories: Category[];
  notes: Note[];
  syntheses: Synthesis[];
  concepts: ConceptRecord[];
  conceptLinks: GraphLink[];
  quizzes: Quiz[];
  mistakes: Mistake[];
  flashcards: Flashcard[];
  tutorSessions: TutorSession[];
  tutorMessages: Record<string, TutorMessage[]>;
  studyLogs: StudyLogRecord[];
}

const DEFAULT_PROVIDERS: AIProviderConfig[] = [
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
];

function normalizeLocalSettings(settings: AISettings): AISettings {
  const raw = Array.isArray(settings?.providers) ? (settings.providers as any[]) : [];
  const existingRemote = raw.find((p) => p.id === 'remote');
  const existingLocal = raw.find((p) => p.id === 'local');
  if (existingRemote && existingLocal) {
    return {
      ...settings,
      activeProviderId: settings.activeProviderId === 'local' ? 'local' : 'remote',
      providers: [
        { ...DEFAULT_PROVIDERS[0], ...existingRemote, id: 'remote', name: '远程模型', requiresKey: true },
        { ...DEFAULT_PROVIDERS[1], ...existingLocal, id: 'local', name: '本地模型', requiresKey: false },
      ],
    };
  }
  const legacyActive = raw.find((p) => p.id === settings.activeProviderId);
  const legacyRemote =
    (legacyActive && legacyActive.id !== 'ollama' ? legacyActive : null) ||
    raw.find((p) => p.id !== 'ollama' && p.apiKey?.trim()) ||
    raw.find((p) => p.id !== 'ollama');
  const legacyLocal = raw.find((p) => p.id === 'ollama');
  return {
    ...settings,
    activeProviderId: settings.activeProviderId === 'ollama' || settings.activeProviderId === 'local' ? 'local' : 'remote',
    providers: [
      legacyRemote
        ? {
            id: 'remote',
            name: '远程模型',
            type: legacyRemote.type === 'gemini' ? 'gemini' : 'openai',
            baseUrl: legacyRemote.baseUrl || DEFAULT_PROVIDERS[0].baseUrl,
            apiKey: legacyRemote.apiKey || '',
            model: legacyRemote.model || DEFAULT_PROVIDERS[0].model,
            supportsVision: Boolean(legacyRemote.supportsVision),
            requiresKey: true,
          }
        : DEFAULT_PROVIDERS[0],
      legacyLocal
        ? {
            id: 'local',
            name: '本地模型',
            type: 'openai',
            baseUrl: legacyLocal.baseUrl || DEFAULT_PROVIDERS[1].baseUrl,
            apiKey: legacyLocal.apiKey || 'ollama',
            model: legacyLocal.model || DEFAULT_PROVIDERS[1].model,
            supportsVision: Boolean(legacyLocal.supportsVision),
            requiresKey: false,
          }
        : DEFAULT_PROVIDERS[1],
    ],
  };
}

function createEmptyState(): LocalDBState {
  return {
    settings: {
      activeProviderId: 'remote',
      providers: DEFAULT_PROVIDERS,
      dailyGoalMinutes: 30,
      dailyReviewTarget: 20,
    },
    categories: [],
    notes: [],
    syntheses: [],
    concepts: [],
    conceptLinks: [],
    quizzes: [],
    mistakes: [],
    flashcards: [],
    tutorSessions: [],
    tutorMessages: {},
    studyLogs: [],
  };
}

let cachedState: LocalDBState | null = null;

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadState(): Promise<LocalDBState> {
  if (cachedState) return cachedState;
  try {
    const db = await openIDB();
    const saved = await new Promise<LocalDBState | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(STATE_KEY);
      req.onsuccess = () => resolve(req.result as LocalDBState | undefined);
      req.onerror = () => reject(req.error);
    });
    if (saved) {
      const merged = { ...createEmptyState(), ...saved };
      merged.settings = normalizeLocalSettings(merged.settings);
      cachedState = merged;
      return cachedState;
    }
  } catch {
    // fallback to localStorage
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const merged = { ...createEmptyState(), ...JSON.parse(raw) };
        merged.settings = normalizeLocalSettings(merged.settings);
        cachedState = merged;
        return cachedState!;
      }
    } catch {
      // ignore
    }
  }
  cachedState = createEmptyState();
  return cachedState;
}

async function saveState(state: LocalDBState): Promise<void> {
  cachedState = state;
  try {
    const db = await openIDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(state, STATE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota error
    }
  }
}

// --- Helpers ---
function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function countWords(text: string): number {
  const cleaned = text.replace(/[#*`>\-\[\]()!]/g, ' ').trim();
  if (!cleaned) return 0;
  const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonCjk = cleaned.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + nonCjk;
}

function computeSM2(
  state: { easeFactor: number; intervalDays: number; repetitions: number },
  rating: 1 | 2 | 3 | 4
) {
  let ef = Math.max(1.3, state.easeFactor || 2.5);
  let interval = Math.max(0, state.intervalDays || 0);
  let reps = Math.max(0, state.repetitions || 0);
  const now = Date.now();
  let nextMs: number;
  let label: string;

  if (rating === 1) {
    reps = 0;
    interval = 0;
    ef = Math.max(1.3, ef - 0.2);
    nextMs = now + 10 * 60 * 1000;
    label = '10分钟后';
  } else if (rating === 2) {
    interval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    reps += 1;
    ef = Math.max(1.3, ef - 0.15);
    nextMs = now + interval * 86400 * 1000;
    label = `${interval}天后`;
  } else if (rating === 3) {
    interval = reps === 0 ? 1 : reps === 1 ? 4 : Math.max(1, Math.round(interval * ef));
    reps += 1;
    nextMs = now + interval * 86400 * 1000;
    label = `${interval}天后`;
  } else {
    interval = reps === 0 ? 4 : reps === 1 ? 7 : Math.max(2, Math.round(interval * ef * 1.3));
    reps += 1;
    ef = Math.min(3.2, ef + 0.15);
    nextMs = now + interval * 86400 * 1000;
    label = `${interval}天后`;
  }

  return {
    easeFactor: Number(ef.toFixed(2)),
    intervalDays: interval,
    repetitions: reps,
    nextReviewAt: new Date(nextMs).toISOString(),
    label,
  };
}

function previewIntervals(easeFactor: number, intervalDays: number, repetitions: number): Record<1 | 2 | 3 | 4, string> {
  const s = { easeFactor, intervalDays, repetitions };
  return {
    1: computeSM2(s, 1).label,
    2: computeSM2(s, 2).label,
    3: computeSM2(s, 3).label,
    4: computeSM2(s, 4).label,
  };
}

function logStudy(state: LocalDBState, activityType: string, entityId: string | null = null, score: number | null = null) {
  state.studyLogs.push({
    id: uid(),
    activity_type: activityType,
    entity_id: entityId,
    score,
    duration_seconds: 30,
    created_at: nowIso(),
    date_key: todayKey(),
  });
}

function upsertConcept(state: LocalDBState, name: string, description = '', categoryId: string | null = null, noteId: string | null = null): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  let c = state.concepts.find((x) => x.name === trimmed);
  if (!c) {
    c = {
      id: uid(),
      name: trimmed,
      description,
      category_id: categoryId,
      mastery_score: 0.5,
      quiz_attempts: 0,
      quiz_correct: 0,
      note_ids: noteId ? [noteId] : [],
      created_at: nowIso(),
    };
    state.concepts.push(c);
  } else {
    if (description && !c.description) c.description = description;
    if (categoryId && !c.category_id) c.category_id = categoryId;
    if (noteId && !c.note_ids.includes(noteId)) c.note_ids.push(noteId);
  }
  return c.id;
}

function updateConceptMastery(state: LocalDBState, name: string, isCorrect: boolean, categoryId: string | null = null) {
  const id = upsertConcept(state, name, '', categoryId);
  const c = state.concepts.find((x) => x.id === id);
  if (!c) return;
  c.quiz_attempts += 1;
  if (isCorrect) c.quiz_correct += 1;
  c.mastery_score = Number(((c.quiz_correct + 0.5) / (c.quiz_attempts + 1)).toFixed(3));
}

// --- Direct On-Device AI Client (works directly from Android APK via CapacitorHttp) ---
function getActiveCapability(settings: AISettings): ActiveModelCapability {
  const p = settings.providers.find((x) => x.id === settings.activeProviderId) || settings.providers[0];
  if (!p) {
    return { providerId: '', providerName: '未配置', model: '', supportsVision: false, configured: false };
  }
  return {
    providerId: p.id,
    providerName: p.name,
    model: p.model,
    supportsVision: Boolean(p.supportsVision),
    configured: p.requiresKey === false || Boolean(p.apiKey?.trim()),
  };
}

function requireActiveProvider(settings: AISettings, override?: AIProviderConfig): AIProviderConfig {
  const p = override || settings.providers.find((x) => x.id === settings.activeProviderId) || settings.providers[0];
  if (!p) throw new Error('尚未配置 AI 模型，请前往「设置」添加。');
  if (p.requiresKey !== false && !p.apiKey?.trim()) {
    throw new Error(`当前模型「${p.name}」未填写 API Key，请前往「设置」填写后再试。`);
  }
  if (!p.model?.trim()) {
    throw new Error(`当前模型「${p.name}」未填写模型名称，请前往「设置」补全。`);
  }
  return p;
}

function extractJson<T = any>(raw: string): T {
  const cleaned = raw.trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) return JSON.parse(fence[1].trim()) as T;
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) return JSON.parse(cleaned.slice(first, last + 1)) as T;
    const fa = cleaned.indexOf('[');
    const la = cleaned.lastIndexOf(']');
    if (fa !== -1 && la > fa) return JSON.parse(cleaned.slice(fa, la + 1)) as T;
    throw new Error('AI 返回格式未能解析为 JSON，请重试。');
  }
}

async function callLLMDirect(
  provider: AIProviderConfig,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts: { temperature?: number; jsonMode?: boolean; maxTokens?: number } = {}
): Promise<string> {
  const temperature = opts.temperature ?? 0.4;
  if (provider.type === 'gemini') {
    const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const body: any = {
      contents,
      generationConfig: {
        temperature,
        ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gemini 请求失败 (${res.status}): ${(await res.text().catch(() => '')).slice(0, 240)}`);
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '').trim();
  }

  const base = provider.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const body: any = { model: provider.model, messages, temperature };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (opts.jsonMode && res.status === 400 && errText.toLowerCase().includes('response_format')) {
      delete body.response_format;
      const retry = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (retry.ok) {
        const d = await retry.json();
        return String(d?.choices?.[0]?.message?.content || '').trim();
      }
    }
    throw new Error(`模型请求失败 (${res.status}): ${errText.slice(0, 240)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content;
  if (!content) throw new Error('模型返回了空内容，请检查模型名称或配额。');
  return String(content).trim();
}

function stripInlineImages(content: string): string {
  return (content || '')
    .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)\s*(?:---\s*)?/gi, '')
    .replace(/!\[[^\]]*\]\(\/uploads\/[^)]+\)\s*(?:---\s*)?/gi, '')
    .trim();
}

function cleanOcrMarkdown(raw: string): string {
  return (raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:small|span|div|font|u|center)[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractSmartTitle(markdown: string, fallbackName: string): string {
  const h1 = markdown.match(/^#{1,3}\s+(.+)$/m);
  if (h1?.[1]?.trim()) return h1[1].replace(/[*`]/g, '').trim().slice(0, 48);
  const firstLine = markdown
    .split('\n')
    .map((l) => l.replace(/^[-*>\d.\s]+/, '').replace(/[*`]/g, '').trim())
    .find((l) => l.length >= 4 && !l.startsWith('|') && !l.startsWith('!'));
  return firstLine ? firstLine.slice(0, 42) : fallbackName;
}

async function callVisionDirect(provider: AIProviderConfig, base64: string, mimeType: string): Promise<string> {
  if (!provider.supportsVision) {
    throw new Error(`当前模型「${provider.name} (${provider.model})」不支持视觉/图片输入，无法上传图片笔记。请在「设置」中切换支持多模态视觉的模型。`);
  }
  const prompt = `你是严谨的学术笔记整理助手。请精准识别这张图片中的所有文字、标题、列表、表格和数学公式，整理为清晰结构化的纯 Markdown 笔记。
要求：
1. 第一行用一级标题 # 概括核心主题；
2. 忠实还原原图文字与表格，数学公式用 $...$ 或 $$...$$；
3. 禁止输出 <small>、<div>、<br>、<span> 等任何 HTML 标签，全部使用纯 Markdown；
4. 直接输出整理后的 Markdown 正文。`;
  if (provider.type === 'gemini') {
    const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
      }),
    });
    if (!res.ok) throw new Error(`视觉识别失败 (${res.status}): ${(await res.text().catch(() => '')).slice(0, 220)}`);
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '').trim();
  }

  const base = provider.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    throw new Error(`当前模型无法处理图片输入 (${res.status})，请确认其支持多模态视觉：${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content;
  if (!content) throw new Error('模型返回了空内容，请检查模型名称或配额。');
  return String(content).trim();
}

// --- On-Device File Parsing (.md, .txt, .docx, .pdf, image) ---
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.includes(',') ? s.split(',')[1] : s);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function parseFileOnDevice(file: File, settings: AISettings): Promise<{
  title: string;
  content: string;
  sourceType: Note['source_type'];
  attachmentDataUrl?: string;
}> {
  const name = file.name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  const baseTitle = name.replace(/\.[^.]+$/, '') || '未命名笔记';

  if (ext === '.md' || ext === '.markdown' || ext === '.txt' || file.type.startsWith('text/')) {
    const text = await file.text();
    const h1 = text.match(/^#\s+(.+)$/m);
    return { title: h1 ? h1[1].trim() : baseTitle, content: text.trim(), sourceType: ext === '.txt' ? 'text' : 'markdown' };
  }

  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const arrayBuffer = await file.arrayBuffer();
    const res = await mammoth.extractRawText({ arrayBuffer });
    return { title: baseTitle, content: (res.value || '').trim() || `> 已导入 Word 文档：\`${name}\``, sourceType: 'docx' };
  }

  if (ext === '.pdf' || file.type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist');
    // Disable external worker requirement on Android WebView for maximum offline reliability
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer), useWorkerFetch: false });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 60); i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it: any) => it.str || '').join(' '));
    }
    const text = pages.join('\n\n').trim();
    return {
      title: baseTitle,
      content: text ? `> 来源 PDF：\`${name}\`（共 ${pdf.numPages} 页）\n\n${text}` : `> 来源 PDF：\`${name}\`（未提取到纯文本，可能为扫描版 PDF）`,
      sourceType: 'pdf',
    };
  }

  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(ext)) {
    const rawProvider = settings.providers.find((x) => x.id === settings.activeProviderId) || settings.providers[0];
    if (!rawProvider || !rawProvider.supportsVision) {
      throw new Error(
        `当前模型「${rawProvider?.name || '未配置'} (${rawProvider?.model || ''})」不支持视觉/图片输入，无法上传图片笔记。请在「设置」中切换到支持视觉的多模态模型并开启「支持视觉输入」。`
      );
    }
    const provider = requireActiveProvider(settings);
    const base64 = await fileToBase64(file);
    const mime = file.type.startsWith('image/') ? file.type : 'image/jpeg';
    const ocrText = cleanOcrMarkdown(await callVisionDirect(provider, base64, mime));
    const dataUrl = `data:${mime};base64,${base64}`;
    // Store ONLY pure recognized Markdown in content (keep base64 image cleanly in attachment_path so AI slicing never chops off the text!)
    return {
      title: extractSmartTitle(ocrText, baseTitle),
      content: ocrText,
      sourceType: 'image',
      attachmentDataUrl: dataUrl,
    };
  }

  return { title: baseTitle, content: await file.text(), sourceType: 'text' };
}

function enrichNote(state: LocalDBState, n: Note): Note {
  const cat = state.categories.find((c) => c.id === n.category_id);
  return { ...n, category_name: cat?.name || null, category_color: cat?.color || null };
}

function normalizeChoiceAnswer(ans: string): string {
  return ans.toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join(',');
}

// --- Complete Local API Implementation (100% parity with Express server) ---
export const localApi = {
  async getDashboard(): Promise<DashboardData> {
    const s = await loadState();
    const now = nowIso();
    const today = todayKey();
    const dueFlashcards = s.flashcards.filter((f) => f.next_review_at <= now).length;
    const activeMistakes = s.mistakes.filter((m) => m.status !== 'mastered').length;
    const dueMistakes = s.mistakes.filter((m) => m.status !== 'mastered' && m.next_review_at <= now).length;
    const completedQuizzes = s.quizzes.filter((q) => q.status === 'completed' && q.score !== null);
    const avgAccuracy =
      completedQuizzes.length > 0
        ? Math.round((completedQuizzes.reduce((acc, q) => acc + (q.score || 0), 0) / completedQuizzes.length) * 100)
        : null;

    const heatMap: Record<string, number> = {};
    for (const l of s.studyLogs) heatMap[l.date_key] = (heatMap[l.date_key] || 0) + 1;
    const heatmap: { date: string; count: number }[] = [];
    for (let i = 111; i >= 0; i--) {
      const dk = todayKey(new Date(Date.now() - i * 86400 * 1000));
      heatmap.push({ date: dk, count: heatMap[dk] || 0 });
    }
    let streak = 0;
    for (let i = 0; i < 112; i++) {
      const dk = todayKey(new Date(Date.now() - i * 86400 * 1000));
      if ((heatMap[dk] || 0) > 0) streak++;
      else if (i > 0) break;
    }

    // Quiz trend by date
    const trendMap: Record<string, number[]> = {};
    for (const l of s.studyLogs) {
      if (l.activity_type === 'quiz_complete' && l.score !== null) {
        (trendMap[l.date_key] ||= []).push(l.score * 100);
      }
    }
    const quizTrend = Object.entries(trendMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-10)
      .map(([date, arr]) => ({ date, accuracy: Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) }));

    const subjectMastery = s.categories.map((cat) => {
      const noteCount = s.notes.filter((n) => n.category_id === cat.id).length;
      const cons = s.concepts.filter((c) => c.category_id === cat.id);
      const mastery = cons.length
        ? Math.round((cons.reduce((a, b) => a + b.mastery_score, 0) / cons.length) * 100)
        : 50;
      return { id: cat.id, name: cat.name, color: cat.color, note_count: noteCount, mastery };
    });

    const weakConcepts = [...s.concepts]
      .sort((a, b) => a.mastery_score - b.mastery_score)
      .slice(0, 5)
      .map((c) => ({
        id: c.id,
        name: c.name,
        mastery_score: c.mastery_score,
        quiz_attempts: c.quiz_attempts,
        quiz_correct: c.quiz_correct,
      }));

    const recentNotes = [...s.notes]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 5)
      .map((n) => {
        const en = enrichNote(s, n);
        return {
          id: n.id,
          title: n.title,
          source_type: n.source_type,
          updated_at: n.updated_at,
          has_summary: n.summary ? 1 : 0,
          category_name: en.category_name || undefined,
          category_color: en.category_color || undefined,
        };
      });

    return {
      stats: {
        totalNotes: s.notes.length,
        summarizedNotes: s.notes.filter((n) => Boolean(n.summary)).length,
        totalFlashcards: s.flashcards.length,
        dueFlashcards,
        totalMistakes: s.mistakes.length,
        activeMistakes,
        dueMistakes,
        totalDueReviews: dueFlashcards + dueMistakes,
        totalQuizzes: completedQuizzes.length,
        avgAccuracy,
        todayActions: heatMap[today] || 0,
        streak,
      },
      heatmap,
      quizTrend,
      subjectMastery,
      weakConcepts,
      recentNotes,
    };
  },

  async seedSampleData() {
    const s = await loadState();
    if (s.notes.length > 0) throw new Error('当前笔记库已有内容，仅支持在空库时加载示例数据。');
    const now = nowIso();
    const catCs: Category = { id: uid(), name: '计算机科学', color: '#3B5BDB', icon: 'cpu', created_at: now };
    const catCog: Category = { id: uid(), name: '认知与学习法', color: '#0F766E', icon: 'brain', created_at: now };
    s.categories.push(catCs, catCog);

    const n1: Note = {
      id: uid(),
      title: 'TCP 三次握手与四次挥手核心原理',
      content: `# TCP 三次握手与四次挥手\n\n## 1. 为什么需要三次握手？\n1. 确认双方收发能力正常；\n2. 同步初始序列号 ISN，防止历史失效 SYN 占用资源。\n\n## 2. TIME_WAIT 等待 2MSL\n保证最后一个 ACK 可靠送达，并让旧连接滞留报文自然消逝。`,
      summary: {
        abstract: '系统梳理 TCP 三次握手建立连接与四次挥手断开连接的底层机制及 TIME_WAIT 等待 2MSL 原因。',
        keyPoints: ['三次握手确认双向收发能力并同步 ISN', '全双工决定断开需要四次挥手', '主动关闭方进入 TIME_WAIT 等待 2MSL'],
        concepts: [
          { name: '三次握手', definition: 'TCP 建立可靠连接并同步双方序列号的三步过程' },
          { name: 'TIME_WAIT', definition: '主动关闭方发出最后 ACK 后等待 2MSL 的保护状态' },
        ],
        outline: ['1. 三次握手', '2. TIME_WAIT 与 2MSL'],
        difficulty: '进阶',
      },
      category_id: catCs.id,
      tags: ['计算机网络', 'TCP'],
      source_type: 'markdown',
      word_count: 145,
      is_pinned: true,
      created_at: now,
      updated_at: now,
    };

    const n2: Note = {
      id: uid(),
      title: '间隔重复（SM-2）与费曼学习法',
      content: `# 间隔重复与费曼学习法\n\n- **主动回忆**远胜被动重读，打破熟练度错觉。\n- **SM-2 算法**按难度因子 $EF$ 动态延长复习间隔。\n- **费曼技巧**通过用大白话教给别人来暴露理解盲区。`,
      summary: {
        abstract: '结合费曼学习法打通理解层，结合 SM-2 间隔重复锁死长期记忆层。',
        keyPoints: ['主动提取对抗熟练度错觉', '费曼技巧定位盲区', 'SM-2 遗忘曲线精准复习'],
        concepts: [
          { name: '主动回忆', definition: '合上材料主动提取知识以强化长期记忆' },
          { name: '费曼学习法', definition: '以教代学发现理解漏洞的深度学习方法' },
        ],
        outline: ['1. 主动回忆', '2. 费曼与 SM-2 协同'],
        difficulty: '基础',
      },
      category_id: catCog.id,
      tags: ['学习科学', '间隔重复'],
      source_type: 'markdown',
      word_count: 112,
      is_pinned: false,
      created_at: now,
      updated_at: now,
    };

    s.notes.push(n1, n2);
    const c1 = upsertConcept(s, '三次握手', 'TCP 建立可靠连接的三步过程', catCs.id, n1.id);
    const c2 = upsertConcept(s, 'TIME_WAIT', '主动关闭方等待 2MSL 的保护状态', catCs.id, n1.id);
    const c3 = upsertConcept(s, '主动回忆', '主动提取知识强化长期记忆', catCog.id, n2.id);
    const c4 = upsertConcept(s, '费曼学习法', '以教代学发现盲区', catCog.id, n2.id);
    s.conceptLinks.push(
      { id: uid(), source: c1, target: c2, relation: '同属TCP', weight: 1 },
      { id: uid(), source: c3, target: c4, relation: '协同强化', weight: 1 }
    );
    const tw = s.concepts.find((x) => x.id === c2);
    if (tw) {
      tw.mastery_score = 0.35;
      tw.quiz_attempts = 3;
      tw.quiz_correct = 1;
    }

    s.flashcards.push({
      id: uid(),
      note_id: n1.id,
      category_id: catCs.id,
      concept_name: 'TIME_WAIT',
      front: 'TCP 四次挥手中，主动关闭方为什么必须进入 TIME_WAIT 状态并等待 2MSL？',
      back: '1. 确保最后一个 ACK 到达对端（若丢失可响应重传 FIN）；\n2. 让旧连接滞留报文消逝，避免干扰后续新连接。',
      hint: '从「最后ACK可靠性」和「旧报文消逝」思考',
      ease_factor: 2.5,
      interval_days: 0,
      repetitions: 0,
      next_review_at: now,
      created_at: now,
    });

    s.mistakes.push({
      id: uid(),
      note_id: n1.id,
      note_title: n1.title,
      concept_name: 'TIME_WAIT',
      type: 'single',
      stem: '关于 TCP 断开连接时的 TIME_WAIT 状态，以下说法最准确的是？',
      options: [
        'A. 双方在四次挥手后都会进入 TIME_WAIT',
        'B. 只需等待 1MSL 即可',
        'C. 主动关闭方进入 TIME_WAIT 并等待 2MSL，防止最后 ACK 丢失及旧包滞留',
        'D. 设为 0 可以消除所有网络延迟',
      ],
      correct_answer: 'C',
      wrong_answer: 'B',
      explanation: '只有主动关闭方进入 TIME_WAIT 并等待 2MSL（一来一回最大报文生存时间）。',
      ai_diagnosis: '记住「一去一回 = 2MSL，谁先主动说再见，谁就负责殿后等 2MSL」。',
      user_reflection: '',
      status: 'unmastered',
      wrong_count: 1,
      ease_factor: 2.5,
      interval_days: 1,
      repetitions: 0,
      next_review_at: now,
      created_at: now,
    });

    logStudy(s, 'note_import', n1.id);
    await saveState(s);
    return { ok: true, notesCreated: 2 };
  },

  async getCategories(): Promise<Category[]> {
    const s = await loadState();
    return s.categories.map((c) => ({
      ...c,
      note_count: s.notes.filter((n) => n.category_id === c.id).length,
    }));
  },

  async createCategory(payload: { name: string; color?: string; description?: string }): Promise<Category> {
    const s = await loadState();
    const c: Category = {
      id: uid(),
      name: payload.name.trim(),
      color: payload.color || '#3B5BDB',
      icon: 'folder',
      description: payload.description || '',
      note_count: 0,
      created_at: nowIso(),
    };
    s.categories.push(c);
    await saveState(s);
    return c;
  },

  async deleteCategory(id: string) {
    const s = await loadState();
    s.categories = s.categories.filter((c) => c.id !== id);
    s.notes.forEach((n) => {
      if (n.category_id === id) n.category_id = null;
    });
    await saveState(s);
    return { ok: true };
  },

  async getNotes(params?: { q?: string; categoryId?: string; tag?: string; sourceType?: string; hasSummary?: string }): Promise<Note[]> {
    const s = await loadState();
    let list = s.notes.map((n) => enrichNote(s, n));
    if (params?.q) {
      const q = params.q.toLowerCase();
      list = list.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.content.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    if (params?.categoryId) {
      list = params.categoryId === 'uncategorized' ? list.filter((n) => !n.category_id) : list.filter((n) => n.category_id === params.categoryId);
    }
    if (params?.tag) list = list.filter((n) => n.tags.includes(params.tag!));
    if (params?.sourceType) list = list.filter((n) => n.source_type === params.sourceType);
    if (params?.hasSummary === 'true') list = list.filter((n) => Boolean(n.summary));
    if (params?.hasSummary === 'false') list = list.filter((n) => !n.summary);
    return list.sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at.localeCompare(a.updated_at));
  },

  async getNote(id: string): Promise<Note> {
    const s = await loadState();
    const n = s.notes.find((x) => x.id === id);
    if (!n) throw new Error('笔记不存在');
    return enrichNote(s, n);
  },

  async getTags(): Promise<{ name: string; count: number }[]> {
    const s = await loadState();
    const map: Record<string, number> = {};
    for (const n of s.notes) for (const t of n.tags) map[t] = (map[t] || 0) + 1;
    return Object.entries(map)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  },

  async createNote(payload: { title: string; content: string; categoryId?: string | null; tags?: string[]; sourceType?: string }): Promise<Note> {
    const s = await loadState();
    const now = nowIso();
    const note: Note = {
      id: uid(),
      title: payload.title.trim() || '未命名笔记',
      content: payload.content || '',
      summary: null,
      category_id: payload.categoryId || null,
      tags: payload.tags || [],
      source_type: (payload.sourceType as Note['source_type']) || 'markdown',
      word_count: countWords(payload.content || ''),
      is_pinned: false,
      created_at: now,
      updated_at: now,
    };
    s.notes.unshift(note);
    logStudy(s, 'note_import', note.id);
    await saveState(s);
    return enrichNote(s, note);
  },

  async updateNote(id: string, payload: { title?: string; content?: string; categoryId?: string | null; tags?: string[]; isPinned?: boolean }): Promise<Note> {
    const s = await loadState();
    const n = s.notes.find((x) => x.id === id);
    if (!n) throw new Error('笔记不存在');
    if (payload.title !== undefined) n.title = payload.title.trim() || n.title;
    if (payload.content !== undefined) {
      n.content = payload.content;
      n.word_count = countWords(payload.content);
    }
    if (payload.categoryId !== undefined) n.category_id = payload.categoryId || null;
    if (payload.tags !== undefined) n.tags = payload.tags;
    if (payload.isPinned !== undefined) n.is_pinned = payload.isPinned;
    n.updated_at = nowIso();
    await saveState(s);
    return enrichNote(s, n);
  },

  async deleteNote(id: string) {
    const s = await loadState();
    s.notes = s.notes.filter((x) => x.id !== id);
    await saveState(s);
    return { ok: true };
  },

  async importFiles(files: File[], categoryId?: string | null, tags?: string[]) {
    const s = await loadState();
    const imported: Note[] = [];
    const warnings: string[] = [];
    for (const f of files) {
      try {
        const parsed = await parseFileOnDevice(f, s.settings);
        const now = nowIso();
        const note: Note = {
          id: uid(),
          title: parsed.title,
          content: parsed.content,
          summary: null,
          category_id: categoryId || null,
          tags: tags || [],
          source_type: parsed.sourceType,
          source_filename: f.name,
          attachment_path: parsed.attachmentDataUrl || null,
          word_count: countWords(parsed.content),
          is_pinned: false,
          created_at: now,
          updated_at: now,
        };
        s.notes.unshift(note);
        logStudy(s, 'note_import', note.id);
        imported.push(enrichNote(s, note));
      } catch (e: any) {
        warnings.push(`${f.name}：${e.message || '解析失败'}`);
      }
    }
    if (imported.length === 0 && warnings.length > 0) {
      throw new Error(warnings.join('；'));
    }
    await saveState(s);
    return { imported, warnings };
  },

  async rerunOcr(id: string): Promise<Note> {
    const s = await loadState();
    const n = s.notes.find((x) => x.id === id);
    if (!n || !n.attachment_path?.startsWith('data:')) throw new Error('该笔记没有关联图片附件');
    const provider = requireActiveProvider(s.settings);
    const [meta, base64] = n.attachment_path.split(',');
    const mime = meta.match(/data:(.*?);/)?.[1] || 'image/jpeg';
    const ocrText = cleanOcrMarkdown(await callVisionDirect(provider, base64, mime));
    if (/^(JPEG_|IMG_|Screenshot|图片笔记|微信图片|Photo)/i.test(n.title)) {
      n.title = extractSmartTitle(ocrText, n.title);
    }
    n.content = ocrText;
    n.summary = null; // clear stale error summary after re-OCR
    n.word_count = countWords(ocrText);
    n.updated_at = nowIso();
    await saveState(s);
    return enrichNote(s, n);
  },

  async summarizeNote(id: string, applyMeta = true): Promise<Note> {
    const s = await loadState();
    const n = s.notes.find((x) => x.id === id);
    if (!n) throw new Error('笔记不存在');
    const provider = requireActiveProvider(s.settings);
    const cleanText = stripInlineImages(n.content);
    const raw = await callLLMDirect(
      provider,
      [
        {
          role: 'system',
          content: `你是「知悟」知识提炼专家。严格返回合法 JSON：
{"abstract":"核心摘要","keyPoints":["要点1","要点2"],"concepts":[{"name":"概念名","definition":"精炼解释"}],"relations":[{"source":"概念A","target":"概念B","relation":"关系"}],"outline":["1. 结构一"],"suggestedCategory":"分类名","suggestedTags":["标签1","标签2"],"difficulty":"进阶"}`,
        },
        {
          role: 'user',
          content: `已有分类：${s.categories.map((c) => c.name).join('、') || '暂无'}\n标题：${n.title}\n正文：\n${cleanText.slice(0, 12000)}`,
        },
      ],
      { jsonMode: true, temperature: 0.3 }
    );
    const parsed = extractJson<Partial<NoteSummary>>(raw);
    const summary: NoteSummary = {
      abstract: parsed.abstract || '已完成总结。',
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      outline: Array.isArray(parsed.outline) ? parsed.outline : [],
      suggestedCategory: parsed.suggestedCategory || '',
      suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags.slice(0, 6) : [],
      difficulty: (['基础', '进阶', '高阶'].includes(parsed.difficulty as string) ? parsed.difficulty : '进阶') as NoteSummary['difficulty'],
    };
    n.summary = summary;
    if (applyMeta) {
      if (summary.suggestedTags?.length) n.tags = Array.from(new Set([...n.tags, ...summary.suggestedTags])).slice(0, 8);
      if (!n.category_id && summary.suggestedCategory) {
        let cat = s.categories.find((c) => c.name === summary.suggestedCategory);
        if (!cat) {
          cat = { id: uid(), name: summary.suggestedCategory, color: '#3B5BDB', icon: 'folder', created_at: nowIso() };
          s.categories.push(cat);
        }
        n.category_id = cat.id;
      }
    }
    const nameMap: Record<string, string> = {};
    for (const c of summary.concepts) nameMap[c.name] = upsertConcept(s, c.name, c.definition, n.category_id, n.id);
    for (const r of summary.relations || []) {
      const src = nameMap[r.source];
      const tgt = nameMap[r.target];
      if (src && tgt && src !== tgt && !s.conceptLinks.some((l) => l.source === src && l.target === tgt)) {
        s.conceptLinks.push({ id: uid(), source: src, target: tgt, relation: r.relation || '相关', weight: 1 });
      }
    }
    n.updated_at = nowIso();
    logStudy(s, 'note_summary', n.id);
    await saveState(s);
    return enrichNote(s, n);
  },

  async synthesizeNotes(payload: { noteIds?: string[]; categoryId?: string | null; title?: string }): Promise<Synthesis> {
    const s = await loadState();
    const provider = requireActiveProvider(s.settings);
    let target = payload.noteIds?.length
      ? s.notes.filter((n) => payload.noteIds!.includes(n.id))
      : payload.categoryId
      ? s.notes.filter((n) => n.category_id === payload.categoryId).slice(0, 10)
      : [];
    if (!target.length) throw new Error('请至少选择 1 篇笔记进行归纳');
    const combined = target
      .map((n, i) => `### 笔记${i + 1}：${n.title}\n${stripInlineImages(n.content).slice(0, 3200)}`)
      .join('\n\n---\n\n');
    const md = await callLLMDirect(provider, [
      {
        role: 'system',
        content: '你是知识归纳大师。将多篇学习笔记整合为高质量 Markdown 专题复习指南，包含全局脉络、概念对比表、本质规律与易错点。',
      },
      { role: 'user', content: combined },
    ]);
    const syn: Synthesis = {
      id: uid(),
      title: payload.title?.trim() || `专题归纳（${target.length} 篇笔记）`,
      note_ids: target.map((n) => n.id),
      category_id: payload.categoryId || null,
      content: md,
      created_at: nowIso(),
    };
    s.syntheses.unshift(syn);
    logStudy(s, 'note_summary', syn.id);
    await saveState(s);
    return syn;
  },

  async getSyntheses(): Promise<Synthesis[]> {
    return (await loadState()).syntheses;
  },

  async deleteSynthesis(id: string) {
    const s = await loadState();
    s.syntheses = s.syntheses.filter((x) => x.id !== id);
    await saveState(s);
    return { ok: true };
  },

  async getQuizzes(): Promise<Quiz[]> {
    return (await loadState()).quizzes;
  },

  async getQuiz(id: string): Promise<Quiz> {
    const q = (await loadState()).quizzes.find((x) => x.id === id);
    if (!q) throw new Error('测验不存在');
    return q;
  },

  async generateQuiz(payload: {
    noteIds?: string[];
    categoryId?: string | null;
    weakOnly?: boolean;
    focusConcepts?: string[];
    count?: number;
    difficulty?: 'easy' | 'medium' | 'hard';
    types?: ('single' | 'multiple' | 'boolean' | 'short')[];
    title?: string;
  }): Promise<Quiz> {
    const s = await loadState();
    const provider = requireActiveProvider(s.settings);
    let sourceNotes: Note[] = [];
    let focus = payload.focusConcepts || [];
    if (payload.weakOnly) {
      const weak = [...s.concepts].sort((a, b) => a.mastery_score - b.mastery_score).slice(0, 5);
      if (!focus.length) focus = weak.map((w) => w.name);
      const ids = new Set(weak.flatMap((w) => w.note_ids));
      sourceNotes = s.notes.filter((n) => ids.has(n.id)).slice(0, 5);
    }
    if (!sourceNotes.length && payload.noteIds?.length) sourceNotes = s.notes.filter((n) => payload.noteIds!.includes(n.id));
    if (!sourceNotes.length && payload.categoryId) sourceNotes = s.notes.filter((n) => n.category_id === payload.categoryId).slice(0, 5);
    if (!sourceNotes.length) sourceNotes = s.notes.slice(0, 4);
    if (!sourceNotes.length) throw new Error('笔记库暂无笔记，请先导入至少一篇笔记。');

    const count = Math.max(1, Math.min(12, payload.count || 5));
    const types = payload.types?.length ? payload.types : ['single', 'boolean', 'short'];
    const diff = payload.difficulty || 'medium';
    const raw = await callLLMDirect(
      provider,
      [
        {
          role: 'system',
          content: `你是动态出题引擎。严格基于学习材料出题，返回合法 JSON：
{"questions":[{"noteId":"ID","conceptName":"考点","type":"single|multiple|boolean|short","stem":"题干","options":["A. ...","B. ...","C. ...","D. ..."],"correctAnswer":"单选A/多选A,C/判断对或错/简答要点","explanation":"解析","memoryTip":"口诀"}]}`,
        },
        {
          role: 'user',
          content: `出 ${count} 题，难度 ${diff}，题型 ${types.join(',')}${focus.length ? `，重点考查：${focus.join('、')}` : ''}\n\n${sourceNotes
            .map((n) => `[NOTE_ID:${n.id}] 《${n.title}》\n${stripInlineImages(n.content).slice(0, 3200)}`)
            .join('\n\n')}`,
        },
      ],
      { jsonMode: true, temperature: 0.5 }
    );
    const parsed = extractJson<{ questions?: any[] } | any[]>(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed.questions || [];
    const quizId = uid();
    const questions: QuizQuestion[] = arr.slice(0, count).map((q: any) => {
      const t = ['single', 'multiple', 'boolean', 'short'].includes(q.type) ? q.type : 'single';
      return {
        id: uid(),
        quiz_id: quizId,
        note_id: q.noteId || sourceNotes[0].id,
        concept_name: q.conceptName || '综合知识',
        type: t,
        stem: q.stem || '',
        options: t === 'boolean' ? ['对', '错'] : t === 'short' ? [] : Array.isArray(q.options) ? q.options : [],
        correct_answer: String(q.correctAnswer || '').trim(),
        explanation: q.explanation || '',
        memory_tip: q.memoryTip || '',
      };
    });
    const quiz: Quiz = {
      id: quizId,
      title: payload.title || (sourceNotes.length === 1 ? `《${sourceNotes[0].title}》动态测验` : `综合动态测验（${questions.length}题）`),
      source_note_ids: sourceNotes.map((n) => n.id),
      category_id: payload.categoryId || null,
      difficulty: diff,
      total_questions: questions.length,
      score: null,
      status: 'in_progress',
      created_at: nowIso(),
      questions,
    };
    s.quizzes.unshift(quiz);
    await saveState(s);
    return quiz;
  },

  async submitQuiz(id: string, answers: Record<string, string>): Promise<Quiz> {
    const s = await loadState();
    const quiz = s.quizzes.find((x) => x.id === id);
    if (!quiz || !quiz.questions) throw new Error('测验不存在');
    let total = 0;
    let mistakesAdded = 0;
    const now = nowIso();

    for (const q of quiz.questions) {
      const ua = String(answers[q.id] ?? '').trim();
      let isCorrect = false;
      let score = 0;
      let feedback = '';

      if (q.type === 'single' || q.type === 'multiple') {
        isCorrect = normalizeChoiceAnswer(ua) !== '' && normalizeChoiceAnswer(ua) === normalizeChoiceAnswer(q.correct_answer);
        score = isCorrect ? 1 : 0;
      } else if (q.type === 'boolean') {
        const norm = (x: string) => (['对', '正确', 'true'].includes(x.toLowerCase()) ? '对' : '错');
        isCorrect = ua !== '' && norm(ua) === norm(q.correct_answer);
        score = isCorrect ? 1 : 0;
      } else {
        try {
          const provider = requireActiveProvider(s.settings);
          const raw = await callLLMDirect(
            provider,
            [
              { role: 'system', content: '对比参考答案批改简答题，返回JSON：{"score":0到1,"isCorrect":true/false,"feedback":"点评"}' },
              { role: 'user', content: `题干：${q.stem}\n参考答案：${q.correct_answer}\n用户作答：${ua}` },
            ],
            { jsonMode: true, temperature: 0.2 }
          );
          const g = extractJson<{ score?: number; isCorrect?: boolean; feedback?: string }>(raw);
          score = Math.max(0, Math.min(1, Number(g.score ?? 0)));
          isCorrect = g.isCorrect ?? score >= 0.7;
          feedback = g.feedback || '已完成批改。';
        } catch {
          isCorrect = ua.length >= 6;
          score = isCorrect ? 1 : 0;
          feedback = '请对照参考答案自评关键要点。';
        }
      }

      q.user_answer = ua;
      q.is_correct = isCorrect;
      q.ai_feedback = feedback;
      q.score = score;
      total += score;
      if (q.concept_name) updateConceptMastery(s, q.concept_name, isCorrect, quiz.category_id || null);

      if (!isCorrect) {
        const existing = s.mistakes.find((m) => m.question_id === q.id);
        if (existing) {
          existing.wrong_count += 1;
          existing.wrong_answer = ua || '未作答';
          existing.status = 'unmastered';
          existing.next_review_at = now;
        } else {
          const noteTitle = s.notes.find((n) => n.id === q.note_id)?.title || null;
          s.mistakes.unshift({
            id: uid(),
            question_id: q.id,
            note_id: q.note_id || null,
            note_title: noteTitle,
            concept_name: q.concept_name || '综合知识',
            type: q.type,
            stem: q.stem,
            options: q.options,
            correct_answer: q.correct_answer,
            wrong_answer: ua || '未作答',
            explanation: q.explanation,
            ai_diagnosis: feedback,
            user_reflection: '',
            status: 'unmastered',
            wrong_count: 1,
            ease_factor: 2.5,
            interval_days: 1,
            repetitions: 0,
            next_review_at: now,
            created_at: now,
          });
          mistakesAdded++;
        }
      }
    }

    quiz.score = quiz.questions.length ? Number((total / quiz.questions.length).toFixed(3)) : 0;
    quiz.status = 'completed';
    quiz.completed_at = now;
    quiz.mistakesAdded = mistakesAdded;
    logStudy(s, 'quiz_complete', quiz.id, quiz.score);
    await saveState(s);
    return quiz;
  },

  async deleteQuiz(id: string) {
    const s = await loadState();
    s.quizzes = s.quizzes.filter((q) => q.id !== id);
    await saveState(s);
    return { ok: true };
  },

  async getMistakes(params?: { status?: string; concept?: string; dueOnly?: boolean }): Promise<Mistake[]> {
    const s = await loadState();
    const now = nowIso();
    let list = s.mistakes;
    if (params?.status && params.status !== 'all') list = list.filter((m) => m.status === params.status);
    if (params?.concept) list = list.filter((m) => m.concept_name.includes(params.concept!));
    if (params?.dueOnly) list = list.filter((m) => m.status !== 'mastered' && m.next_review_at <= now);
    return list.map((m) => ({ ...m, interval_previews: previewIntervals(m.ease_factor, m.interval_days, m.repetitions) }));
  },

  async bookmarkMistake(questionId: string): Promise<Mistake> {
    const s = await loadState();
    const existing = s.mistakes.find((m) => m.question_id === questionId);
    if (existing) return existing;
    let found: QuizQuestion | undefined;
    for (const qz of s.quizzes) {
      found = qz.questions?.find((x) => x.id === questionId);
      if (found) break;
    }
    if (!found) throw new Error('题目不存在');
    const now = nowIso();
    const m: Mistake = {
      id: uid(),
      question_id: found.id,
      note_id: found.note_id || null,
      note_title: s.notes.find((n) => n.id === found!.note_id)?.title || null,
      concept_name: found.concept_name || '收藏题目',
      type: found.type,
      stem: found.stem,
      options: found.options,
      correct_answer: found.correct_answer,
      wrong_answer: found.user_answer || '手动收藏',
      explanation: found.explanation,
      ai_diagnosis: '',
      user_reflection: '',
      status: 'reviewing',
      wrong_count: 1,
      ease_factor: 2.5,
      interval_days: 1,
      repetitions: 0,
      next_review_at: now,
      created_at: now,
    };
    s.mistakes.unshift(m);
    await saveState(s);
    return m;
  },

  async updateMistake(id: string, payload: { userReflection?: string; status?: string }): Promise<Mistake> {
    const s = await loadState();
    const m = s.mistakes.find((x) => x.id === id);
    if (!m) throw new Error('错题不存在');
    if (payload.userReflection !== undefined) m.user_reflection = payload.userReflection;
    if (payload.status !== undefined) m.status = payload.status as Mistake['status'];
    await saveState(s);
    return m;
  },

  async diagnoseMistake(id: string): Promise<Mistake> {
    const s = await loadState();
    const m = s.mistakes.find((x) => x.id === id);
    if (!m) throw new Error('错题不存在');
    const provider = requireActiveProvider(s.settings);
    m.ai_diagnosis = await callLLMDirect(provider, [
      { role: 'system', content: '你是错题诊断专家。用 Markdown 输出：1. 错误根因诊断 2. 核心原理重构 3. 秒杀记忆锚点。' },
      { role: 'user', content: `考点：${m.concept_name}\n题干：${m.stem}\n正确：${m.correct_answer}\n我的错答：${m.wrong_answer}` },
    ]);
    await saveState(s);
    return m;
  },

  async generateVariant(id: string) {
    const s = await loadState();
    const m = s.mistakes.find((x) => x.id === id);
    if (!m) throw new Error('错题不存在');
    const provider = requireActiveProvider(s.settings);
    const raw = await callLLMDirect(
      provider,
      [
        {
          role: 'system',
          content: '基于原题出一道考查同一知识点的全新变式题，返回合法JSON：{"conceptName":"","type":"single|multiple|boolean|short","stem":"","options":[],"correctAnswer":"","explanation":"","memoryTip":""}',
        },
        { role: 'user', content: `原题：${m.stem}\n答案：${m.correct_answer}\n解析：${m.explanation}` },
      ],
      { jsonMode: true, temperature: 0.6 }
    );
    const q = extractJson<any>(raw);
    return {
      conceptName: q.conceptName || m.concept_name,
      type: q.type || 'single',
      stem: q.stem || '',
      options: Array.isArray(q.options) ? q.options : [],
      correctAnswer: String(q.correctAnswer || ''),
      explanation: q.explanation || '',
      memoryTip: q.memoryTip || '',
    };
  },

  async reviewMistake(id: string, rating: 1 | 2 | 3 | 4) {
    const s = await loadState();
    const m = s.mistakes.find((x) => x.id === id);
    if (!m) throw new Error('错题不存在');
    const next = computeSM2({ easeFactor: m.ease_factor, intervalDays: m.interval_days, repetitions: m.repetitions }, rating);
    m.ease_factor = next.easeFactor;
    m.interval_days = next.intervalDays;
    m.repetitions = next.repetitions;
    m.next_review_at = next.nextReviewAt;
    m.last_reviewed_at = nowIso();
    m.status = rating === 1 ? 'unmastered' : rating === 4 || next.repetitions >= 3 ? 'mastered' : 'reviewing';
    if (m.concept_name) updateConceptMastery(s, m.concept_name, rating >= 3);
    logStudy(s, 'mistake_review', m.id, rating >= 3 ? 1 : 0);
    await saveState(s);
    return { mistake: { ...m, interval_previews: previewIntervals(m.ease_factor, m.interval_days, m.repetitions) }, nextLabel: next.label };
  },

  async deleteMistake(id: string) {
    const s = await loadState();
    s.mistakes = s.mistakes.filter((x) => x.id !== id);
    await saveState(s);
    return { ok: true };
  },

  async getFlashcards(params?: { noteId?: string; dueOnly?: boolean }): Promise<Flashcard[]> {
    const s = await loadState();
    const now = nowIso();
    let list = s.flashcards;
    if (params?.noteId) list = list.filter((f) => f.note_id === params.noteId);
    if (params?.dueOnly) list = list.filter((f) => f.next_review_at <= now);
    return list.map((f) => ({
      ...f,
      note_title: s.notes.find((n) => n.id === f.note_id)?.title || null,
      interval_previews: previewIntervals(f.ease_factor, f.interval_days, f.repetitions),
    }));
  },

  async getReviewQueue() {
    const s = await loadState();
    const now = nowIso();
    const dueMistakes: ReviewQueueItem[] = s.mistakes
      .filter((m) => m.status !== 'mastered' && m.next_review_at <= now)
      .map((m) => ({
        itemType: 'mistake',
        id: m.id,
        note_id: m.note_id,
        note_title: m.note_title,
        concept_name: m.concept_name,
        type: m.type,
        stem: m.stem,
        options: m.options,
        correct_answer: m.correct_answer,
        wrong_answer: m.wrong_answer,
        explanation: m.explanation,
        ai_diagnosis: m.ai_diagnosis,
        interval_previews: previewIntervals(m.ease_factor, m.interval_days, m.repetitions),
      }));
    const dueCards: ReviewQueueItem[] = s.flashcards
      .filter((f) => f.next_review_at <= now)
      .map((f) => ({
        itemType: 'flashcard',
        id: f.id,
        note_id: f.note_id,
        note_title: s.notes.find((n) => n.id === f.note_id)?.title || null,
        concept_name: f.concept_name,
        front: f.front,
        back: f.back,
        hint: f.hint,
        interval_previews: previewIntervals(f.ease_factor, f.interval_days, f.repetitions),
      }));
    return {
      totalDue: dueCards.length + dueMistakes.length,
      dueCardsCount: dueCards.length,
      dueMistakesCount: dueMistakes.length,
      items: [...dueMistakes, ...dueCards],
    };
  },

  async createFlashcard(payload: { front: string; back: string; hint?: string; noteId?: string | null; conceptName?: string }): Promise<Flashcard> {
    const s = await loadState();
    const now = nowIso();
    const c: Flashcard = {
      id: uid(),
      note_id: payload.noteId || null,
      concept_name: payload.conceptName || '',
      front: payload.front.trim(),
      back: payload.back.trim(),
      hint: payload.hint || '',
      ease_factor: 2.5,
      interval_days: 0,
      repetitions: 0,
      next_review_at: now,
      created_at: now,
    };
    s.flashcards.unshift(c);
    await saveState(s);
    return c;
  },

  async generateFlashcards(noteId: string, count = 6) {
    const s = await loadState();
    const n = s.notes.find((x) => x.id === noteId);
    if (!n) throw new Error('笔记不存在');
    const provider = requireActiveProvider(s.settings);
    const raw = await callLLMDirect(
      provider,
      [
        { role: 'system', content: '从笔记生成原子化主动回忆闪卡，返回JSON：{"cards":[{"front":"问题","back":"答案","hint":"提示","conceptName":"概念"}]}' },
        { role: 'user', content: `生成 ${count} 张闪卡。\n标题：${n.title}\n${stripInlineImages(n.content).slice(0, 9000)}` },
      ],
      { jsonMode: true, temperature: 0.4 }
    );
    const parsed = extractJson<{ cards?: any[] } | any[]>(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.cards || [];
    const now = nowIso();
    const created: Flashcard[] = list.slice(0, count).map((c: any) => ({
      id: uid(),
      note_id: n.id,
      category_id: n.category_id,
      concept_name: c.conceptName || n.title,
      front: String(c.front || ''),
      back: String(c.back || ''),
      hint: String(c.hint || ''),
      ease_factor: 2.5,
      interval_days: 0,
      repetitions: 0,
      next_review_at: now,
      created_at: now,
    }));
    s.flashcards.unshift(...created);
    await saveState(s);
    return { count: created.length, cards: created };
  },

  async reviewFlashcard(id: string, rating: 1 | 2 | 3 | 4) {
    const s = await loadState();
    const c = s.flashcards.find((x) => x.id === id);
    if (!c) throw new Error('闪卡不存在');
    const next = computeSM2({ easeFactor: c.ease_factor, intervalDays: c.interval_days, repetitions: c.repetitions }, rating);
    c.ease_factor = next.easeFactor;
    c.interval_days = next.intervalDays;
    c.repetitions = next.repetitions;
    c.next_review_at = next.nextReviewAt;
    c.last_reviewed_at = nowIso();
    if (c.concept_name) updateConceptMastery(s, c.concept_name, rating >= 3, c.category_id || null);
    logStudy(s, 'flashcard_review', c.id, rating >= 3 ? 1 : 0);
    await saveState(s);
    return { card: { ...c, interval_previews: previewIntervals(c.ease_factor, c.interval_days, c.repetitions) }, nextLabel: next.label };
  },

  async deleteFlashcard(id: string) {
    const s = await loadState();
    s.flashcards = s.flashcards.filter((x) => x.id !== id);
    await saveState(s);
    return { ok: true };
  },

  async getGraph(): Promise<{ nodes: GraphNode[]; links: GraphLink[]; weakConcepts: GraphNode[] }> {
    const s = await loadState();
    const nodes: GraphNode[] = s.concepts.map((c) => {
      const cat = s.categories.find((x) => x.id === c.category_id);
      const linkedNotes = c.note_ids
        .map((nid) => s.notes.find((n) => n.id === nid))
        .filter(Boolean)
        .map((n) => ({ id: n!.id, title: n!.title }));
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        category_id: c.category_id,
        category_name: cat?.name || null,
        category_color: cat?.color || null,
        mastery_score: c.mastery_score,
        quiz_attempts: c.quiz_attempts,
        quiz_correct: c.quiz_correct,
        note_count: linkedNotes.length,
        active_mistakes: s.mistakes.filter((m) => m.concept_name === c.name && m.status !== 'mastered').length,
        notes: linkedNotes,
      };
    });
    const weakConcepts = [...nodes].sort((a, b) => a.mastery_score - b.mastery_score).slice(0, 12);
    return { nodes, links: s.conceptLinks, weakConcepts };
  },

  async getTutorSessions(): Promise<TutorSession[]> {
    return (await loadState()).tutorSessions;
  },

  async createTutorSession(payload: { title?: string; mode: 'qa' | 'feynman'; noteIds?: string[]; initialPrompt?: string }): Promise<TutorSession> {
    const s = await loadState();
    const now = nowIso();
    const sess: TutorSession = {
      id: uid(),
      title: payload.title?.trim() || (payload.mode === 'feynman' ? '费曼考官演练' : '笔记深度答疑'),
      mode: payload.mode,
      note_ids: payload.noteIds || [],
      created_at: now,
      updated_at: now,
    };
    s.tutorSessions.unshift(sess);
    s.tutorMessages[sess.id] = [
      {
        id: uid(),
        session_id: sess.id,
        role: 'assistant',
        content:
          payload.mode === 'feynman'
            ? `你好！我是你的**费曼学习法考官**。试着用大白话把一个概念讲给我听，我会帮你找出盲区并逐步追问！`
            : `你好！我是你的**知悟学习助教**，随时基于你的笔记为你答疑解惑！`,
        created_at: now,
      },
    ];
    await saveState(s);
    return sess;
  },

  async getTutorMessages(sessionId: string) {
    const s = await loadState();
    const session = s.tutorSessions.find((x) => x.id === sessionId);
    if (!session) throw new Error('会话不存在');
    return { session, messages: s.tutorMessages[sessionId] || [] };
  },

  async sendTutorMessage(sessionId: string, payload: { message: string; noteIds?: string[]; mode?: 'qa' | 'feynman' }) {
    const s = await loadState();
    const session = s.tutorSessions.find((x) => x.id === sessionId);
    if (!session) throw new Error('会话不存在');
    const provider = requireActiveProvider(s.settings);
    const noteIds = payload.noteIds?.length ? payload.noteIds : session.note_ids;
    const mode = payload.mode || session.mode;
    const notes = noteIds.length ? s.notes.filter((n) => noteIds.includes(n.id)) : s.notes.slice(0, 3);
    const ctx = notes.map((n, i) => `【笔记${i + 1}：${n.title}】\n${stripInlineImages(n.content).slice(0, 3500)}`).join('\n\n');
    const sys =
      mode === 'feynman'
        ? `你是费曼学习法考官。先肯定准确部分并给出理解度评分，再指出逻辑漏洞并提出1-2个直击要害的苏格拉底式追问。\n\n参考材料：\n${ctx}`
        : `你是知悟学习助教。结合参考笔记清晰深入地解答问题。\n\n参考材料：\n${ctx}`;
    const hist = (s.tutorMessages[sessionId] || []).slice(-10).map((m) => ({ role: m.role, content: m.content }));
    const reply = await callLLMDirect(provider, [{ role: 'system', content: sys }, ...hist, { role: 'user', content: payload.message }]);
    const userMessage: TutorMessage = { id: uid(), session_id: sessionId, role: 'user', content: payload.message, created_at: nowIso() };
    const assistantMessage: TutorMessage = { id: uid(), session_id: sessionId, role: 'assistant', content: reply, created_at: nowIso() };
    (s.tutorMessages[sessionId] ||= []).push(userMessage, assistantMessage);
    session.updated_at = nowIso();
    logStudy(s, 'tutor_chat', sessionId);
    await saveState(s);
    return { userMessage, assistantMessage };
  },

  async sendTutorMessageStream(
    sessionId: string,
    payload: { message: string; noteIds?: string[]; mode?: 'qa' | 'feynman' },
    onDelta: (delta: string) => void
  ) {
    // On Android CapacitorHttp (native bridge), stream chunks or fall back cleanly with smooth reveal
    const res = await localApi.sendTutorMessage(sessionId, payload);
    const text = res.assistantMessage.content;
    // Progressive chunk emit so UI renders fluidly
    const step = Math.max(8, Math.ceil(text.length / 28));
    for (let i = 0; i < text.length; i += step) {
      onDelta(text.slice(i, i + step));
      await new Promise((r) => setTimeout(r, 12));
    }
    return res;
  },

  async deleteTutorSession(sessionId: string) {
    const s = await loadState();
    s.tutorSessions = s.tutorSessions.filter((x) => x.id !== sessionId);
    delete s.tutorMessages[sessionId];
    await saveState(s);
    return { ok: true };
  },

  async getSettings(): Promise<AISettings> {
    const s = await loadState();
    return { ...s.settings, activeCapability: getActiveCapability(s.settings) };
  },

  async saveSettings(settings: AISettings): Promise<AISettings> {
    const s = await loadState();
    s.settings = { ...settings };
    delete s.settings.activeCapability;
    await saveState(s);
    return { ...s.settings, activeCapability: getActiveCapability(s.settings) };
  },

  async testAI(provider: AIProviderConfig) {
    const start = Date.now();
    const reply = await callLLMDirect(
      provider,
      [
        { role: 'system', content: '请用不超过15个字回复确认连接正常。' },
        { role: 'user', content: '你好，请确认连接正常。' },
      ],
      { temperature: 0.1, maxTokens: 512 }
    );
    return { ok: true, latencyMs: Date.now() - start, reply };
  },

  async fetchModels(provider: AIProviderConfig): Promise<{ ok: boolean; models: string[] }> {
    const base = (provider.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写 API Base URL');

    if (provider.type === 'gemini') {
      if (!provider.apiKey?.trim()) throw new Error('请先填写 Gemini API Key');
      const res = await fetch(`${base}/models?key=${encodeURIComponent(provider.apiKey.trim())}`);
      if (!res.ok) throw new Error(`获取模型列表失败 (${res.status})`);
      const data = await res.json();
      const models: string[] = (data?.models || [])
        .filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map((m: any) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      return { ok: true, models: Array.from(new Set(models)).sort() };
    }

    const headers: Record<string, string> = {};
    if (provider.apiKey?.trim()) headers['Authorization'] = `Bearer ${provider.apiKey.trim()}`;

    try {
      const res = await fetch(`${base}/models`, { headers });
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        const ids: string[] = arr.map((m: any) => String(m?.id || m?.name || '')).filter(Boolean);
        if (ids.length > 0) return { ok: true, models: Array.from(new Set(ids)).sort() };
      } else if (provider.id !== 'local') {
        throw new Error(`获取模型列表失败 (${res.status})`);
      }
    } catch (err: any) {
      if (provider.id !== 'local') throw err;
    }

    // Ollama native fallback
    const origin = base.replace(/\/v1$/i, '');
    const ollamaRes = await fetch(`${origin}/api/tags`);
    if (!ollamaRes.ok) throw new Error(`无法连接本地模型服务 (${ollamaRes.status})`);
    const ollamaData = await ollamaRes.json();
    const localModels: string[] = (ollamaData?.models || []).map((m: any) => String(m?.name || m?.model || '')).filter(Boolean);
    return { ok: true, models: Array.from(new Set(localModels)).sort() };
  },

  async getNetworkInfo() {
    return { adapters: [], ips: [], primaryIp: '', port: '', mobileUrl: '', qrDataUrl: '' };
  },

  // JSON Backup Export & Import for Standalone Android APK
  async exportJsonBackup(): Promise<string> {
    const s = await loadState();
    return JSON.stringify(s, null, 2);
  },

  async importJsonBackup(jsonText: string) {
    const parsed = JSON.parse(jsonText) as Partial<LocalDBState>;
    if (!parsed || !Array.isArray(parsed.notes)) {
      throw new Error('备份文件格式无效，请选择知悟导出的 JSON 备份文件。');
    }
    const current = await loadState();
    let notesMerged = 0;

    // Smart merge by ID so mobile & desktop notes never clobber each other
    const mergeById = <T extends { id: string; updated_at?: string }>(existing: T[], incoming: T[] = []) => {
      const map = new Map(existing.map((x) => [x.id, x]));
      for (const item of incoming) {
        if (!item?.id) continue;
        const prev = map.get(item.id);
        if (!prev || (item.updated_at && prev.updated_at && item.updated_at > prev.updated_at)) {
          map.set(item.id, item);
          if (existing === (current.notes as unknown as T[])) notesMerged++;
        }
      }
      return Array.from(map.values());
    };

    current.categories = mergeById(current.categories, parsed.categories || []);
    current.notes = mergeById(current.notes, parsed.notes || []);
    current.syntheses = mergeById(current.syntheses, parsed.syntheses || []);
    current.concepts = mergeById(current.concepts, parsed.concepts || []);
    current.conceptLinks = mergeById(current.conceptLinks, parsed.conceptLinks || []);
    current.flashcards = mergeById(current.flashcards, parsed.flashcards || []);
    current.mistakes = mergeById(current.mistakes, parsed.mistakes || []);
    current.studyLogs = mergeById(current.studyLogs, parsed.studyLogs || []);

    await saveState(current);
    return { ok: true, notesCount: notesMerged || parsed.notes.length };
  },
};
