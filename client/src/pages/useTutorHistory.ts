import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { TutorHistoryItem, TutorSession } from '../types';

export function useTutorHistory() {
  const [query, displayQuery] = useState('');
  const [items, setItems] = useState<TutorHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const search = useRef('');
  const nextCursor = useRef<string | null>(null);
  const pageCount = useRef(1);
  const request = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(false);
  const lastWasAppend = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++request.current;
      window.clearTimeout(timer.current);
    };
  }, []);

  const load = useCallback(async (append = false) => {
    if (!mounted.current || (append && !nextCursor.current)) return;
    window.clearTimeout(timer.current);
    const current = ++request.current;
    const term = search.current;
    lastWasAppend.current = append;
    setLoading(true);
    setError('');
    try {
      const rows: TutorHistoryItem[] = [];
      let cursor = append ? nextCursor.current : null;
      let fetched = 0;
      // Renaming or continuing a conversation can move it to the first page.
      // Refill the pages the reader had already opened when the order changes.
      do {
        const page = await api.listTutorHistory(term, cursor ?? undefined);
        if (current !== request.current) return;
        rows.push(...page.items);
        cursor = page.nextCursor;
        fetched++;
      } while (!append && cursor && fetched < pageCount.current);
      nextCursor.current = cursor;
      pageCount.current = append ? pageCount.current + 1 : fetched;
      setItems(previous => {
        const combined = append ? [...previous, ...rows] : rows;
        return [...new Map(combined.map(row => [row.id, row])).values()];
      });
      setHasMore(cursor !== null);
      return rows;
    } catch (cause) {
      if (current === request.current) setError(cause instanceof Error ? cause.message : '无法加载历史对话');
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, []);

  const setQuery = (text: string) => {
    displayQuery(text);
    const term = text.trim();
    if (term === search.current) return;
    search.current = term;
    ++request.current;
    window.clearTimeout(timer.current);
    pageCount.current = 1;
    nextCursor.current = null;
    setItems([]);
    setHasMore(false);
    setError('');
    setLoading(true);
    timer.current = window.setTimeout(() => { void load(); }, term ? 160 : 0);
  };

  return {
    query, setQuery, items, loading, error, hasMore,
    loadMore: () => { if (!loading) void load(true); },
    retry: () => { void load(lastWasAppend.current); },
    refresh: load,
    refreshAfterEdit: (id: string, session?: TutorSession) => {
      // Keep an acknowledged change visible if the subsequent list request fails.
      setItems(rows => session
        ? rows.map(row => row.id === id ? { ...row, title: session.title, mode: session.mode, updated_at: session.updated_at } : row)
        : rows.filter(row => row.id !== id));
      return load();
    },
  };
}
