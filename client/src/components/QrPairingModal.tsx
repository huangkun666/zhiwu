import { useEffect, useState } from 'react';
import { Check, Copy, Smartphone, Wifi, X } from 'lucide-react';
import { api } from '../api/client';

interface QrPairingModalProps {
  open: boolean;
  onClose: () => void;
}

export function QrPairingModal({ open, onClose }: QrPairingModalProps) {
  const [info, setInfo] = useState<{
    adapters?: { name: string; address: string; isVirtual: boolean }[];
    ips: string[];
    primaryIp: string;
    mobileUrl: string;
    qrDataUrl: string;
  } | null>(null);
  const [selectedIp, setSelectedIp] = useState('');
  const [copied, setCopied] = useState(false);

  const loadInfo = (ip?: string) => {
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    api
      .getNetworkInfo(port, ip)
      .then((res) => {
        setInfo(res);
        setSelectedIp(res.primaryIp);
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    loadInfo();
  }, [open]);

  if (!open) return null;

  const copyUrl = () => {
    if (!info?.mobileUrl) return;
    navigator.clipboard?.writeText(info.mobileUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
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
            <Smartphone className="w-4 h-4 text-[var(--text-secondary)]" />
            <h3 className="font-semibold text-sm">局域网手机扫码访问</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 text-center space-y-4">
          {info?.qrDataUrl ? (
            <div className="inline-block p-3 bg-white rounded-2xl border border-black/10">
              <img src={info.qrDataUrl} alt="手机访问二维码" className="w-44 h-44 mx-auto" />
            </div>
          ) : (
            <div
              className="w-44 h-44 mx-auto rounded-2xl flex items-center justify-center text-xs text-[var(--text-muted)]"
              style={{ background: 'var(--bg-subtle)' }}
            >
              正在获取局域网地址...
            </div>
          )}

          {info?.adapters && info.adapters.length > 1 && (
            <div className="text-left">
              <label className="block text-[11px] text-[var(--text-muted)] mb-1">切换网卡（优先选择 WLAN）</label>
              <select
                value={selectedIp}
                onChange={(e) => loadInfo(e.target.value)}
                className="w-full px-3 py-2 rounded-xl zw-input text-xs"
              >
                {info.adapters.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.name} ({a.address}){a.isVirtual ? ' [虚拟]' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {info?.mobileUrl && (
            <div
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-left border"
              style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
            >
              <Wifi className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
              <code className="text-xs font-mono flex-1 truncate">{info.mobileUrl}</code>
              <button
                onClick={copyUrl}
                className="px-2.5 py-1 rounded-lg zw-btn-secondary text-xs flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
