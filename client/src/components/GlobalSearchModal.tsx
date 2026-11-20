import { useEffect, useState } from 'react';
import { FileText, Search, Sparkles, X } from 'lucide-react';
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-[2px] pt-12 sm:pt-20 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-[#E8E5DF] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[#EFECE6]">
          <Search className="w-5 h-5 text-[#6F6B63]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="全文检索笔记标题、正文或标签..."
            className="flex-1 text-sm sm:text-base outline-none text-[#1C1B18] placeholder:text-[#9C978E]"
          />
          <button onClick={onClose} className="p-1.5 rounded-lg text-[#6F6B63] hover:bg-[#F5F3EE]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto divide-y divide-[#F3F0EA]">
          {loading ? (
            <div className="p-8 text-center text-sm text-[#8A857C]">检索中...</div>
          ) : results.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8A857C]">未找到匹配的笔记</div>
          ) : (
            results.map((note) => (
              <button
                key={note.id}
                onClick={() => {
                  onSelectNote(note.id);
                  onClose();
                }}
                className="w-full text-left px-4 py-3.5 hover:bg-[#F8F7F4] transition flex items-start gap-3"
              >
                <FileText className="w-4 h-4 text-[#3B5BDB] mt-1 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-[#1C1B18] truncate">{note.title}</span>
                    {note.summary && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-[#F3F5FC] text-[#3B5BDB] shrink-0">
                        <Sparkles className="w-3 h-3" /> 已总结
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#6F6B63] line-clamp-2 mt-1">
                    {note.summary?.abstract || note.content.replace(/[#*`>]/g, '').slice(0, 120)}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {note.category_name && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#F1EFEA] text-[#524F49]">
                        {note.category_name}
                      </span>
                    )}
                    {note.tags.slice(0, 3).map((t) => (
                      <span key={t} className="text-[11px] text-[#7A756C]">
                        #{t}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
