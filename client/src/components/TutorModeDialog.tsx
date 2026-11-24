import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { tutorModeLabels } from '../../../server/src/shared/tutorMode';
import type { TutorMode } from '../types';

interface TutorModeDialogProps {
  kind: 'create' | 'settings';
  initialMode: TutorMode;
  referenceCount?: number;
  onConfirm: (mode: TutorMode) => Promise<void>;
  onClose: () => void;
}

const choices = [
  { mode: 'general', description: '直接问知识，需要时查笔记原文。' },
  { mode: 'qa', description: '结合笔记原文，解答学习疑问。' },
  { mode: 'feynman', description: '试着讲解概念，再回答助教的追问。' },
] as const;

export function TutorModeDialog({ kind, initialMode, referenceCount = 0, onConfirm, onClose }: TutorModeDialogProps) {
  const [mode, setMode] = useState(initialMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const creating = kind === 'create';

  useEffect(() => {
    const dialog = dialogRef.current!;
    const opener = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (error && !saving) submitButton.current?.focus({ preventScroll: true });
  }, [error, saving]);

  const dismiss = () => {
    if (!submitting.current) onClose();
  };

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      await onConfirm(mode);
    } catch (cause) {
      const fallback = creating ? '无法创建对话，请重试' : '无法保存设置，请重试';
      setError(cause instanceof Error && cause.message ? cause.message : fallback);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} id="tutor-mode-dialog" aria-labelledby="tutor-mode-title"
      onCancel={event => { event.preventDefault(); dismiss(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX >= bounds.right ||
            event.clientY < bounds.top || event.clientY >= bounds.bottom) dismiss();
      }}
      className="zw-modal fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_1.5rem)] max-w-sm overflow-y-auto overscroll-contain rounded-2xl p-0 text-[var(--text-primary)] backdrop:bg-black/45">
      <form onSubmit={confirm} aria-busy={saving} className="space-y-4 p-4 sm:p-5">
        <h2 id="tutor-mode-title" className="text-base font-semibold">{creating ? '新建对话' : '对话设置'}</h2>
        <fieldset disabled={saving} className="min-w-0 space-y-2">
          <legend className="sr-only">对话模式</legend>
          {choices.map(choice => {
            const selected = choice.mode === mode;
            const descriptionId = `tutor-mode-description-${choice.mode}`;
            return (
              <label key={choice.mode}
                className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--text-secondary)] ${selected ? 'border-[var(--border-strong)] bg-[var(--bg-active)]' : 'border-[var(--border-hairline)] hover:bg-[var(--bg-hover)]'}`}>
                <input type="radio" name="tutor-mode" value={choice.mode} checked={selected}
                  aria-label={tutorModeLabels[choice.mode]} aria-describedby={descriptionId}
                  onChange={() => { setMode(choice.mode); setError(''); }}
                  className="size-4 shrink-0 accent-[var(--btn-primary-bg)]" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{tutorModeLabels[choice.mode]}</span>
                  <span id={descriptionId} className="block text-xs leading-relaxed text-[var(--text-secondary)]">{choice.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {!creating && mode === 'general' && referenceCount > 0 && <p className="text-xs text-[var(--text-secondary)]">
          查资料时沿用本对话所选的 {referenceCount} 篇笔记。可在学习模式中调整参考范围。
        </p>}
        {error && <p role="alert" className="break-words text-xs text-[var(--danger-fg)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={dismiss} disabled={saving}
            className="zw-btn-secondary min-h-11 rounded-xl px-4 text-sm disabled:opacity-50">取消</button>
          <button ref={submitButton} type="submit" disabled={saving}
            className="zw-btn-primary inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-medium disabled:opacity-60">
            {saving && <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />}
            {creating ? '创建对话' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
