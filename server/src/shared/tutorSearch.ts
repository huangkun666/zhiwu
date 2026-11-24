import { readPdfPages } from './pdfPages.js';
import { blockLabel, sourceBlocks, sourceFields, type SourceBlock, type TutorSource } from './tutorSources.js';

export interface Unit {
  block: SourceBlock;
  document: Document;
  ordinal: number;
  key: string;
  normalized: string;
}
export interface Document {
  ref: string;
  note: TutorSource;
  units: Unit[];
  header: string;
  coverage: string;
  gap: string;
}

function normalize(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(/[‐‑–−]/g, '-').replace(/\s+/g, ' ');
}

type IndexedBlock = { block: SourceBlock; normalized: string };
type CacheEntry = { inputs: unknown[]; blocks: IndexedBlock[]; size: number };
const cache = new Map<string, CacheEntry>();
let cacheSize = 0;
const maxCachedChars = 3_000_000;

function indexedBlocks(note: TutorSource, hasPages: boolean) {
  // Restore and legacy page repair can change sources while retaining the note's timestamp.
  const inputs = [note.content, note.source_content, note.source_type, note.source_filename,
    typeof note.source_pages === 'string' ? note.source_pages : JSON.stringify(note.source_pages),
    typeof note.chat_excerpts === 'string' ? note.chat_excerpts : JSON.stringify(note.chat_excerpts)];
  const cached = cache.get(note.id);
  if (cached) {
    cache.delete(note.id);
    if (inputs.every((value, i) => value === cached.inputs[i])) {
      cache.set(note.id, cached);
      return cached.blocks;
    }
    cacheSize -= cached.size;
  }
  const all = sourceBlocks(note).map(block => ({ block, normalized: normalize(block.text) }));
  const collapseSpaces = (text: string) => text.replace(/\s+/g, ' ').trim();
  const pageTexts = new Set(hasPages ? all.filter(item => item.block.page).map(item => collapseSpaces(item.block.text)) : []);
  const blocks = all.filter(item => !(item.block.field === 'body' && pageTexts.has(collapseSpaces(item.block.text))));
  const size = inputs.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0)
    + blocks.reduce((sum, item) => sum + item.block.text.length + item.normalized.length + 64, 0);
  if (size <= maxCachedChars) {
    while (cache.size && (cacheSize + size > maxCachedChars || cache.size >= 128)) {
      const [id, oldest] = cache.entries().next().value!;
      cache.delete(id);
      cacheSize -= oldest.size;
    }
    cache.set(note.id, { inputs, blocks, size });
    cacheSize += size;
  }
  return blocks;
}

export function catalog(notes: TutorSource[]): Document[] {
  return notes.filter(note => note.id).map((note, i) => {
    const ref = `N${i + 1}`;
    const labels = [note.title, note.source_filename, Array.isArray(note.tags) ? note.tags.join(' ') : note.tags];
    const header = labels.filter(Boolean).join(' · ').slice(0, 340);
    const pages = note.source_type === 'pdf' ? readPdfPages(note.source_pages, note.source_content || '') : null;
    let coverage = '';
    let gap = '';
    if (pages) {
      const gaps = pages.flatMap((page, i) => page.status === 'text' ? [] : [`${i + 1}(${page.status === 'failed' ? '提取失败' : '无提取文字'})`]);
      coverage = `共 ${pages.length} 个 PDF 页，${pages.length - gaps.length} 页有文字`;
      if (gaps.length) gap = `缺少可检索文字的 PDF 页：${gaps.slice(0, 16).join('、')}${gaps.length > 16 ? ` 等 ${gaps.length} 页` : ''}`;
    } else if (note.source_type === 'pdf') {
      gap = '原件页数和逐页提取情况未知，只能定位已存文字';
    }
    const doc: Document = { ref, note, units: [], header, coverage, gap };
    doc.units = indexedBlocks(note, !!pages).map(({ block, normalized }, i) => ({
      block, ordinal: i + 1, document: doc, key: `${ref} #${i + 1}`, normalized,
    }));
    return doc;
  });
}

