import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pencil, Search, Trash2, X } from 'lucide-react';
import { tutorModeLabels } from '../../../server/src/shared/tutorMode';
import type { TutorHistoryItem } from '../types';

export interface TutorHistoryProps {
  history: {
    query: string;
    setQuery: (query: string) => void;
    items: TutorHistoryItem[];
    loading: boolean;
    error: string;
    hasMore: boolean;
    loadMore: () => void;
    retry: () => void;
  };
  activeId?: string;
  mobileOpen: boolean;
  onClose: () => void;
  onSelect: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

type Editor = { id: string; kind: 'rename' | 'delete' };
type PanelProps = Omit<TutorHistoryProps, 'mobileOpen' | 'onClose'> & { onClose?: () => void };

function MobileHistoryDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    const viewport = window.visualViewport;
    const fitKeyboard = () => {
      if (viewport) dialog.style.height = `${viewport.height}px`;
    };
    fitKeyboard();
    viewport?.addEventListener('resize', fitKeyboard);
    dialog.showModal();
    return () => {
      viewport?.removeEventListener('resize', fitKeyboard);
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const closeOnDesktop = () => { if (desktop.matches) onClose(); };
    closeOnDesktop();
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      id="tutor-history"
      aria-labelledby="tutor-history-heading"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
      className="zw-modal fixed inset-y-0 left-0 m-0 h-dvh max-h-dvh w-[calc(100%_-_1rem)] max-w-sm overflow-hidden rounded-r-2xl p-0 text-[var(--text-primary)] backdrop:bg-black/45"
    >
      <div className="flex h-full min-h-0 flex-col pt-[var(--zw-content-safe-top)] pb-[env(safe-area-inset-bottom)]">
        {children}
      </div>
    </dialog>
  );
}

const rowActionClass = 'flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-50 lg:size-7';
const formButtonClass = 'min-h-9 rounded-lg px-2.5 text-xs font-medium disabled:opacity-50 lg:min-h-7';
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const calendarDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });

function HistoryTime({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const format = date.toDateString() === new Date().toDateString() ? clock : calendarDate;
  return <time dateTime={value} title={fullDate.format(date)} className="tabular-nums">{format.format(date)}</time>;
}

function HistoryPanel({ history, activeId, onClose, onSelect, onRename, onDelete }: PanelProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const actionRequest = useRef(0);

  useEffect(() => { list.current?.scrollTo(0, 0); }, [history.query]);

  const finishEdit = () => {
    setEditor(null);
    setActionError('');
    const trigger = editTrigger.current;
    requestAnimationFrame(() => {
      const target = trigger?.isConnected ? trigger : list.current?.querySelector('button') ?? search.current;
      target?.focus({ preventScroll: true });
    });
  };

  const runAction = async (action: () => Promise<void>, write = false, onSuccess?: () => void) => {
    if (saving) return;
    const request = ++actionRequest.current;
    setActionError('');
    if (write) setSaving(true);
    try {
      await action();
      if (request === actionRequest.current) onSuccess?.();
    } catch (error) {
      if (request === actionRequest.current) {
        setActionError(error instanceof Error && error.message ? error.message : '操作失败，请重试');
      }
    } finally {
      if (write) setSaving(false);
    }
  };

  const startEdit = (item: TutorHistoryItem, kind: Editor['kind'], trigger: HTMLButtonElement) => {
    editTrigger.current = trigger;
    setActionError('');
    setDraft(item.title);
    setEditor({ id: item.id, kind });
  };

  return (
    <>
      <div className="shrink-0 space-y-2 border-b border-[var(--border-hairline)] px-3 pt-2 pb-3 lg:pt-3">
        <div className="flex items-center justify-between">
          <h2 id="tutor-history-heading" className="text-sm font-semibold">历史对话</h2>
          {onClose && (
            <button type="button" aria-label="关闭历史对话" onClick={onClose} className={rowActionClass}>
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input ref={search} type="search" aria-label="搜索历史对话" placeholder="搜索标题或消息" value={history.query}
            onChange={event => { setEditor(null); setActionError(''); history.setQuery(event.target.value); }}
            className="zw-input min-h-10 w-full min-w-0 rounded-lg pr-2 pl-8 text-xs lg:min-h-8" />
        </div>
        {actionError && <p role="alert" className="break-words text-xs text-[var(--danger-fg)]">{actionError}</p>}
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        <ul aria-label="对话列表" className="space-y-1">
          {history.items.map((item, index) => {
            const title = item.title || '未命名对话';
            const active = item.id === activeId;
            const editing = editor?.id === item.id ? editor.kind : null;
            const detailsId = `tutor-history-details-${index}`;
            return (
              <li key={item.id} className={`relative rounded-xl ${active ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]'}`}>
                <button type="button" aria-label={title} title={title} aria-describedby={detailsId} aria-current={active || undefined} disabled={saving}
                  onClick={() => { setEditor(null); void runAction(() => onSelect(item.id)); }}
                  className="block w-full min-w-0 rounded-xl px-2.5 py-2 text-left">
                  <span className="flex min-h-9 flex-col justify-center gap-0.5 pr-[5.25rem] lg:min-h-7 lg:pr-14">
                    <span className="truncate text-xs font-medium">{title}</span>
                    <span id={detailsId} className="flex flex-wrap gap-x-1.5 text-[11px] text-[var(--text-secondary)]">
                      <span>{tutorModeLabels[item.mode]}</span>
                      <HistoryTime value={item.updated_at || item.created_at} />
                    </span>
                  </span>
                  {item.matchSnippet && (
                    <span className="mt-1 block text-xs leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">{item.matchSnippet}</span>
                  )}
                </button>
                <div className="absolute top-1 right-1 flex lg:top-1.5">
                  <button type="button" aria-label={`重命名「${title}」`} title="重命名" disabled={saving}
                    onClick={event => startEdit(item, 'rename', event.currentTarget)} className={rowActionClass}>
                    <Pencil aria-hidden="true" className="size-3.5" />
                  </button>
                  <button type="button" aria-label={`删除「${title}」`} title="删除" disabled={saving}
                    onClick={event => startEdit(item, 'delete', event.currentTarget)} className={`${rowActionClass} hover:text-[var(--danger-fg)]`}>
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
                {editing && (
                  <form key={editing} className="space-y-2 px-2.5 pb-2.5"
                    onKeyDown={event => {
                      if (event.key === 'Escape' && !event.nativeEvent.isComposing && !saving) {
                        event.preventDefault();
                        event.stopPropagation();
                        finishEdit();
                      }
                    }}
                    onSubmit={event => {
                      event.preventDefault();
                      if (editing === 'delete') void runAction(() => onDelete(item.id), true, finishEdit);
                      else if (draft.trim()) void runAction(() => onRename(item.id, draft.trim()), true, finishEdit);
                    }}>
                    {editing === 'rename' ? (
                      <input autoFocus type="text" aria-label="对话名称" maxLength={200} value={draft} disabled={saving}
                        onFocus={event => event.target.select()} onChange={event => setDraft(event.target.value)}
                        className="zw-input min-h-9 w-full min-w-0 rounded-lg px-2 text-sm" />
                    ) : (
                      <p className="text-xs leading-relaxed [overflow-wrap:anywhere]">删除「{title}」及其中的全部消息？</p>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      <button type="submit" disabled={saving || (editing === 'rename' && !draft.trim())}
                        className={`${formButtonClass} ${editing === 'delete' ? 'bg-[var(--danger-bg)] text-[var(--danger-fg)]' : 'zw-btn-primary'}`}>
                        {editing === 'delete' ? '确认删除' : '保存'}
                      </button>
                      <button type="button" autoFocus={editing === 'delete'} disabled={saving} onClick={finishEdit}
                        className={`${formButtonClass} zw-btn-secondary`}>取消</button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        {history.error ? (
          <div className="space-y-2 px-2 py-3 text-xs">
            <p role="alert" className="break-words text-[var(--danger-fg)]">{history.error}</p>
            <button type="button" onClick={history.retry} disabled={history.loading} className={`${formButtonClass} zw-btn-secondary`}>重试</button>
          </div>
        ) : (
          <>
            {history.loading ? (
              <p role="status" className="py-4 text-center text-xs text-[var(--text-muted)]">加载中…</p>
            ) : history.items.length === 0 && (
              <p role="status" className="py-4 text-center text-xs text-[var(--text-muted)]">{history.query.trim() ? '无匹配对话' : '暂无历史对话'}</p>
            )}
            {history.hasMore && (
              <button type="button" disabled={history.loading} onClick={history.loadMore}
                className="zw-btn-secondary mt-2 min-h-10 w-full rounded-lg text-xs disabled:opacity-50 lg:min-h-8">加载更多</button>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function TutorHistory({ mobileOpen, onClose, ...panelProps }: TutorHistoryProps) {
  if (mobileOpen) {
    return <MobileHistoryDialog onClose={onClose}><HistoryPanel {...panelProps} onClose={onClose} /></MobileHistoryDialog>;
  }
  return (
    <aside id="tutor-history" aria-labelledby="tutor-history-heading"
      className="zw-card hidden min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl lg:col-span-3 lg:flex">
      <HistoryPanel {...panelProps} />
    </aside>
  );
}
