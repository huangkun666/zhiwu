import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { callVisionOCR, cleanOcrMarkdown, extractSmartTitle } from './ai.js';

const require = createRequire(import.meta.url);
// Import internal pdf-parse implementation directly to avoid its known test-file loading quirk
const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }> = require('pdf-parse/lib/pdf-parse.js');

export interface ParsedFileResult {
  title: string;
  content: string;
  sourceType: 'markdown' | 'text' | 'pdf' | 'docx' | 'image';
  ocrPending?: boolean;
  warning?: string;
}

export async function parseUploadedFile(
  filePath: string,
  originalName: string,
  mimeType: string,
  publicAttachmentUrl?: string
): Promise<ParsedFileResult> {
  const ext = path.extname(originalName).toLowerCase();
  const baseTitle = path.basename(originalName, ext).trim() || '未命名笔记';

  // 1. Markdown / Plain text
  if (ext === '.md' || ext === '.markdown' || ext === '.txt' || mimeType.startsWith('text/')) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    // Extract H1 title if present in markdown
    const h1 = raw.match(/^#\s+(.+)$/m);
    const title = h1 ? h1[1].trim() : baseTitle;
    return {
      title,
      content: raw.trim(),
      sourceType: ext === '.txt' ? 'text' : 'markdown',
    };
  }

  // 2. PDF
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    const buf = fs.readFileSync(filePath);
    const parsed = await pdfParse(buf);
    const cleaned = (parsed.text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const content = cleaned
      ? `> 来源文件：\`${originalName}\`（共 ${parsed.numpages || '?'} 页）\n\n${cleaned}`
      : `> 来源 PDF 文件：\`${originalName}\`（未能提取到纯文本，可能是扫描版 PDF，建议截图后使用「拍照/图片导入」通过视觉模型识别）`;

    return {
      title: baseTitle,
      content,
      sourceType: 'pdf',
    };
  }

  // 3. Word (.docx)
  if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const buf = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer: buf });
    const cleaned = (result.value || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      title: baseTitle,
      content: cleaned || `> 已导入 Word 文档：\`${originalName}\``,
      sourceType: 'docx',
    };
  }

  // 4. Image / Photo Notes -> Requires Active Model to Support Vision
  if (
    ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext) ||
    mimeType.startsWith('image/')
  ) {
    const buf = fs.readFileSync(filePath);
    const base64 = buf.toString('base64');
    const resolvedMime = mimeType.startsWith('image/') ? mimeType : `image/${ext.replace('.', '') || 'png'}`;

    // Keep note.content 100% pure Markdown text (image preview is rendered cleanly from attachment_path)
    const rawOcr = await callVisionOCR(base64, resolvedMime);
    const ocrText = cleanOcrMarkdown(rawOcr);
    return {
      title: extractSmartTitle(ocrText, baseTitle),
      content: ocrText,
      sourceType: 'image',
    };
  }

  // Fallback: try reading as UTF-8 text
  const raw = fs.readFileSync(filePath, 'utf-8');
  return {
    title: baseTitle,
    content: raw,
    sourceType: 'text',
  };
}
