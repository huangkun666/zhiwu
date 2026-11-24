import { readFile } from 'node:fs/promises';
import { countWords, db, inTransaction, syncNoteFts } from '../db.js';
import { noteStudyText } from '../shared/noteContent.js';
import { canReplacePdfText, needsVisualRead, pdfVisualScale, pdfVisionPrompt, readPdfPages, readPdfTranscription } from '../shared/pdfPages.js';
import { embeddedOriginal, storedOriginalPath } from './noteOriginal.js';
import { extractDesktopPdf, loadDesktopPdf } from './parser.js';
import { callVisionOCR, getActiveModelCapability } from './ai.js';

interface LegacyPdf {
  id: string;
  attachment_path: string;
  source_content: string | null;
}
const indexing = new Map<string, Promise<void>>();
const retryAfter = new Map<string, number>();

async function originalBytes(attachment: string) {
  const file = storedOriginalPath(attachment);
  const bytes = file ? await readFile(file) : embeddedOriginal(attachment)?.bytes;
  return bytes?.subarray(0, 1024).includes('%PDF-') ? bytes : null;
}

async function rebuildPdf(note: LegacyPdf) {
  const key = JSON.stringify([note.id, note.attachment_path.length, note.attachment_path.slice(-96)]);
  if ((retryAfter.get(key) ?? 0) > Date.now()) return;
  let rebuilt: Awaited<ReturnType<typeof extractDesktopPdf>>;
  try {
    const bytes = await originalBytes(note.attachment_path);
    if (!bytes) return;
    rebuilt = await extractDesktopPdf(bytes);
  } catch {
    retryAfter.set(key, Date.now() + 60_000);
    return; // Keep legacy source text available if the original is unavailable or cannot be opened.
  }
  if (!canReplacePdfText(note.source_content, rebuilt)) {
    retryAfter.set(key, Date.now() + 60_000);
    return;
  }
  inTransaction(() => {
    const current = db.prepare(`SELECT title, content, chat_excerpts, tags FROM active_notes WHERE id = ?
      AND source_type = 'pdf' AND attachment_path = ? AND source_content IS ? AND source_pages IS NULL`)
      .get(note.id, note.attachment_path, note.source_content) as
      { title: string; content: string; chat_excerpts: string; tags: string } | undefined;
    if (!current) return;
    const text = noteStudyText({ ...current, source_content: rebuilt.content });
    db.prepare('UPDATE notes SET source_content = ?, source_pages = ?, word_count = ? WHERE id = ?')
      .run(rebuilt.content, JSON.stringify(rebuilt.sourcePages), countWords(text), note.id);
    syncNoteFts(note.id, current.title, text, JSON.parse(current.tags || '[]'));
  });
}

async function renderPhysicalPage(bytes: Buffer, number: number) {
  const loading = await loadDesktopPdf(bytes);
  try {
    const pdf = await loading.promise;
    if (number > pdf.numPages) return null;
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: pdfVisualScale(page.getViewport({ scale: 1 })) });
    // PDF.js supplies a Node canvas factory. Its JS typings expose the factory only as "object".
    const factory = pdf.canvasFactory as {
      create(w: number, h: number): { canvas: HTMLCanvasElement & { toBuffer(type: 'image/png'): Buffer } };
    };
    const { canvas } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      await page.render({ canvas, viewport }).promise;
      return canvas.toBuffer('image/png').toString('base64');
    } finally {
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } finally { await loading.destroy(); }
}

export async function readPdfPageWithVision(id: string, number: number): Promise<string | null> {
  const capability = getActiveModelCapability();
  if (!capability.supportsVision || !capability.configured) return null;
  const note = db.prepare(`SELECT attachment_path, source_content, source_pages FROM active_notes
    WHERE id = ? AND source_type = 'pdf' AND attachment_path IS NOT NULL`).get(id) as
    { attachment_path: string; source_content: string | null; source_pages: string | null } | undefined;
  if (!note || !needsVisualRead(readPdfPages(note.source_pages, note.source_content ?? ''), number)) return null;
  const stillAvailable = () => db.prepare(`SELECT 1 FROM active_notes WHERE id = ? AND source_type = 'pdf'
    AND attachment_path = ? AND source_pages = ? AND source_content IS ?`).get(id, note.attachment_path, note.source_pages, note.source_content);
  try {
    const bytes = await originalBytes(note.attachment_path);
    const image = bytes && await renderPhysicalPage(bytes, number);
    if (!image || !stillAvailable()) return null;
    const reply = await callVisionOCR(image, 'image/png', pdfVisionPrompt);
    return stillAvailable() ? readPdfTranscription(reply) : null;
  } catch { return null; }
}

export async function ensurePdfPageIndexes(ids?: readonly string[]) {
  if (ids && !ids.length) return;
  const now = Date.now();
  for (const [key, until] of retryAfter) if (until <= now) retryAfter.delete(key);
  const filter = ids ? 'AND id IN (SELECT value FROM json_each(?))' : '';
  const notes = db.prepare(`SELECT id, attachment_path, source_content FROM active_notes
    WHERE source_type = 'pdf' AND source_pages IS NULL AND attachment_path IS NOT NULL ${filter}`)
    .all(...(ids ? [JSON.stringify(ids)] : [])) as unknown as LegacyPdf[];
  for (const note of notes) {
    let pending = indexing.get(note.id);
    if (!pending) {
      pending = rebuildPdf(note).finally(() => indexing.delete(note.id));
      indexing.set(note.id, pending);
    }
    await pending;
  }
}
