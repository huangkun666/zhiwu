import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Database, Download, FileUp, Loader2, QrCode, Wifi, X } from 'lucide-react';

interface QrSendModalProps {
  open: boolean;
  onClose: () => void;
}

interface StagedResult {
  token: string;
  kind: 'files' | 'sync' | 'backup-receive';
  url: string;
  qrDataUrl: string;
  primaryIp: string;
  adapters: { name: string; address: string; isVirtual: boolean }[];
  fileNames?: string[];
}

interface BackupStatus {
  ready: boolean;
  totalBytes: number;
  receivedBytes: number;
  expiresAt: number;
  downloadPath: string | null;
}

export function QrSendModal({ open, onClose }: QrSendModalProps) {
  const [tab, setTab] = useState<StagedResult['kind']>('files');
  const [staged, setStaged] = useState<StagedResult | null>(null);
  const [backup, setBackup] = useState<StagedResult | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const receivingBackup = tab === 'backup-receive';
  const current = receivingBackup ? backup : staged;
  const receipt = backup?.token;

  useEffect(() => {
    if (!open || !receivingBackup || !receipt) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const checkBackup = async () => {
      let nextCheck = 1_000;
      try {
        const res = await fetch(`/api/transfer/backup-receive/${receipt}`, { signal: controller.signal, cache: 'no-store' });
        const data = await res.json();
        if (controller.signal.aborted) return;
        if (res.status === 404) {
          setBackup(null);
          setBackupStatus(null);
          setError(data?.error || '备份接收码已过期，请重新生成');
          return;
        }
        if (!res.ok) throw new Error(data?.error || '无法读取备份接收状态');
        const status: BackupStatus = data;
        setError('');
        setBackupStatus(status);
        if (status.ready) nextCheck = Math.max(nextCheck, status.expiresAt - Date.now() + 200);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : '无法读取备份接收状态');
        nextCheck = 2_000;
      }
      timer = window.setTimeout(checkBackup, nextCheck);
    };
    void checkBackup();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, receivingBackup, receipt]);

  if (!open) return null;

  const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

  const stageFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setLoading(true);
    setError('');
    try {
      const fd = new FormData();
      Array.from(fileList).forEach((f) => fd.append('files', f));
      fd.append('port', port);
      const res = await fetch('/api/transfer/stage-files', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '生成快传码失败');
      setStaged(data);
    } catch (e: any) {
      setError(e.message || '生成失败');
    } finally {
      setLoading(false);
    }
  };

  const stageQr = async (kind: 'sync' | 'backup-receive') => {
    setLoading(true);
    setError('');
    const isBackup = kind === 'backup-receive';
    if (isBackup) {
      setBackup(null);
      setBackupStatus(null);
    }
    try {
      const res = await fetch(isBackup ? '/api/transfer/backup-receive' : '/api/transfer/stage-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '生成二维码失败');
      if (isBackup) setBackup(data);
      else setStaged(data);
    } catch (e: any) {
      setError(e.message || '生成失败');
    } finally {
      setLoading(false);
    }
  };

  const switchIp = async (ip: string) => {
    if (!current) return;
    const { token, kind } = current;
    const path = kind === 'backup-receive' ? `backup-receive/${token}` : token;
    try {
      const res = await fetch(`/api/transfer/${path}/qr?port=${encodeURIComponent(port)}&ip=${encodeURIComponent(ip)}`);
      const next = await res.json();
      if (!res.ok) throw new Error(next?.error || '无法切换网络地址');
      const update = kind === 'backup-receive' ? setBackup : setStaged;
      update((previous) => previous?.token === token ? next : previous);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法切换网络地址');
    }
  };

  const copyUrl = async () => {
    if (!current?.url) return;
    try {
      await navigator.clipboard.writeText(current.url);
    } catch {
      linkRef.current?.select();
      if (!document.execCommand?.('copy')) return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-transfer-title"
        className="w-full max-w-md max-h-[calc(100dvh-2rem)] zw-modal rounded-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4" />
            <h3 id="qr-transfer-title" className="font-semibold text-sm">手机与电脑快传</h3>
          </div>
          <button
            type="button"
            aria-label="关闭快传窗口"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-3 p-1 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
            <button
              type="button"
              disabled={loading}
              aria-pressed={tab === 'files'}
              onClick={() => {
                setTab('files');
                setStaged(null);
                setError('');
                setCopied(false);
              }}
              className="py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
              style={{
                background: tab === 'files' ? 'var(--bg-card-solid)' : 'transparent',
                color: tab === 'files' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <FileUp className="w-3.5 h-3.5" />
              传送文件
            </button>
            <button
              type="button"
              disabled={loading}
              aria-pressed={tab === 'sync'}
              onClick={() => {
                setTab('sync');
                setStaged(null);
                setCopied(false);
                void stageQr('sync');
              }}
              className="py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
              style={{
                background: tab === 'sync' ? 'var(--bg-card-solid)' : 'transparent',
                color: tab === 'sync' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <Database className="w-3.5 h-3.5" />
              同步笔记
            </button>
            <button
              type="button"
              disabled={loading}
              aria-pressed={receivingBackup}
              onClick={() => {
                setTab('backup-receive');
                setError('');
                setCopied(false);
                if (!backup) void stageQr('backup-receive');
              }}
              className="py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
              style={{
                background: receivingBackup ? 'var(--bg-card-solid)' : 'transparent',
                color: receivingBackup ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <Download className="w-3.5 h-3.5" />
              接收备份
            </button>
          </div>

          {tab === 'files' && !staged && (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".md,.markdown,.txt,.pdf,.docx"
                className="hidden"
                onChange={(e) => stageFiles(e.target.files)}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={loading}
                className="w-full py-8 px-4 rounded-2xl border border-dashed text-center space-y-2 cursor-pointer transition"
                style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-subtle)' }}
              >
                {loading ? (
                  <Loader2 className="w-6 h-6 mx-auto animate-spin text-[var(--text-muted)]" />
                ) : (
                  <FileUp className="w-6 h-6 mx-auto text-[var(--text-muted)]" />
                )}
                <div className="text-xs font-medium">选择要传给手机的笔记文件</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  支持 .md / .txt / .pdf / .docx · 手机 App 内扫码秒导入
                </div>
              </button>
            </>
          )}

          {loading && tab !== 'files' && (
            <div role="status" className="py-10 text-center text-xs text-[var(--text-muted)] flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {receivingBackup ? '正在生成备份接收码…' : '正在生成全量同步码…'}
            </div>
          )}

          {error && (
            <div
              className="p-3 rounded-xl border text-xs"
              style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }}
            >
              {error}
            </div>
          )}

          {receivingBackup && !loading && !current && (
            <button type="button" className="w-full px-3 py-2 rounded-xl zw-btn-secondary text-xs" onClick={() => stageQr('backup-receive')}>
              重新生成接收码
            </button>
          )}

          {receivingBackup && backupStatus?.downloadPath && (
            <div className="rounded-2xl border p-5 text-center space-y-3" style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}>
              <Check className="w-6 h-6 mx-auto text-[var(--ok-fg)]" />
              <div role="status" className="text-sm font-semibold">已收到手机备份</div>
              <a
                href={backupStatus.downloadPath}
                download
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold"
              >
                <Download className="w-3.5 h-3.5" />
                下载完整备份
              </a>
              <button type="button" className="block mx-auto text-xs text-[var(--text-muted)]" onClick={() => stageQr('backup-receive')}>
                接收另一份
              </button>
            </div>
          )}

          {current && (!receivingBackup || !backupStatus?.ready) && (
            <div className="space-y-3.5 text-center">
              <div className="inline-block p-3 bg-white rounded-2xl border border-black/10">
                <img src={current.qrDataUrl} alt={receivingBackup ? '备份接收二维码' : '扫码快传二维码'} className="w-44 h-44 mx-auto" />
              </div>

              {current.fileNames && current.fileNames.length > 0 && (
                <div className="text-xs text-[var(--text-secondary)]">
                  待接收文件：{current.fileNames.join('、')}
                </div>
              )}

              <p className="text-[11px] text-[var(--text-muted)]">
                {receivingBackup ? (
                  <>手机连接同一 Wi-Fi，在设置里打开 <strong>「局域网快传」</strong> 扫码并确认发送。收到备份后，在这里下载 ZIP。接收码 30 分钟内有效。</>
                ) : (
                  <>手机连接同一 Wi-Fi，在设置里打开 <strong>「局域网快传」</strong> 扫码接收。二维码 30 分钟内有效。</>
                )}
              </p>

              {receivingBackup && Boolean(backupStatus?.totalBytes) && backupStatus && (
                <div role="status" className="text-xs text-[var(--text-secondary)]">
                  正在接收 · {Math.floor(backupStatus.receivedBytes * 100 / backupStatus.totalBytes)}%
                </div>
              )}

              {current.adapters && current.adapters.length > 1 && (
                <select
                  aria-label="电脑网络地址"
                  value={current.primaryIp}
                  onChange={(e) => switchIp(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl zw-input text-xs"
                >
                  {current.adapters.map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.name} ({a.address}){a.isVirtual ? ' [虚拟]' : ''}
                    </option>
                  ))}
                </select>
              )}

              <div
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-left border"
                style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
              >
                <Wifi className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                <input ref={linkRef} aria-label="快传链接" className="min-w-0 flex-1 bg-transparent text-[11px] font-mono" value={current.url} readOnly onFocus={(e) => e.currentTarget.select()} />
                <button
                  type="button"
                  onClick={copyUrl}
                  className="px-2 py-1 rounded-lg zw-btn-secondary text-[11px] flex items-center gap-1 cursor-pointer"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
