import { FileText, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import type { TrashedNote } from '../types';

interface TrashListProps {
  notes: TrashedNote[];
  loading: boolean;
  error: string;
  pending: boolean;
  onReload: () => void;
  onRestore: (id: string) => void;
  onDelete: (note: TrashedNote) => void;
}

export function TrashList({ notes, loading, error, pending, onReload, onRestore, onDelete }: TrashListProps) {
  if (loading && !notes.length) {
    return <div role="status" className="zw-card flex items-center justify-center gap-2 rounded-2xl p-8 text-xs text-[var(--text-muted)]">
      <Loader2 className="size-4 animate-spin" /> 正在读取回收站
    </div>;
  }

  if (error) {
    return <div role="alert" className="zw-card space-y-3 rounded-2xl p-6 text-sm">
      <p>{error}</p>
      <button type="button" onClick={onReload} className="zw-btn-secondary rounded-lg px-3 py-1.5 text-xs">重试</button>
    </div>;
  }

  if (notes.length === 0) {
    return <div className="zw-card rounded-2xl p-10 text-center">
      <Trash2 className="mx-auto mb-3 size-6 text-[var(--text-muted)]" />
      <p className="text-sm font-medium">回收站为空</p>
    </div>;
  }

  return (
    <div className="zw-card divide-y divide-[var(--border-hairline)] rounded-2xl">
      {notes.map((note) => (
        <div key={note.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--bg-subtle)] text-[var(--text-secondary)]">
              <FileText className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="break-words text-sm font-semibold">{note.title}</h3>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
                <time dateTime={note.deleted_at}>{new Date(note.deleted_at).toLocaleString()} 移入</time>
                {note.category_name && <span>{note.category_name}</span>}
                {note.source_filename && <span className="break-all">{note.source_filename}</span>}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onRestore(note.id)}
              disabled={pending}
              className="zw-btn-primary inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" /> 恢复
            </button>
            <button
              type="button"
              onClick={() => onDelete(note)}
              disabled={pending}
              className="inline-flex min-h-9 items-center rounded-lg px-2 text-xs text-[var(--danger-fg)] hover:bg-[var(--danger-bg)] disabled:opacity-50"
            >
              永久删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