const stopWords = new Set('the an and for how what this that are does you can 请问 告诉 如何 什么 怎么 是否 笔记 这份 这个 哪些 资料'.split(' '));
function terms(query: string) {
  const keys = new Set<string>();
  for (const [word] of normalize(query).matchAll(/[a-z\d]+(?:[._:/-][a-z\d]+)*|[\p{Script=Han}]+/gu)) {
    if (/\p{Script=Han}/u.test(word) && word.length > 1) {
      keys.add(word);
      for (let i = 0; i + 1 < word.length; i++) keys.add(word.slice(i, i + 2));
    } else keys.add(word);
  }
  return [...keys].filter(key => !stopWords.has(key)).slice(0, 100);
}

export function search(docs: Document[], query: string, previous = '') {
  const weights = new Map(terms(previous.slice(-300)).map(key => [key, 0.2]));
  for (const key of terms(query.slice(0, 800))) weights.set(key, 1);
  const units = docs.flatMap(doc => doc.units);
  // Rare codes and names should outrank words repeated on every page of a specification.
  for (const [key, weight] of weights) {
    let hits = 0;
    for (const unit of units) if (unit.normalized.includes(key)) hits++;
    weights.set(key, weight * (1 + Math.log((units.length + 1) / (hits + 1))));
  }
  const titleScores = new Map(docs.map(doc => {
    const header = normalize(doc.header);
    let score = 0;
    for (const [word, weight] of weights) if (header.includes(word)) score += weight;
    return [doc, score];
  }));
  return units.map(unit => {
    let score = titleScores.get(unit.document) || 0;
    for (const [word, weight] of weights) if (unit.normalized.includes(word)) score += weight * 2;
    return { unit, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.unit);
}

// Literal lookup scans the underlying displayed field so hard block boundaries cannot swallow a code.
export function exactSearch(docs: Document[], literal: string, offset: number, limit: number) {
  let total = 0;
  const hits: { unit: Unit; position: number }[] = [];
  if (!literal) return { total, hits };
  for (const doc of docs) {
    for (const field of sourceFields(doc.note)) {
      const units = doc.units.filter(u => u.block.field === field.field && u.block.excerptId === field.excerptId);
      let index = 0;
      for (let pos = field.text.indexOf(literal); pos >= 0; pos = field.text.indexOf(literal, pos + 1)) {
        while (index < units.length && units[index].block.end <= pos) index++;
        if (index >= units.length) break;
        if (pos < units[index].block.start) continue;
        if (total++ >= offset && hits.length < limit) hits.push({ unit: units[index], position: pos + 1 });
      }
    }
  }
  return { total, hits };
}

export function nearby(unit: Unit) {
  return unit.document.units.slice(Math.max(0, unit.ordinal - 2), unit.ordinal + 1)
    .filter(other => other.block.field === unit.block.field && other.block.excerptId === unit.block.excerptId);
}

export function describe(doc: Document) {
  return [doc.ref, doc.header, doc.note.updated_at ? `笔记更新 ${doc.note.updated_at.slice(0, 10)}` : '',
    `${doc.units.length} 个可读段`, doc.coverage, doc.gap].filter(Boolean).join(' | ');
}

export function unitLabel(unit: Unit) {
  return blockLabel(unit.block) + (unit.block.tableHeader ? `（表头：${unit.block.tableHeader}）` : '');
}

export function preview(unit: Unit, query: string) {
  const words = terms(query).sort((a, b) => b.length - a.length);
  const pos = words.map(word => unit.normalized.indexOf(word)).find(pos => pos >= 0) ?? 0;
  const start = Math.max(0, pos - 80);
  return `${unit.key} · ${unitLabel(unit)}\n${start ? '…' : ''}${unit.block.text.slice(start, start + 300)}`;
}
