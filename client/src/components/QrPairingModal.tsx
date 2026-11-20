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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[#E8E5DF] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#EFECE6]">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-[#3B5BDB]" />
            <h3 className="font-bold text-[#1C1B18]">安卓手机端扫码直连</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[#6F6B63] hover:bg-[#F5F3EE]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 text-center space-y-4">
          {info?.qrDataUrl ? (
            <div className="inline-block p-3 bg-white rounded-2xl border border-[#E8E5DF] shadow-sm">
              <img src={info.qrDataUrl} alt="手机访问二维码" className="w-48 h-48 mx-auto" />
            </div>
          ) : (
            <div className="w-48 h-48 mx-auto rounded-2xl bg-[#F5F3EE] flex items-center justify-center text-xs text-[#7A756C]">
              正在获取局域网地址...
            </div>
          )}

          {info?.adapters && info.adapters.length > 1 && (
            <div className="text-left">
              <label className="block text-[11px] font-medium text-[#7A756C] mb-1">切换网卡地址（优先选择 WLAN / 以太网）</label>
              <select
                value={selectedIp}
                onChange={(e) => loadInfo(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-xs"
              >
                {info.adapters.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.name} ({a.address}){a.isVirtual ? ' [虚拟网卡]' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {info?.mobileUrl && (
            <div className="flex items-center gap-2 bg-[#F5F3EE] rounded-xl px-3 py-2 text-left">
              <Wifi className="w-4 h-4 text-[#0F766E] shrink-0" />
              <code className="text-xs font-mono text-[#1C1B18] flex-1 truncate">{info.mobileUrl}</code>
              <button
                onClick={copyUrl}
                className="px-2.5 py-1 rounded-lg bg-white border border-[#E5E2DC] text-xs font-medium text-[#1C1B18] hover:bg-[#FAF9F6] flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          )}

          <div className="text-left bg-[#F3F5FC] rounded-xl p-3.5 text-xs text-[#2E3A67] space-y-1.5 leading-relaxed">
            <p className="font-semibold text-[#1E2B58]">安装为安卓原生风格 App（PWA）：</p>
            <p>1. 确保手机与电脑连接在<strong>同一个 Wi-Fi</strong>（外出随时访问可使用 Tailscale 组网或部署到轻量云主机）。</p>
            <p>2. 用安卓 Chrome / Edge 浏览器扫码或输入上方地址打开。</p>
            <p>3. 点击浏览器右上角菜单 → <strong>「添加到主屏幕 / 安装应用」</strong>，即可全屏使用并支持<strong>手机直接拍照记笔记</strong>！</p>
          </div>
        </div>
      </div>
    </div>
  );
}
