import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CheckCircle2, Image, Link2, Loader2, QrCode, X } from 'lucide-react';
import { api } from '../api/client';
import type { Note } from '../types';

interface QrScannerModalProps {
  open: boolean;
  onClose: () => void;
  onCompleted: (result: { kind: 'files' | 'sync'; notes?: Note[]; count: number }) => void;
}

function base64ToFile(base64: string, name: string, mimeType: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mimeType || 'application/octet-stream' });
}

export function QrScannerModal({ open, onClose, onCompleted }: QrScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const handledRef = useRef(false);

  const [cameraError, setCameraError] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [busyText, setBusyText] = useState('');
  const [error, setError] = useState('');
  const [doneMsg, setDoneMsg] = useState('');

  const stopCamera = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const handleTransferUrl = async (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      setError('未识别到有效的快传链接（需以 http:// 或 https:// 开头）');
      return;
    }
    stopCamera();
    setError('');
    setBusyText('正在通过局域网拉取文件...');
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error(data?.error || `连接失败 (${res.status})，请确认手机与电脑在同一 Wi-Fi`);
      }

      if (data.kind === 'sync' && data.payload) {
        setBusyText('正在智能合并电脑笔记库...');
        const merged = await api.importJsonBackup(JSON.stringify(data.payload));
        setDoneMsg(`同步完成！已合并 ${merged.notesCount} 篇笔记`);
        onCompleted({ kind: 'sync', count: merged.notesCount });
        setTimeout(onClose, 1200);
        return;
      }

      if (data.kind === 'files' && Array.isArray(data.files) && data.files.length > 0) {
        setBusyText(`已接收 ${data.files.length} 个文件，正在解析导入笔记库...`);
        const fileObjs = data.files.map((f: any) => base64ToFile(f.base64, f.name, f.mimeType));
        const imp = await api.importFiles(fileObjs);
        setDoneMsg(`成功扫码导入 ${imp.imported.length} 篇笔记！`);
        onCompleted({ kind: 'files', notes: imp.imported, count: imp.imported.length });
        setTimeout(onClose, 1200);
        return;
      }

      throw new Error('二维码内容不是有效的知悟快传包');
    } catch (e: any) {
      handledRef.current = false;
      setError(e?.message || '拉取失败，请检查网络或重新生成二维码');
    } finally {
      setBusyText('');
    }
  };

  const startCamera = async () => {
    setCameraError('');
    handledRef.current = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('当前环境不支持实时调用摄像头，请使用下方「从相册选二维码」或粘贴快传链接。');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      timerRef.current = window.setInterval(() => {
        if (handledRef.current || !videoRef.current || !canvasRef.current) return;
        const video = videoRef.current;
        if (video.readyState !== video.HAVE_ENOUGH_DATA || video.videoWidth === 0) return;
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height);
        if (code?.data) {
          handledRef.current = true;
          handleTransferUrl(code.data);
        }
      }, 200);
    } catch {
      setCameraError('未获得摄像头权限，可点击下方「从相册选二维码」或直接粘贴电脑快传链接。');
    }
  };

  useEffect(() => {
    if (!open) {
      stopCamera();
      return;
    }
    setError('');
    setDoneMsg('');
    setManualUrl('');
    startCamera();
    return () => stopCamera();
  }, [open]);

  const handleDecodeImageFile = (file: File) => {
    setError('');
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height);
      if (code?.data) {
        handleTransferUrl(code.data);
      } else {
        setError('图片中未识别到二维码，请确保二维码清晰完整');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError('无法读取该图片');
    };
    img.src = url;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md zw-modal rounded-2xl overflow-hidden">
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4" />
            <h3 className="font-semibold text-sm">扫码导入文件 / 同步电脑笔记</h3>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Camera Viewfinder */}
          {!doneMsg && (
            <div className="relative rounded-2xl overflow-hidden bg-black aspect-[4/3] flex items-center justify-center">
              <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
              <canvas ref={canvasRef} className="hidden" />
              {!cameraError && !busyText && (
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <div className="w-48 h-48 rounded-2xl border-2 border-white/75 shadow-[0_0_0_9999px_rgba(0,0,0,0.42)]" />
                </div>
              )}
              {cameraError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-5 text-center text-xs text-white/80 bg-black/80 space-y-2">
                  <Camera className="w-7 h-7 opacity-60" />
                  <p className="leading-relaxed">{cameraError}</p>
                </div>
              )}
              {busyText && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-5 text-center text-xs text-white bg-black/75 space-y-2">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <p>{busyText}</p>
                </div>
              )}
            </div>
          )}

          {doneMsg && (
            <div
              className="p-5 rounded-2xl border text-center space-y-2"
              style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok-border)', color: 'var(--ok-fg)' }}
            >
              <CheckCircle2 className="w-8 h-8 mx-auto" />
              <div className="text-sm font-semibold">{doneMsg}</div>
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

          {/* Fallbacks: Pick QR image from gallery OR paste transfer link */}
          <div className="space-y-2.5">
            <label className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer">
              <Image className="w-3.5 h-3.5" />
              从相册选二维码图片识别
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleDecodeImageFile(f);
                }}
              />
            </label>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link2 className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  placeholder="或粘贴电脑生成的快传链接..."
                  className="w-full pl-8 pr-3 py-2 rounded-xl zw-input text-xs font-mono"
                />
              </div>
              <button
                type="button"
                disabled={!manualUrl.trim() || Boolean(busyText)}
                onClick={() => handleTransferUrl(manualUrl)}
                className="px-3.5 py-2 rounded-xl zw-btn-primary text-xs font-semibold disabled:opacity-45 cursor-pointer"
              >
                拉取
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
