import { useCallback, useEffect, useRef, useState } from 'react';
import { applyTutorBodyEdit, type TutorNoteEdit } from '../../../server/src/shared/tutorNoteEdit';
import { api } from '../api/client';
import type { Note } from '../types';

interface Props {
  proposal: TutorNoteEdit;
  messageId: string;
  onOpenNote: (href: string) => void;
  onApplied: (note: Note) => void;
}

const resultText = {
  applied: '已应用修改',
  editedSince: '本机曾应用此修改，当前笔记版本已有变化。',
  stale: '笔记已变更，请重新生成修改建议。',
};
type NoteState = 'ready' | keyof typeof resultText;

export function TutorNoteEditCard({ proposal, messageId, onOpenNote, onApplied }: Props) {
  const { noteId, title, operation, before, after, updatedAt } = proposal;
  const excerptId = 'tutor-edit-' + messageId;
  const receiptKey = 'zhiwu-tutor-edit:' + JSON.stringify([noteId, messageId, updatedAt]);
  const [state, setState] = useState<NoteState | 'checking' | 'saving'>('checking');
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const href = '?' + new URLSearchParams({ note: noteId });

  const inspect = useCallback((note: Note): NoteState => {
    if (operation === 'append') {
      const saved = note.chat_excerpts?.find(excerpt => excerpt.id === excerptId);
      if (!saved) return 'ready';
      return saved.content === after ? 'applied' : 'stale';
    }
    // An unrelated edit can contain the same wording. A receipt identifies the write we confirmed.
    try {
      const receipt = localStorage.getItem(receiptKey);
      if (receipt && receipt === note.updated_at) return 'applied';
      if (receipt && note.updated_at !== updatedAt) return 'editedSince';
    } catch { /* Version checks also protect a browser without local storage. */ }
    if (note.updated_at !== updatedAt || (operation === 'rename' && note.title !== before)) return 'stale';
    return 'ready';
  }, [operation, excerptId, after, receiptKey, updatedAt, before]);

  useEffect(() => {
    let current = true;
    setState('checking');
    setError('');
    api.getNote(noteId).then(note => {
      if (current) setState(inspect(note));
    }).catch(cause => {
      if (current) {
        setState('ready');
        setError(cause instanceof Error ? cause.message : '暂时无法读取笔记，请重试');
      }
    });
    return () => { current = false; };
  }, [noteId, inspect]);

  const apply = async () => {
    if (state !== 'ready' || submitting.current) return;
    submitting.current = true;
    setState('saving');
    setError('');
    try {
      const note = await api.getNote(noteId);
      const latest = inspect(note);
      if (latest !== 'ready') {
        setState(latest);
        return;
      }
      let updated: Note;
      if (operation === 'append') {
        updated = await api.appendNoteChat(noteId, excerptId, after);
        if (inspect(updated) !== 'applied') {
          setState('stale');
          return;
        }
      } else {
        const change = operation === 'rename' ? { title: after } : { content: applyTutorBodyEdit(note.content, proposal) };
        updated = await api.updateNote(noteId, { ...change, expectedUpdatedAt: updatedAt });
        try { localStorage.setItem(receiptKey, updated.updated_at); } catch { /* The note was saved. */ }
      }
      setState('applied');
      onApplied(updated);
    } catch (cause) {
      setState('ready');
      setError(cause instanceof Error ? cause.message : '未能确认修改结果，请重试');
    } finally {
      submitting.current = false;
    }
  };

  const textClass = 'max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm';
  return (
    <section aria-label="修改建议" className="mt-2 space-y-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-card-solid)] p-3">
      <div>
        <h4 className="text-xs font-semibold text-[var(--text-secondary)]">修改建议</h4>
        <a href={href} onClick={event => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpenNote(href);
        }} className="break-words font-medium underline underline-offset-2">{title}</a>
      </div>
      <dl className="space-y-2">
        {operation !== 'append' && (
          <div>
            <dt className="text-xs text-[var(--text-muted)]">{operation === 'rename' ? '原标题' : '原文'}</dt>
            <dd className={textClass}>{before}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-[var(--text-muted)]">{operation === 'rename' ? '新标题' : operation === 'append' ? '新增聊天摘录' : '修改后'}</dt>
          <dd className={textClass}>{after || '（删除这段正文）'}</dd>
        </div>
      </dl>
      {error && <p role="alert" className="text-xs text-[var(--danger-fg)]">{error}</p>}
      {state === 'ready' || state === 'saving' || state === 'checking' ? (
        <button type="button" disabled={state !== 'ready'} onClick={() => void apply()}
          className="zw-btn-primary min-h-10 rounded-lg px-3 text-xs font-semibold disabled:opacity-50">
          {state === 'checking' ? '正在核对笔记…' : state === 'saving' ? '应用中…' : '应用修改'}
        </button>
      ) : (
        <p role="status" className="text-xs font-medium">{resultText[state]}</p>
      )}
    </section>
  );
}
