import { useRef, useState } from 'react';
import { Archive, AlertCircle, CheckCircle2, Download, Loader2, QrCode, Upload } from 'lucide-react';
import { api } from '../api/client';
import type { BackupPreview } from '../../../server/src/shared/libraryBackup';
import { canSaveBackupFile, saveBackupFile } from '../utils/saveBackupFile';

interface LibraryBackupPanelProps {
  onRestored?: () => void;
  onOpenBackupTransfer: () => void;
}

const button = 'inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold cursor-pointer disabled:cursor-default disabled:opacity-50';

export function LibraryBackupPanel({ onRestored, onOpenBackupTransfer }: LibraryBackupPanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<'export' | 'preview' | 'restore' | null>(null);
  const [candidate, setCandidate] = useState<{ file: File; preview: BackupPreview } | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'warning' | 'error'; message: string } | null>(null);
  const canSave = canSaveBackupFile();

  const exportBackup = async () => {
    if (!canSave) {
      onOpenBackupTransfer();
      return;
    }
    setPending('export');
    setFeedback(null);
    try {
      const { blob, missingAttachments } = await api.exportBackup();
      const day = new Date().toLocaleDateString('sv-SE');
      if (await saveBackupFile(blob, `zhiwu-backup-${day}.zip`)) {
        setFeedback(missingAttachments > 0 ? {
          kind: 'warning', message: `已导出备份。有 ${missingAttachments} 份原文件当前不可用，对应笔记已备份。`,
        } : { kind: 'success', message: '已导出完整备份。' });
      }
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : '导出备份失败' });
    } finally {
      setPending(null);
    }
  };

  const previewBackup = async (file: File) => {
    setCandidate(null);
    setFeedback(null);
    setPending('preview');
    try {
      setCandidate({ file, preview: await api.previewBackup(file) });
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : '无法读取备份' });
    } finally {
      setPending(null);
    }
  };

  const restoreBackup = async () => {
    if (!candidate) return;
    setFeedback(null);
    setPending('restore');
    try {
      await api.restoreBackup(candidate.file);
      setCandidate(null);
      setFeedback({ kind: 'success', message: '恢复完成。备份里的资料和学习记录已合并到此设备。' });
      onRestored?.();
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : '恢复失败' });
    } finally {
      setPending(null);
    }
  };

  const counts = candidate?.preview.counts;
  const previewCounts = counts ? [
    ['笔记', counts.notes - counts.trashedNotes], ['原文件', counts.attachments], ['回收站', counts.trashedNotes],
    ['聊天', counts.tutorSessions], ['测验', counts.quizzes], ['闪卡', counts.flashcards], ['错题', counts.mistakes],
    ['专题归纳', counts.syntheses], ['学习记录', counts.studyLogs],
  ] as const : [];

  return (
    <section aria-labelledby="library-backup-title" className="zw-card scroll-mt-20 space-y-4 rounded-2xl p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Archive className="mt-0.5 size-4 shrink-0 text-[var(--text-secondary)]" />
        <div>
          <h2 id="library-backup-title" className="text-sm font-semibold">完整备份</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">把原文件、笔记、回收站和学习进度一起带到另一台电脑或安卓设备。</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={exportBackup} disabled={pending !== null} className={`${button} zw-btn-primary`}>
          {pending === 'export' ? <Loader2 className="size-3.5 animate-spin" /> : canSave ? <Download className="size-3.5" /> : <QrCode className="size-3.5" />}
          {pending === 'export' ? '正在生成备份' : canSave ? '导出完整备份' : '扫码保存到电脑'}
        </button>
        <button type="button" onClick={() => input.current?.click()} disabled={pending !== null} className={`${button} zw-btn-secondary`}>
          {pending === 'preview' ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          {pending === 'preview' ? '正在读取备份' : '选择备份恢复'}
        </button>
        <input ref={input} type="file" accept=".zip,.zhiwu,.json,application/zip,application/json" hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void previewBackup(file);
          }} />
      </div>
      {candidate && (
        <div className="space-y-4 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-subtle)] p-3.5 sm:p-4">
          <div>
            <h3 className="text-sm font-semibold">恢复预览</h3>
            <p className="mt-1 break-all text-xs text-[var(--text-muted)]">{candidate.file.name}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            {previewCounts.map(([label, count]) => (
              <div key={label} className="flex items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-1.5">
                <dt className="text-[var(--text-secondary)]">{label}</dt><dd className="font-semibold tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">
            {candidate.preview.conflicts > 0 && `有 ${candidate.preview.conflicts} 条记录已存在。`}恢复时按记录合并，保留较新的版本。
          </p>
          {candidate.preview.missingAttachments.length > 0 && (
            <details className="text-xs leading-relaxed text-[var(--text-secondary)]">
              <summary className="cursor-pointer">备份中缺少 {candidate.preview.missingAttachments.length} 份原文件，查看名单</summary>
              <ul className="mt-2 max-h-36 list-inside list-disc overflow-auto break-all">
                {candidate.preview.missingAttachments.map(({ noteId, filename }) => <li key={noteId}>{filename}</li>)}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={restoreBackup} disabled={pending !== null} className={`${button} zw-btn-primary`}>
              {pending === 'restore' ? <><Loader2 className="size-3.5 animate-spin" /> 正在恢复</> : '确认恢复'}
            </button>
            <button type="button" onClick={() => setCandidate(null)} disabled={pending !== null} className={`${button} zw-btn-secondary`}>取消</button>
          </div>
        </div>
      )}
      {feedback && (
        <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 text-xs leading-relaxed ${feedback.kind === 'error' ? 'text-[var(--danger-fg)]' : 'text-[var(--text-secondary)]'}`}>
          {feedback.kind === 'success' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 size-3.5 shrink-0" />}
          {feedback.message}
        </p>
      )}
    </section>
  );
}
