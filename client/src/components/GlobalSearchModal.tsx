import { useEffect, useState } from 'react';
import { FileText, Search, X } from 'lucide-react';
import { api } from '../api/client';
import type { Note } from '../types';

interface GlobalSearchModalProps {
  open: boolean;
  onClose: () => void;
  onSelectNote: (noteId: string) => void;
}

export function GlobalSearchModal({ open, onClose, onSelectNote }: GlobalSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const list = await api.getNotes({ q: query.trim() || undefined });
        setResults(list.slice(0, 12));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-sm pt-12 sm:pt-20 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl zw-modal rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
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
            placeholder="全文检索笔记标题、正文或标签..."
            className="flex-1 bg-transparent text-sm outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto divide-y divide-[var(--border-hairline)]">
          {loading ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)]">检索中...</div>
          ) : results.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)]">未找到匹配笔记</div>
          ) : (
            results.map((note) => (
              <button
                key={note.id}
                onClick={() => {
                  onSelectNote(note.id);
                  onClose();
                }}
                className="w-full text-left px-4 py-3.5 hover:bg-[var(--bg-hover)] transition flex items-start gap-3 cursor-pointer"
              >
                <FileText className="w-4 h-4 text-[var(--text-muted)] mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{note.title}</span>
                    {note.summary && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                      >
                        已总结
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-muted)] line-clamp-2 mt-1">
                    {note.summary?.abstract ||
                      (note.content || note.chat_excerpts?.[0]?.content || note.source_content || note.source_filename || '')
                        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
                        .replace(/[#*`>]/g, '')
                        .trim()
                        .slice(0, 120)}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
