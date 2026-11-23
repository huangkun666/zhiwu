import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileText } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { Note } from '../types';
import { loadPdf } from '../utils/pdf';
import { MarkdownView } from './MarkdownView';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const controlClass = 'px-2.5 py-1.5 rounded-lg zw-btn-secondary text-xs cursor-pointer disabled:opacity-50';

const originalMime = {
  pdf: 'application/pdf', docx: DOCX_MIME, markdown: 'text/markdown', text: 'text/plain',
} as const;

function getOriginalUrl(note: Note): string | null {
  const url = note.attachment_path;
  if (!url || note.source_type === 'image') return null;
  const mime = originalMime[note.source_type];
  if (!mime) return null;
  return /^\/uploads\/[a-z0-9][\w.-]*$/i.test(url) || url.startsWith(`data:${mime};base64,`)
    || url.startsWith('data:application/octet-stream;base64,') ? url : null;
}

function decodeAttachment(url: string): Uint8Array<ArrayBuffer> {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface PreviewProps {
  url: string;
  onError: (failed: boolean) => void;
}

function PdfPreview({ url, onError }: PreviewProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [renderedPage, setRenderedPage] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let disposed = false;
    let task: PDFDocumentLoadingTask | undefined;
    async function open() {
      task = await loadPdf(url.startsWith('data:') ? decodeAttachment(url) : url);
      if (disposed) {
        task.promise.catch(() => {});
        await task.destroy();
        return;
      }
      const document = await task.promise;
      if (!disposed) setPdf(document);
    }
    open().catch(() => { if (!disposed) onError(true); });
    return () => {
      disposed = true;
      task?.destroy().catch(() => {});
    };
  }, [url, onError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    let disposed = false;
    let render: RenderTask | undefined;
    async function draw() {
      const pdfPage = await pdf!.getPage(page);
      if (disposed) return;
      const size = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(3, 1800 / Math.max(size.width, size.height)) });
      canvas!.width = Math.ceil(viewport.width);
      canvas!.height = Math.ceil(viewport.height);
      render = pdfPage.render({ canvas: canvas!, viewport });
      await render.promise;
      if (!disposed) setRenderedPage(page);
    }
    draw().catch(() => { if (!disposed) onError(true); });
    return () => {
      disposed = true;
      render?.cancel();
    };
  }, [pdf, page, onError]);

  return (
    <div className="space-y-2">
      {pdf && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          <button type="button" className={controlClass} disabled={page <= 1 || renderedPage !== page} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="tabular-nums" aria-live="polite">第 {page} / {pdf.numPages} 页</span>
          <button type="button" className={controlClass} disabled={page >= pdf.numPages || renderedPage !== page} onClick={() => setPage(page + 1)}>下一页</button>
          <button type="button" className={controlClass} onClick={() => setZoomed(!zoomed)}>{zoomed ? '适应宽度' : '放大'}</button>
        </div>
      )}
      {renderedPage !== page && <p role="status" className="text-xs text-[var(--text-muted)]">正在加载 PDF 页面…</p>}
      <div className="max-h-[65dvh] overflow-auto rounded-lg" key={page}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`PDF 第 ${page} 页`}
          hidden={renderedPage !== page}
          className={zoomed ? 'h-auto w-[58rem] max-w-none' : 'mx-auto h-auto max-w-full shadow-sm'}
        />
      </div>
    </div>
  );
}

