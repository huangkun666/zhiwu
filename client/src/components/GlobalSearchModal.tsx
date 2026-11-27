import { useEffect, useState } from 'react';
import { FileText, Search, X } from 'lucide-react';
import { api } from '../api/client';
import type { LibrarySearchResults } from '../../../server/src/shared/tutorSearch';
import { KnowledgePointCard } from './NoteKnowledge';

const empty: LibrarySearchResults = { points: [], passages: [], notes: [] };

interface GlobalSearchModalProps {
  open: boolean;
  onClose: () => void;
  onSelectNote: (noteId: string, citation?: URLSearchParams) => void;
}

export function GlobalSearchModal({ open, onClose, onSelectNote }: GlobalSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(false);
    const timer = setTimeout(async () => {
      try {
        const result = query.trim() ? await api.searchLibrary(query)
          : { ...empty, notes: (await api.getNotes()).slice(0, 12).map(({ id, title }) => ({ id, title })) };
        if (current) setResults(result);
      } catch {
        if (current) setError(true);
      } finally {
        if (current) setLoading(false);
      }
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [query, open]);

  if (!open) return null;
  const select = (noteId: string, citation?: URLSearchParams) => {
    onSelectNote(noteId, citation);
    onClose();
  };
  const hasResults = results.points.length || results.passages.length || results.notes.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-sm pt-12 sm:pt-20 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl zw-modal rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
      >
        <div
          className="flex items-center gap-3 px-4 py-3.5 border-b"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <Search className="w-4 h-4 text-[var(--text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索知识点、原文或笔记..."
            className="flex-1 bg-transparent text-sm outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={onClose}
            aria-label="关闭搜索"
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto divide-y divide-[var(--border-hairline)]">
          {loading ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)]">检索中...</div>
          ) : error ? (
            <div role="status" className="p-8 text-center text-xs text-[var(--text-muted)]">暂时无法搜索，请重试。</div>
          ) : !hasResults ? (
            <div role="status" className="p-8 text-center text-xs text-[var(--text-muted)]">未找到匹配结果</div>
          ) : (
            <>
              {results.points.length > 0 && <section className="divide-y divide-[var(--border-hairline)]">
                <h2 className="px-4 py-2 text-xs font-medium text-[var(--text-muted)]">知识点</h2>
                {results.points.map(point => <KnowledgePointCard key={point.id} point={point} onOpenSource={select} />)}
              </section>}
              {results.passages.length > 0 && <section className="divide-y divide-[var(--border-hairline)]">
                <h2 className="px-4 py-2 text-xs font-medium text-[var(--text-muted)]">原文</h2>
                {results.passages.map(({ source, text }) => (
                  <button key={source.params} type="button" onClick={() => select(source.noteId, new URLSearchParams(source.params))}
                    className="block w-full px-4 py-3 text-left hover:bg-[var(--bg-hover)]">
                    <span className="block text-xs text-[var(--text-secondary)]">{source.title} · {source.label}</span>
                    <span className="mt-1 block whitespace-pre-wrap break-words text-sm">{text}</span>
                  </button>
                ))}
              </section>}
              {results.notes.map(note => (
                <button key={note.id} type="button" onClick={() => select(note.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-hover)]">
                  <FileText className="size-4 shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate text-sm font-medium">{note.title}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
