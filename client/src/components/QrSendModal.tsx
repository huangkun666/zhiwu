import { useRef, useState } from 'react';
import { Check, Copy, Database, FileUp, Loader2, QrCode, Wifi, X } from 'lucide-react';

interface QrSendModalProps {
  open: boolean;
  onClose: () => void;
}

interface StagedResult {
  token: string;
  kind: 'files' | 'sync';
  url: string;
  qrDataUrl: string;
  primaryIp: string;
  adapters: { name: string; address: string; isVirtual: boolean }[];
  fileNames?: string[];
}

export function QrSendModal({ open, onClose }: QrSendModalProps) {
  const [tab, setTab] = useState<'files' | 'sync'>('files');
  const [staged, setStaged] = useState<StagedResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const stageSync = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/transfer/stage-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '生成同步码失败');
      setStaged(data);
    } catch (e: any) {
      setError(e.message || '生成失败');
    } finally {
      setLoading(false);
    }
  };

  const switchIp = async (ip: string) => {
    if (!staged) return;
    const res = await fetch(`/api/transfer/${staged.token}/qr?port=${encodeURIComponent(port)}&ip=${encodeURIComponent(ip)}`);
    if (res.ok) setStaged(await res.json());
  };

  const copyUrl = () => {
    if (!staged?.url) return;
    navigator.clipboard?.writeText(staged.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md zw-modal rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4" />
            <h3 className="font-semibold text-sm">生成手机扫码快传码</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 p-1 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
            <button
              onClick={() => {
                setTab('files');
                setStaged(null);
                setError('');
              }}
              className="py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
              style={{
                background: tab === 'files' ? 'var(--bg-card-solid)' : 'transparent',
                color: tab === 'files' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <FileUp className="w-3.5 h-3.5" />
              快传文件给手机
            </button>
            <button
              onClick={() => {
                setTab('sync');
                setStaged(null);
                setError('');
                stageSync();
              }}
              className="py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
              style={{
                background: tab === 'sync' ? 'var(--bg-card-solid)' : 'transparent',
                color: tab === 'sync' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <Database className="w-3.5 h-3.5" />
              同步全部笔记
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

          {loading && tab === 'sync' && (
            <div className="py-10 text-center text-xs text-[var(--text-muted)] flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              正在生成全量同步码...
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

          {staged && (
            <div className="space-y-3.5 text-center">
              <div className="inline-block p-3 bg-white rounded-2xl border border-black/10">
                <img src={staged.qrDataUrl} alt="扫码快传二维码" className="w-44 h-44 mx-auto" />
              </div>

              {staged.fileNames && staged.fileNames.length > 0 && (
                <div className="text-xs text-[var(--text-secondary)]">
                  待接收文件：{staged.fileNames.join('、')}
                </div>
              )}

              <p className="text-[11px] text-[var(--text-muted)]">
                打开安卓手机「知悟」App → 点击 <strong>「+ 导入 → 扫码导入文件」</strong> 对准上方二维码即可秒传（同 Wi-Fi，30 分钟内有效）。
              </p>

              {staged.adapters && staged.adapters.length > 1 && (
                <select
                  value={staged.primaryIp}
                  onChange={(e) => switchIp(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl zw-input text-xs"
                >
                  {staged.adapters.map((a) => (
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
                <code className="text-[11px] font-mono flex-1 truncate">{staged.url}</code>
                <button
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
