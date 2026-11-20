import { AIProviderConfig, getAISettings } from '../db.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIConfigError';
  }
}

export function getActiveProviderRaw(providerId?: string): AIProviderConfig | undefined {
  const settings = getAISettings();
  const targetId = providerId || settings.activeProviderId;
  return settings.providers.find((p) => p.id === targetId) || settings.providers[0];
}

export function getActiveModelCapability() {
  const provider = getActiveProviderRaw();
  if (!provider) {
    return {
      providerId: '',
      providerName: '未配置',
      model: '',
      supportsVision: false,
      configured: false,
    };
  }
  const configured = provider.requiresKey === false || Boolean(provider.apiKey?.trim());
  return {
    providerId: provider.id,
    providerName: provider.name,
    model: provider.model,
    supportsVision: Boolean(provider.supportsVision),
    configured,
  };
}

export function getActiveProvider(providerId?: string): AIProviderConfig {
  const provider = getActiveProviderRaw(providerId);

  if (!provider) {
    throw new AIConfigError('尚未配置 AI 模型，请前往「设置」页面添加 API Key 或配置本地 Ollama。');
  }
  if (provider.requiresKey !== false && !provider.apiKey?.trim()) {
    throw new AIConfigError(
      `当前选中的模型「${provider.name}」未填写 API Key。请前往「设置」填写 API Key，或切换到已配置的模型。`
    );
  }
  if (!provider.model?.trim()) {
    throw new AIConfigError(`当前选中的「${provider.name}」未填写模型名称，请前往「设置」补全。`);
  }
  return provider;
}

export function assertActiveModelSupportsVision(): AIProviderConfig {
  const raw = getActiveProviderRaw();
  if (!raw) {
    throw new AIConfigError('尚未配置 AI 模型，暂无法上传识别图片笔记。');
  }
  if (!raw.supportsVision) {
    throw new AIConfigError(
      `当前模型「${raw.name} (${raw.model || '未命名'})」不支持视觉/图片识别，无法上传图片笔记。请在「设置」中切换到支持视觉的多模态模型（如 Gemini、GPT-4o / 4o-mini、Qwen-VL 等）并开启「支持视觉输入」。`
    );
  }
  return getActiveProvider();
}

export async function callLLM(
  messages: ChatMessage[],
  options: {
    provider?: AIProviderConfig;
    temperature?: number;
    jsonMode?: boolean;
    maxTokens?: number;
  } = {}
): Promise<string> {
  const provider = options.provider || getActiveProvider();
  const temperature = options.temperature ?? 0.4;

  if (provider.type === 'gemini') {
    return callGemini(provider, messages, { temperature, jsonMode: options.jsonMode });
  }
  return callOpenAICompat(provider, messages, {
    temperature,
    jsonMode: options.jsonMode,
    maxTokens: options.maxTokens,
  });
}

async function callOpenAICompat(
  provider: AIProviderConfig,
  messages: ChatMessage[],
  options: { temperature: number; jsonMode?: boolean; maxTokens?: number }
): Promise<string> {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: options.temperature,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Some OpenAI-compatible gateways don't support response_format: json_object -> retry once without it
    if (options.jsonMode && res.status === 400 && errText.toLowerCase().includes('response_format')) {
      delete body.response_format;
      const retry = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (retry.ok) {
        const retryJson = (await retry.json()) as any;
        return retryJson?.choices?.[0]?.message?.content?.trim() || '';
      }
    }
    throw new Error(`模型请求失败 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  const msg = data?.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content;
  if (!content) {
    throw new Error('模型返回了空内容，请检查模型名称或配额。');
  }
  return String(content).trim();
}

async function callGemini(
  provider: AIProviderConfig,
  messages: ChatMessage[],
  options: { temperature: number; jsonMode?: boolean }
): Promise<string> {
  const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(
    provider.apiKey
  )}`;

  const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options.temperature,
      ...(options.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: systemParts };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini 请求失败 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('');
  if (!text) {
    throw new Error('Gemini 返回了空内容，请检查 API Key 或模型名称。');
  }
  return text.trim();
}

export function stripInlineImages(content: string): string {
  return (content || '')
    .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)\s*(?:---\s*)?/gi, '')
    .replace(/!\[[^\]]*\]\(\/uploads\/[^)]+\)\s*(?:---\s*)?/gi, '')
    .trim();
}

