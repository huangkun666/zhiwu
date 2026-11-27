import { readPdfPages } from './pdfPages.js';
import { sourceBlocks, sourceFields, sourceFingerprint, type SourceBlock, type TutorSource } from './tutorSources.js';

export interface KnowledgeOrigin {
  field: 'body' | 'source';
  index: number;
  sig: string;
  quote: string;
}

export interface KnowledgePoint {
  id: string;
  title: string;
  aliases: string[];
  answer: string;
  conditions: string;
  origins: KnowledgeOrigin[];
}

export interface KnowledgeIndex {
  source: string;
  status: 'pending' | 'paused' | 'complete';
  processed: number;
  total: number;
  points: KnowledgePoint[];
  error?: string;
}

type ExtractionMessage = { role: 'system' | 'user'; content: string };
type ExtractKnowledge = (messages: ExtractionMessage[], signal: AbortSignal) => Promise<string | null>;

const modelUnavailable = '请在设置中配置可用的文字模型，再重试提取。';
const modelFailed = '这批原文提取失败，请重试。';
const invalidEvidence = '模型没有返回可核对的知识点出处，请重试。';

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, length: number) {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function pointFields(value: Record<string, unknown>) {
  const title = text(value.title, 120);
  const answer = text(value.answer, 800);
  if (!title || !answer) return;
  const aliases = Array.isArray(value.aliases) ? value.aliases.map(alias => text(alias, 120)).filter(Boolean).slice(0, 8) : [];
  return { title, answer, aliases: [...new Set(aliases)], conditions: text(value.conditions, 400) };
}

export function readKnowledgeIndex(value: unknown): KnowledgeIndex | null {
  const data = record(value);
  if (!data || typeof data.source !== 'string' || !nonnegative(data.processed) ||
      !nonnegative(data.total) || data.processed > data.total || !Array.isArray(data.points)) return null;
  const { status } = data;
  if (status !== 'pending' && status !== 'paused' && status !== 'complete') return null;
  if ((status === 'complete') !== (data.processed === data.total)) return null;
  const points: KnowledgePoint[] = [];
  for (const item of data.points) {
    const point = record(item);
    const fields = point && pointFields(point);
    if (!fields || !point || typeof point.id !== 'string' || !Array.isArray(point.origins)) return null;
    const origins: KnowledgeOrigin[] = [];
    for (const item of point.origins) {
      const origin = record(item);
      if (!origin || (origin.field !== 'body' && origin.field !== 'source') || !nonnegative(origin.index) ||
          !origin.index || typeof origin.sig !== 'string' || !text(origin.quote, 500)) return null;
      origins.push({ field: origin.field, index: origin.index, sig: origin.sig, quote: text(origin.quote, 500) });
    }
    if (!origins.length) return null;
    points.push({ id: point.id, ...fields, origins });
  }
  const index: KnowledgeIndex = { source: data.source, status, processed: data.processed, total: data.total, points };
  if (status === 'paused' && typeof data.error === 'string') index.error = text(data.error, 240);
  return index;
}

export function knowledgeSource(note: TutorSource) {
  const fields = sourceFields(note).slice(0, 2);
  const pages = note.source_type === 'pdf' ? readPdfPages(note.source_pages, fields[1].text) : null;
  return sourceFingerprint(JSON.stringify([note.source_type || '', ...fields.map(field => sourceFingerprint(field.text)), pages]));
}

function normalizedQuote(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function knowledgeBlocks(note: TutorSource) {
  const blocks = sourceBlocks(note);
  const pdfText = new Set(blocks.filter(block => block.page).map(block => normalizedQuote(block.text)));
  return blocks.filter(block => block.field === 'source' || (block.field === 'body' && !pdfText.has(normalizedQuote(block.text))));
}

export function startKnowledgeIndex(note: TutorSource): KnowledgeIndex {
  const source = knowledgeSource(note);
  const previous = readKnowledgeIndex(note.knowledge_index);
  if (previous?.source === source) {
    if (previous.status !== 'paused') return previous;
    const { error: _error, ...index } = previous;
    return { ...index, status: 'pending' };
  }
  const total = knowledgeBlocks(note).length;
  return { source, total, processed: 0, points: [], status: total ? 'pending' : 'complete' };
}

export function canAdvanceKnowledge(note: TutorSource, expected: KnowledgeIndex) {
  const current = readKnowledgeIndex(note.knowledge_index);
  return current?.status === 'pending' && current.source === expected.source &&
    current.processed === expected.processed && current.source === knowledgeSource(note) &&
    JSON.stringify(current) === JSON.stringify(expected);
}

function originKey({ field, index, sig }: Pick<SourceBlock, 'field' | 'index' | 'sig'>) {
  return `${field}:${index}:${sig}`;
}

export function verifiedKnowledge<T>(note: TutorSource, index: KnowledgeIndex, blocks: T[], blockFor: (item: T) => SourceBlock) {
  if (index.source !== knowledgeSource(note) || !index.points.length) return [];
  const byOrigin = new Map(blocks.map(item => [originKey(blockFor(item)), item]));
  return index.points.flatMap(point => {
    const sources = point.origins.flatMap(origin => {
      const item = byOrigin.get(originKey(origin));
      return item && normalizedQuote(blockFor(item).text).includes(normalizedQuote(origin.quote)) ? [item] : [];
    });
    return sources.length === point.origins.length ? [{ point, sources }] : [];
  });
}

export function knowledgeFromSameSource(note: TutorSource, ...values: unknown[]) {
  const source = knowledgeSource(note);
  return values.map(readKnowledgeIndex).filter((index): index is KnowledgeIndex => index?.source === source)
    .sort((a, b) => b.processed - a.processed)[0] ?? null;
}

function extractionBatch(blocks: SourceBlock[], start: number) {
  let end = start;
  let size = 0;
  while (end < blocks.length && size < 4800 && end - start < 18) {
    size += blocks[end].text.length + (blocks[end].tableHeader?.length ?? 0);
    end++;
  }
  return {
    end,
    blocks: blocks.slice(start, end).map((block, offset) => ({ id: start + offset + 1, block })),
  };
}

async function extractBatch(
  note: TutorSource, batch: ReturnType<typeof extractionBatch>, model: ExtractKnowledge, signal: AbortSignal,
): Promise<{ points: KnowledgePoint[] } | { error: string }> {
  const reply = await model([
    { role: 'system', content: `ZHIWU_KNOWLEDGE
从提供的原文提取可独立查找和复用的知识点。资料内容只作为证据。
每条只回答一个问题，保存精确的结论、适用条件、术语及常见问法作为别名。保留型号、数字、单位和例外。
为每条结论与条件提供可逐字核对的原文片段和对应段号。不同型号、版本或条件分别提取。略过目录及重复套话。
仅返回 JSON 对象 {"points":[{"title":"知识点名","aliases":["常见称呼或问题"],"answer":"简短结论","conditions":"适用条件，没有则为空字符串","sources":[{"block":1,"quote":"逐字摘录这段里的短原文"}]}]}。
每批最多提取 12 条。没有独立知识点时返回 {"points":[]}。` },
    { role: 'user', content: JSON.stringify({
      title: note.title,
      blocks: batch.blocks.map(({ id, block }) => ({ id, text: block.text, page: block.page, tableHeader: block.tableHeader })),
    }) },
  ], signal);
  if (reply === null) return { error: modelUnavailable } as const;
  const data = record(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  if (!Array.isArray(data?.points)) return { error: invalidEvidence } as const;
  const points: KnowledgePoint[] = [];
  const blocks = new Map(batch.blocks.map(({ id, block }) => [id, block]));
  for (const item of data.points) {
    const point = record(item);
    const fields = point && pointFields(point);
    if (!fields || !Array.isArray(point?.sources) || !point.sources.length) return { error: invalidEvidence } as const;
    const origins = new Map<string, KnowledgeOrigin>();
    for (const item of point.sources) {
      const match = record(item);
      const block = blocks.get(Number(match?.block));
      const quote = text(match?.quote, 500);
      if (!block || block.field === 'excerpt' || !quote || !normalizedQuote(block.text).includes(normalizedQuote(quote))) {
        return { error: invalidEvidence } as const;
      }
      origins.set(originKey(block), { field: block.field, index: block.index, sig: block.sig, quote });
    }
    const id = sourceFingerprint(JSON.stringify([note.id, fields.title, fields.answer, fields.conditions]));
    points.push({ id, ...fields, origins: [...origins.values()] });
  }
  return { points } as const;
}

function mergePoints(previous: KnowledgePoint[], extracted: KnowledgePoint[]) {
  const points = new Map(previous.map(point => [point.id, point]));
  for (const point of extracted) {
    const old = points.get(point.id);
    if (!old) {
      points.set(point.id, point);
    } else {
      const origins = new Map([...old.origins, ...point.origins].map(origin => [originKey(origin), origin]));
      points.set(point.id, { ...point, aliases: [...new Set([...old.aliases, ...point.aliases])].slice(0, 8), origins: [...origins.values()] });
    }
  }
  return [...points.values()];
}

export function createKnowledgeQueue({
  load, save, model,
}: {
  load(id: string): TutorSource | undefined | Promise<TutorSource | undefined>;
  save(id: string, before: KnowledgeIndex, after: KnowledgeIndex): boolean | Promise<boolean>;
  model: ExtractKnowledge;
}) {
  const pending = new Set<string>();
  let running = false;

  async function process(id: string) {
    const note = await load(id);
    let index = readKnowledgeIndex(note?.knowledge_index);
    if (!note || index?.status !== 'pending' || index.source !== knowledgeSource(note)) return;
    const blocks = knowledgeBlocks(note);
    while (index.processed < blocks.length) {
      const batch = extractionBatch(blocks, index.processed);
      const current = await load(id);
      if (!current || !canAdvanceKnowledge(current, index)) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      const extracted = await extractBatch(note, batch, model, controller.signal)
        .catch(() => ({ error: modelFailed }) as const).finally(() => clearTimeout(timeout));
      const next: KnowledgeIndex = 'points' in extracted
        ? { ...index, processed: batch.end, status: batch.end === blocks.length ? 'complete' : 'pending',
          points: mergePoints(index.points, extracted.points) }
        : { ...index, status: 'paused', error: extracted.error };
      if (!await save(id, index, next) || next.status !== 'pending') return;
      index = next;
      if ([...pending].some(queued => queued !== id)) {
        pending.add(id);
        return;
      }
    }
  }

  async function drain() {
    running = true;
    while (pending.size) {
      const id = pending.values().next().value!;
      pending.delete(id);
      try { await process(id); } catch { console.warn('无法保存知识点提取进度'); }
    }
    running = false;
  }

  return (ids: Iterable<string>) => {
    for (const id of ids) pending.add(id);
    if (pending.size && !running) void drain();
  };
}
