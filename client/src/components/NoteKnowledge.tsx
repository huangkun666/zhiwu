import { useEffect, useState } from 'react';
import type { LibrarySearchResults, NoteKnowledge } from '../../../server/src/shared/tutorSearch';
import { api } from '../api/client';

type Point = LibrarySearchResults['points'][number];
type OpenSource = (noteId: string, citation: URLSearchParams) => void;

export function KnowledgePointCard({ point, onOpenSource }: { point: Point; onOpenSource: OpenSource }) {
  return (
    <article className="space-y-1.5 px-4 py-3">
      <h3 className="text-sm font-semibold">{point.title}</h3>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{point.answer}</p>
      {point.conditions && <p className="text-xs leading-relaxed text-[var(--text-secondary)]">适用条件　{point.conditions}</p>}
      <div className="flex flex-wrap gap-x-3 gap-y-2">
        {point.sources.map(source => (
          <a key={source.params} href={`?${source.params}`}
            className="break-words text-xs text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
            onClick={event => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onOpenSource(source.noteId, new URLSearchParams(source.params));
            }}>
            {source.title} · {source.label}
          </a>
        ))}
      </div>
    </article>
  );
}

export function NoteKnowledgePanel({ noteId, updatedAt, onOpenSource }: {
  noteId: string; updatedAt: string; onOpenSource: OpenSource;
}) {
  const [result, setResult] = useState<NoteKnowledge | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState(8);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const next = await api.getKnowledge(noteId);
        if (!current) return;
        setResult(next);
        setError('');
        if (next.status === 'pending') timer = setTimeout(read, 1600);
      } catch {
        if (current) setError('暂时无法读取知识点。');
      }
    }
    void read();
    return () => { current = false; clearTimeout(timer); };
  }, [noteId, updatedAt, refresh]);

  async function start() {
    setStarting(true);
    try {
      setResult(await api.extractKnowledge(noteId));
      setError('');
      setRefresh(value => value + 1);
    } catch {
      setError('无法启动提取，请重试。');
    } finally {
      setStarting(false);
    }
  }

  if (!result && !error) return null;
  const action = result?.status === 'paused' ? '重试提取'
    : result?.status === 'stale' ? '重新提取'
    : result?.status === 'not_started' ? '提取知识点' : null;
  return (
    <section aria-label="知识点" className="mx-5 mt-5 overflow-hidden rounded-2xl border sm:mx-6"
      style={{ borderColor: 'var(--border-hairline)', background: 'var(--bg-subtle)' }}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <h2 className="text-sm font-semibold">知识点{result?.points.length ? `（${result.points.length}）` : ''}</h2>
        {action && <button type="button" disabled={starting} onClick={() => void start()}
          className="zw-btn-secondary rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-50">
          {starting ? '正在启动…' : action}
        </button>}
      </div>
      {error && <p role="status" className="px-4 pb-3 text-xs text-[var(--text-secondary)]">
        {error} <button type="button" className="underline" onClick={() => setRefresh(value => value + 1)}>刷新</button>
      </p>}
      {result?.status === 'pending' && <p role="status" className="px-4 pb-3 text-xs text-[var(--text-secondary)]">
        正在提取，已处理 {result.processed} / {result.total} 段
      </p>}
      {result?.status === 'paused' && <p role="status" className="px-4 pb-3 text-xs text-[var(--text-secondary)]">
        已处理 {result.processed} / {result.total} 段。{result.error}
      </p>}
      {result?.status === 'stale' && <p className="px-4 pb-3 text-xs text-[var(--text-secondary)]">原文有更新，可以重新提取。</p>}
      {result?.status === 'complete' && <p role="status" className="px-4 pb-3 text-xs text-[var(--text-secondary)]">
        {result.points.length ? '提取完成' : result.total ? '提取完成，本篇暂无独立知识点。' : '暂无可提取的原文文字。'}
      </p>}
      {result && <div className="divide-y divide-[var(--border-hairline)]">
        {result.points.slice(0, visible).map(point => <KnowledgePointCard key={point.id} point={point} onOpenSource={onOpenSource} />)}
      </div>}
      {result && result.points.length > visible && (
        <button type="button" className="w-full border-t border-[var(--border-hairline)] px-4 py-3 text-xs hover:bg-[var(--bg-hover)]"
          onClick={() => setVisible(value => value + 8)}>显示更多知识点</button>
      )}
    </section>
  );
}