export function cleanOcrMarkdown(raw: string): string {
  return (raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:small|span|div|font|u|center)[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractSmartTitle(markdown: string, fallbackName: string): string {
  const h1 = markdown.match(/^#{1,3}\s+(.+)$/m);
  if (h1?.[1]?.trim()) {
    return h1[1].replace(/[*`]/g, '').trim().slice(0, 48);
  }
  const firstLine = markdown
    .split('\n')
    .map((l) => l.replace(/^[-*>\d.\s]+/, '').replace(/[*`]/g, '').trim())
    .find((l) => l.length >= 4 && !l.startsWith('|') && !l.startsWith('!'));
  if (firstLine) return firstLine.slice(0, 42);
  return fallbackName;
}

export async function callVisionOCR(imageBase64: string, mimeType: string, customPrompt?: string): Promise<string> {
  const provider = assertActiveModelSupportsVision();
  const prompt =
    customPrompt ||
    `你是一位严谨的学术笔记整理助手。请精准识别这张图片中的所有文字、标题、列表、表格和数学公式，整理为清晰、结构化的纯 Markdown 笔记。
要求：
1. 第一行请用一级标题 # 概括本页笔记的核心主题；
2. 忠实还原原图全部文字与表格，不编造不存在的内容；
3. 数学公式使用标准 LaTeX（行内用 $...$，独立公式用 $$...$$）；
4. 禁止输出 <small>、<div>、<br>、<span> 等任何 HTML 标签，全部使用纯 Markdown 语法；
5. 直接输出整理后的 Markdown 正文，不要附加多余寒暄。`;

  if (provider.type === 'gemini') {
    const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(
      provider.apiKey
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: imageBase64 } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`视觉识别失败 (${res.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    return (data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '').trim();
  }

  // OpenAI-compatible multimodal API using the single configured model
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
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`当前模型无法处理图片输入 (${res.status})，请确认该模型支持视觉多模态：${errText.slice(0, 220)}`);
  }
  const data = (await res.json()) as any;
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

export function extractJson<T = any>(raw: string): T {
  const cleaned = raw.trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try code fence
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      return JSON.parse(fence[1].trim()) as T;
    }
    // Try outermost braces/brackets
    const firstObj = cleaned.indexOf('{');
    const lastObj = cleaned.lastIndexOf('}');
    if (firstObj !== -1 && lastObj > firstObj) {
      return JSON.parse(cleaned.slice(firstObj, lastObj + 1)) as T;
    }
    const firstArr = cleaned.indexOf('[');
    const lastArr = cleaned.lastIndexOf(']');
    if (firstArr !== -1 && lastArr > firstArr) {
      return JSON.parse(cleaned.slice(firstArr, lastArr + 1)) as T;
    }
    throw new Error('AI 返回格式未能解析为 JSON，请重试。');
  }
}

export async function testProviderConnection(provider: AIProviderConfig): Promise<{ latencyMs: number; reply: string }> {
  const start = Date.now();
  const reply = await callLLM(
    [
      { role: 'system', content: '请用不超过15个字回复确认连接正常。' },
      { role: 'user', content: '你好，请确认连接正常。' },
    ],
    { provider, temperature: 0.1, maxTokens: 512 }
  );
  return { latencyMs: Date.now() - start, reply };
}

export async function fetchProviderModels(provider: AIProviderConfig): Promise<string[]> {
  const base = (provider.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('请先填写 API Base URL');

  if (provider.type === 'gemini') {
    if (!provider.apiKey?.trim()) throw new Error('请先填写 Gemini API Key');
    const url = `${base}/models?key=${encodeURIComponent(provider.apiKey.trim())}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`获取模型列表失败 (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = (await res.json()) as any;
    const list: string[] = (data?.models || [])
      .filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m: any) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    return Array.from(new Set(list)).sort();
  }

  // OpenAI-compatible GET /models (with fallback to Ollama /api/tags)
  const headers: Record<string, string> = {};
  if (provider.apiKey?.trim()) {
    headers['Authorization'] = `Bearer ${provider.apiKey.trim()}`;
  }

  try {
    const res = await fetch(`${base}/models`, { headers });
    if (res.ok) {
      const data = (await res.json()) as any;
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const ids: string[] = arr.map((m: any) => String(m?.id || m?.name || '')).filter(Boolean);
      if (ids.length > 0) return Array.from(new Set(ids)).sort();
    } else if (provider.id !== 'local') {
      const err = await res.text().catch(() => '');
      throw new Error(`获取模型列表失败 (${res.status}): ${err.slice(0, 200)}`);
    }
  } catch (err: any) {
    if (provider.id !== 'local') throw err;
  }

  // Fallback for local Ollama native endpoint (/api/tags)
  const origin = base.replace(/\/v1$/i, '');
  const ollamaRes = await fetch(`${origin}/api/tags`);
  if (!ollamaRes.ok) {
    throw new Error(`无法连接本地模型服务 (${ollamaRes.status})，请确认 Ollama / LM Studio 已启动。`);
  }
  const ollamaData = (await ollamaRes.json()) as any;
  const localModels: string[] = (ollamaData?.models || []).map((m: any) => String(m?.name || m?.model || '')).filter(Boolean);
  return Array.from(new Set(localModels)).sort();
}

// --- Domain AI Tasks ---

export interface NoteSummaryResult {
  abstract: string;
  keyPoints: string[];
  concepts: { name: string; definition: string }[];
  relations: { source: string; target: string; relation: string }[];
  outline: string[];
  suggestedCategory: string;
  suggestedTags: string[];
  difficulty: '基础' | '进阶' | '高阶';
}

export async function summarizeNoteAI(
  title: string,
  content: string,
  existingCategories: string[]
): Promise<NoteSummaryResult> {
  const clipped = stripInlineImages(content).slice(0, 14000);
  const raw = await callLLM(
    [
      {
        role: 'system',
        content: `你是「知悟」个人学习平台的知识提炼专家。请对用户的学习笔记进行深度结构化总结与知识点抽取。
必须严格返回合法 JSON 对象，结构如下：
{
  "abstract": "2-4句话高度凝练的核心摘要",
  "keyPoints": ["核心要点1", "核心要点2", "...(4-7条)"],
  "concepts": [{"name": "核心概念名(2-10字)", "definition": "通俗精准的一句话解释"}],
  "relations": [{"source": "概念A", "target": "概念B", "relation": "关系动词如包含/依赖/对比/导致"}],
  "outline": ["1. 结构脉络一", "2. 结构脉络二"],
  "suggestedCategory": "推荐的学科分类名（优先从已有分类中选择，若均不匹配可给新分类名）",
  "suggestedTags": ["标签1", "标签2", "标签3"],
  "difficulty": "基础" | "进阶" | "高阶"
}
注意：concepts 提炼 3-8 个最具价值的知识点；relations 中的 source 和 target 必须来自 concepts 的 name。`,
      },
      {
        role: 'user',
        content: `已有分类列表：${existingCategories.length ? existingCategories.join('、') : '暂无'}\n\n笔记标题：${title}\n\n笔记正文：\n${clipped}`,
      },
    ],
    { jsonMode: true, temperature: 0.3 }
  );

  const parsed = extractJson<Partial<NoteSummaryResult>>(raw);
  return {
    abstract: parsed.abstract || '已完成笔记分析。',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
    relations: Array.isArray(parsed.relations) ? parsed.relations : [],
    outline: Array.isArray(parsed.outline) ? parsed.outline : [],
    suggestedCategory: parsed.suggestedCategory || '',
    suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags.slice(0, 6) : [],
    difficulty: (['基础', '进阶', '高阶'].includes(parsed.difficulty as string)
      ? parsed.difficulty
      : '进阶') as NoteSummaryResult['difficulty'],
  };
}

export async function synthesizeNotesAI(notes: { title: string; content: string; tags: string[] }[]): Promise<string> {
  const combined = notes
    .map((n, i) => `### 笔记 ${i + 1}：${n.title}\n标签：${n.tags.join(', ') || '无'}\n${stripInlineImages(n.content).slice(0, 3500)}`)
    .join('\n\n---\n\n');

  return callLLM(
    [
      {
        role: 'system',
        content: `你是「知悟」的知识归纳大师。请把用户提供的多篇学习笔记进行跨笔记归纳整合，生成一份高质量的 Markdown 专题复习指南。
请包含以下模块：
1. **全局知识脉络**：串联各篇笔记之间的逻辑关系与核心主线
2. **核心概念横向对比表**（用 Markdown 表格整理易混淆或并列概念）
3. **高价值考点与本质规律**：提炼底层原理与可迁移的思维模型
4. **易错盲区与记忆口诀**：提醒容易混淆的细节
5. **延伸思考题（2-3道）**：帮助深度内化`,
      },
      {
        role: 'user',
        content: `请对以下 ${notes.length} 篇笔记进行深度归纳：\n\n${combined}`,
      },
    ],
    { temperature: 0.4 }
  );
}

export interface GeneratedQuestion {
  noteId: string;
  conceptName: string;
  type: 'single' | 'multiple' | 'boolean' | 'short';
  stem: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  memoryTip: string;
}

export async function generateQuizAI(
  notes: { id: string; title: string; content: string }[],
  config: {
    count: number;
    difficulty: 'easy' | 'medium' | 'hard';
    types: ('single' | 'multiple' | 'boolean' | 'short')[];
    focusConcepts?: string[];
  }
): Promise<GeneratedQuestion[]> {
  const diffLabel = config.difficulty === 'easy' ? '基础巩固' : config.difficulty === 'hard' ? '挑战拔高（注重综合应用与易错辨析）' : '进阶理解';
  const typesStr = config.types.join(', ');
  const context = notes
    .map((n) => `[NOTE_ID:${n.id}] 《${n.title}》\n${stripInlineImages(n.content).slice(0, 3500)}`)
    .join('\n\n---\n\n');

  const focusHint =
    config.focusConcepts && config.focusConcepts.length > 0
      ? `\n请重点针对以下薄弱知识点出题：${config.focusConcepts.join('、')}`
      : '';

  const raw = await callLLM(
    [
      {
        role: 'system',
        content: `你是「知悟」动态出题引擎。请严格基于用户的学习笔记内容出题，拒绝脱离材料的泛泛之谈。
必须严格返回合法 JSON 对象：
{
  "questions": [
    {
      "noteId": "对应材料中的NOTE_ID",
      "conceptName": "考查的核心知识点(2-10字)",
      "type": "single" | "multiple" | "boolean" | "short",
      "stem": "题干（清晰无歧义）",
      "options": ["A. 选项内容", "B. 选项内容", "C. 选项内容", "D. 选项内容"],
      "correctAnswer": "单选题填'A'；多选题填'A,C'（字母逗号分隔无空格）；判断题填'对'或'错'；简答题填精炼的标准参考答案要点",
      "explanation": "详尽解析：解释为什么正确答案对、其他干扰项为什么错",
      "memoryTip": "一句话记忆技巧或口诀"
    }
  ]
}
规则：
- 判断题 options 固定为 ["对", "错"]；简答题 options 为 []；
- 单选和多选题必须有 4 个高质量干扰项（A/B/C/D）；
- 严禁出现“根据笔记第X段”这类生硬表述，题目应当独立完整。`,
      },
      {
        role: 'user',
        content: `请出 ${config.count} 道题。
难度要求：${diffLabel}
允许题型：${typesStr}${focusHint}

学习材料如下：
${context}`,
      },
    ],
    { jsonMode: true, temperature: 0.5 }
  );

  const parsed = extractJson<{ questions?: GeneratedQuestion[] } | GeneratedQuestion[]>(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.questions || [];
  const defaultNoteId = notes[0]?.id || '';

  return list.slice(0, config.count).map((q) => ({
    noteId: q.noteId || defaultNoteId,
    conceptName: q.conceptName || '综合知识',
    type: (['single', 'multiple', 'boolean', 'short'].includes(q.type) ? q.type : 'single') as GeneratedQuestion['type'],
    stem: q.stem || '',
    options:
      q.type === 'boolean'
        ? ['对', '错']
        : q.type === 'short'
        ? []
        : Array.isArray(q.options)
        ? q.options
        : [],
    correctAnswer: String(q.correctAnswer || '').trim(),
    explanation: q.explanation || '',
    memoryTip: q.memoryTip || '',
  }));
}

export async function gradeShortAnswerAI(
  stem: string,
  referenceAnswer: string,
  userAnswer: string
): Promise<{ score: number; isCorrect: boolean; feedback: string }> {
  if (!userAnswer.trim()) {
    return { score: 0, isCorrect: false, feedback: '未作答。请对照参考答案梳理核心要点。' };
  }
  const raw = await callLLM(
    [
      {
        role: 'system',
        content: `你是严谨的阅卷老师。请对比参考答案批改学生的简答题回答，返回合法 JSON：
{
  "score": 0到1之间的小数（如 0.85 表示答对85%要点，>=0.7视为掌握）,
  "isCorrect": true或false,
  "feedback": "指出答对的亮点、遗漏的关键踩分点及改进建议（简明清晰）"
}`,
      },
      {
        role: 'user',
        content: `题目：${stem}\n参考答案：${referenceAnswer}\n用户作答：${userAnswer}`,
      },
    ],
    { jsonMode: true, temperature: 0.2 }
  );

  const parsed = extractJson<{ score?: number; isCorrect?: boolean; feedback?: string }>(raw);
  const score = Math.max(0, Math.min(1, Number(parsed.score ?? 0)));
  return {
    score,
    isCorrect: parsed.isCorrect ?? score >= 0.7,
    feedback: parsed.feedback || '已完成批改。',
  };
}

export async function diagnoseMistakeAI(mistake: {
  stem: string;
  options: string[];
  correctAnswer: string;
  wrongAnswer: string;
  conceptName: string;
  noteExcerpt?: string;
}): Promise<string> {
  return callLLM(
    [
      {
        role: 'system',
        content: `你是「知悟」错题诊断专家。请用清晰、鼓励且直击本质的方式剖析用户的错题，使用 Markdown 输出：
1. **错误根因诊断**：分析用户为什么会选/写错（常见思维误区是什么）
2. **核心原理重构**：用最通俗的语言讲透背后的知识点
3. **秒杀判断法 / 记忆锚点**：下次遇到同类题如何 3 秒锁定正确答案`,
      },
      {
        role: 'user',
        content: `知识点：${mistake.conceptName}
题干：${mistake.stem}
${mistake.options.length ? `选项：\n${mistake.options.join('\n')}` : ''}
正确答案：${mistake.correctAnswer}
我的错误答案：${mistake.wrongAnswer}
${mistake.noteExcerpt ? `\n关联笔记摘录：\n${mistake.noteExcerpt.slice(0, 1500)}` : ''}`,
      },
    ],
    { temperature: 0.35 }
  );
}

export async function generateVariantQuestionAI(mistake: {
  type: string;
  stem: string;
  correctAnswer: string;
  conceptName: string;
  explanation: string;
}): Promise<GeneratedQuestion> {
  const raw = await callLLM(
    [
      {
        role: 'system',
        content: `你是「知悟」变式出题专家。请基于用户曾经做错的原题，出一道「考查同一核心知识点、但换了场景或设问角度」的全新变式题，检验用户是否真正举一反三。
返回合法 JSON 对象：
{
  "conceptName": "核心知识点",
  "type": "single" | "multiple" | "boolean" | "short",
  "stem": "全新变式题题干",
  "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correctAnswer": "答案",
  "explanation": "详细解析（点出与原题的内在联系）",
  "memoryTip": "记忆提示"
}`,
      },
      {
        role: 'user',
        content: `原题类型：${mistake.type}
知识点：${mistake.conceptName}
原题题干：${mistake.stem}
原题答案：${mistake.correctAnswer}
原题解析：${mistake.explanation}`,
      },
    ],
    { jsonMode: true, temperature: 0.6 }
  );

  const q = extractJson<Partial<GeneratedQuestion>>(raw);
  const type = (['single', 'multiple', 'boolean', 'short'].includes(q.type as string)
    ? q.type
    : mistake.type || 'single') as GeneratedQuestion['type'];
  return {
    noteId: '',
    conceptName: q.conceptName || mistake.conceptName || '变式巩固',
    type,
    stem: q.stem || '',
    options: type === 'boolean' ? ['对', '错'] : type === 'short' ? [] : Array.isArray(q.options) ? q.options : [],
    correctAnswer: String(q.correctAnswer || '').trim(),
    explanation: q.explanation || '',
    memoryTip: q.memoryTip || '',
  };
}

export async function generateFlashcardsAI(
  title: string,
  content: string,
  count = 6
): Promise<{ front: string; back: string; hint: string; conceptName: string }[]> {
  const raw = await callLLM(
    [
      {
        role: 'system',
        content: `你是 Anki 主动回忆闪卡制作专家。请从用户的学习笔记中提炼高质量、原子化的记忆闪卡。
要求每张卡片遵循「最小信息原则」（一卡一问，直击关键概念、原理、公式或对比），严格返回 JSON：
{
  "cards": [
    {
      "front": "正面提问（清晰激发主动回忆）",
      "back": "背面精炼答案（可含要点列表或公式）",
      "hint": "简短提示词（可选）",
      "conceptName": "关联概念名"
    }
  ]
}`,
      },
      {
        role: 'user',
        content: `请为以下笔记生成 ${count} 张高质量闪卡。\n标题：${title}\n正文：\n${stripInlineImages(content).slice(0, 10000)}`,
      },
    ],
    { jsonMode: true, temperature: 0.4 }
  );

  const parsed = extractJson<{ cards?: any[] } | any[]>(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.cards || [];
  return list
    .filter((c) => c?.front && c?.back)
    .slice(0, count)
    .map((c) => ({
      front: String(c.front),
      back: String(c.back),
      hint: String(c.hint || ''),
      conceptName: String(c.conceptName || title),
    }));
}

export async function tutorChatAI(
  mode: 'qa' | 'feynman',
  notes: { title: string; content: string }[],
  history: { role: 'user' | 'assistant'; content: string }[],
  userMessage: string
): Promise<string> {
  const messages = buildTutorMessages(mode, notes, history, userMessage);
  return callLLM(messages, { temperature: mode === 'feynman' ? 0.55 : 0.4 });
}

function buildTutorMessages(
  mode: 'qa' | 'feynman',
  notes: { title: string; content: string }[],
  history: { role: 'user' | 'assistant'; content: string }[],
  userMessage: string
): ChatMessage[] {
  const noteContext = notes.length
    ? notes.map((n, i) => `【参考笔记${i + 1}：${n.title}】\n${stripInlineImages(n.content).slice(0, 4000)}`).join('\n\n')
    : '（未指定特定笔记，请结合通用知识与学习方法回答）';

  const systemPrompt =
    mode === 'feynman'
      ? `你是「知悟」的**费曼学习法考官**。你的核心目标不是直接灌输答案，而是通过苏格拉底式追问帮助用户真正讲明白、吃透知识。
工作方式：
1. 每次用户尝试用自己的话解释概念时，先肯定其准确的部分（给一个简短的理解度评估，如 7/10）；
2. 敏锐指出逻辑漏洞、含糊其辞或遗漏的边界条件；
3. 每次只提出 1-2 个直击要害的追问或反例，引导用户用更简单直白的话（像教一个高中生一样）重新阐述；
4. 如果用户实在卡壳，给一个小梯子提示，而不是直接甩大段教科书。

参考学习材料：
${noteContext}`
      : `你是「知悟」的**专属知识助教**。请优先基于用户选定的学习笔记准确、深入地解答问题；如果笔记中未覆盖某部分，可以补充通用知识并明确标出「延伸补充」。善用类比、结构化要点和实例，回答清晰易懂。

参考学习材料：
${noteContext}`;

  return [
    { role: 'system', content: systemPrompt },
    ...history.slice(-12).map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];
}

export async function tutorChatStreamAI(
  mode: 'qa' | 'feynman',
  notes: { title: string; content: string }[],
  history: { role: 'user' | 'assistant'; content: string }[],
  userMessage: string,
  onDelta: (chunk: string) => void
): Promise<string> {
  const provider = getActiveProvider();
  const messages = buildTutorMessages(mode, notes, history, userMessage);
  const temperature = mode === 'feynman' ? 0.55 : 0.4;

  let res: Response;
  if (provider.type === 'gemini') {
    const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(provider.apiKey)}`;
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
        generationConfig: { temperature },
      }),
    });
  } else {
    const base = provider.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: provider.model, messages, temperature, stream: true }),
    });
  }

  if (!res.ok || !res.body) {
    // Graceful fallback to non-streaming call
    const full = await callLLM(messages, { provider, temperature });
    onDelta(full);
    return full;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const json = JSON.parse(dataStr);
        const delta =
          provider.type === 'gemini'
            ? json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || ''
            : json?.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
      } catch {
        // ignore partial JSON chunks
      }
    }
  }
  return fullText.trim();
}