function WordPreview({ url, onError }: PreviewProps) {
  const [html, setHtml] = useState('');
  const [height, setHeight] = useState(192);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    async function read() {
      let arrayBuffer: ArrayBuffer;
      if (url.startsWith('data:')) {
        arrayBuffer = decodeAttachment(url).buffer;
      } else {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('原文件无法读取');
        arrayBuffer = await response.arrayBuffer();
      }
      const module = await import('mammoth');
      const mammoth = module.default || module;
      const { value } = await mammoth.convertToHtml({ arrayBuffer }, { externalFileAccess: false });
      if (!value.trim()) throw new Error('Word 文档没有可预览的内容');
      if (!disposed) {
        const template = document.createElement('template');
        template.innerHTML = value;
        template.content.querySelectorAll('a[href]').forEach((link) => link.removeAttribute('href'));
        setHtml(template.innerHTML);
      }
    }
    read().catch(() => { if (!disposed) onError(true); });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [url, onError]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver((entries) => {
      const body = entries[0]?.target;
      if (body) setHeight(Math.max(68, Math.ceil(body.getBoundingClientRect().height) + 2));
    });
    const observeBody = () => {
      observer.disconnect();
      const body = frame.contentDocument?.body;
      if (body) observer.observe(body);
    };
    frame.addEventListener('load', observeBody);
    observeBody();
    return () => {
      frame.removeEventListener('load', observeBody);
      observer.disconnect();
    };
  }, [html]);

  if (!html) return <p role="status" className="text-xs text-[var(--text-muted)]">正在加载 Word 预览…</p>;

  // The preview contains document-generated HTML. Keep it in a sandbox with only embedded images enabled.
  const preview = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: clamp(1rem, 4vw, 2rem); background: light-dark(#fff, #131316); color: light-dark(#1d1d1f, #f4f4f5); font: 16px/1.65 system-ui, sans-serif; overflow-wrap: anywhere; }
      h1, h2, h3, p { margin: 0 0 .75em; }
      h1, h2, h3 { line-height: 1.3; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid light-dark(#e0e1e5, #36363a); padding: .5rem .65rem; text-align: left; vertical-align: top; }
      th p, td p, body > :last-child { margin-bottom: 0; }
      tr:nth-child(even) { background: light-dark(#f6f7f9, #1c1c20); }
      img { max-width: 100%; height: auto; }
    </style></head><body>${html}</body></html>`;

  return (
    <iframe
      ref={frameRef}
      title="Word 文档预览"
      sandbox="allow-same-origin"
      srcDoc={preview}
      style={{ height }}
      className="block w-full max-h-[65dvh] rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-card-solid)]"
    />
  );
}

export function NoteSource({ note, content }: { note: Note; content: string }) {
  const [open, setOpen] = useState(false);
  const [textOnly, setTextOnly] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const originalUrl = getOriginalUrl(note);
  const documentNote = note.source_type === 'pdf' || note.source_type === 'docx';
  const documentUrl = documentNote ? originalUrl : null;
  const extension = note.source_type === 'markdown' ? 'md' : note.source_type === 'text' ? 'txt' : note.source_type;
  const downloadName = note.source_filename || `${note.title}.${extension}`;

  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group rounded-xl border overflow-hidden bg-[var(--bg-subtle)] border-[var(--border-hairline)]"
    >
      <summary className="flex min-h-12 cursor-pointer list-none select-none items-center gap-2.5 px-3 py-2 hover:bg-[var(--bg-hover)]">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-[var(--bg-card-solid)] text-[var(--text-secondary)]">
          <FileText className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium sm:text-sm">{note.source_filename || '原文'}</span>
        <span className="shrink-0 text-xs text-[var(--text-secondary)]">{open ? '收起原文' : '查看原文'}</span>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-secondary)] group-open:rotate-180" />
      </summary>
      {open && (
        <div className="px-3 py-3 space-y-3 border-t border-[var(--border-hairline)]">
          {originalUrl && (
            <div className="flex flex-wrap gap-2">
              <a className={`${controlClass} inline-flex items-center gap-1.5`} href={originalUrl} download={downloadName}>
                <Download className="w-3.5 h-3.5" /> 下载原文件
              </a>
              {documentUrl && content.trim() && !previewFailed && (
                <button type="button" className={controlClass} aria-pressed={textOnly} onClick={() => setTextOnly(!textOnly)}>
                  {textOnly ? '查看文档预览' : note.source_content == null ? '查看旧版笔记文字' : '查看提取文本'}
                </button>
              )}
            </div>
          )}
          {documentNote && !documentUrl && (
            <p className="text-xs text-[var(--text-muted)]">这篇笔记仅存有提取文本。重新导入原文件即可查看排版。</p>
          )}
          {previewFailed && (
            <p role="status" className="text-xs text-[var(--text-muted)]">无法预览此文件。可尝试下载原文件，或重新导入。</p>
          )}
          {documentUrl && !textOnly && !previewFailed ? (
            note.source_type === 'pdf'
              ? <PdfPreview url={documentUrl} onError={setPreviewFailed} />
              : <WordPreview url={documentUrl} onError={setPreviewFailed} />
          ) : content.trim() ? (
            <div className="max-h-[65dvh] overflow-auto p-2.5">
              {note.source_type === 'markdown'
                ? <MarkdownView content={content} />
                : <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{content}</div>}
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">未提取到可阅读的文本。</p>
          )}
        </div>
      )}
    </details>
  );
}
