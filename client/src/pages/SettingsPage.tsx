import { useEffect, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  Eye,
  EyeOff,
  HardDrive,
  ImageOff,
  Loader2,
  Moon,
  QrCode,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Sun,
  Upload,
  Zap,
} from 'lucide-react';
import { api, IS_STANDALONE_MODE } from '../api/client';
import { QrScannerModal } from '../components/QrScannerModal';
import { QrSendModal } from '../components/QrSendModal';
import type { AIProviderConfig, AISettings } from '../types';
import {
  checkRemoteUpdate,
  getCurrentDisplayVersion,
  getNativeOtaState,
  getOtaConfig,
  resetNativeOta,
  saveOtaConfig,
  triggerNativeOtaUpdate,
  type RemoteReleaseInfo,
} from '../utils/ota';
import type { ThemeMode } from '../utils/theme';

interface SettingsPageProps {
  theme: ThemeMode;
  onSelectTheme: (mode: ThemeMode) => void;
  onSettingsChanged?: () => void;
}

const VISION_MODEL_HINT = /gemini|gpt-4o|gpt-4\.1|vl|vision|llava|omni|claude-3|claude-sonnet-4|pixtral|qvq/i;

export function SettingsPage({ theme, onSelectTheme, onSettingsChanged }: SettingsPageProps) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [selectedId, setSelectedId] = useState<'remote' | 'local'>('remote');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedToast, setSavedToast] = useState(false);

  // Live fetched model list
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState('');
  const [modelsError, setModelsError] = useState('');
  const [qrSendOpen, setQrSendOpen] = useState(false);
  const [qrScanOpen, setQrScanOpen] = useState(false);

  // In-App OTA Live Update state
  const [otaConfig, setOtaConfig] = useState(getOtaConfig);
  const [showOtaToken, setShowOtaToken] = useState(false);
  const [checkingOta, setCheckingOta] = useState(false);
  const [remoteRelease, setRemoteRelease] = useState<RemoteReleaseInfo | null>(null);
  const [otaProgress, setOtaProgress] = useState('');
  const [otaError, setOtaError] = useState('');
  const nativeOta = getNativeOtaState();
  const currentAppVer = getCurrentDisplayVersion();

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setSelectedId(s.activeProviderId === 'local' ? 'local' : 'remote');
    });
  }, []);

  if (!settings) {
    return <div className="p-12 text-center text-xs text-[var(--text-muted)]">加载配置中...</div>;
  }

  const currentProvider = settings.providers.find((p) => p.id === selectedId) || settings.providers[0];

  const updateProviderField = <K extends keyof AIProviderConfig>(field: K, value: AIProviderConfig[K]) => {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        providers: prev.providers.map((p) => {
          if (p.id !== currentProvider.id) return p;
          const next = { ...p, [field]: value };
          if (field === 'model' && typeof value === 'string') {
            if (VISION_MODEL_HINT.test(value)) next.supportsVision = true;
            else if (/deepseek-chat|deepseek-reasoner|qwen-plus|qwen-turbo|qwen-max/i.test(value))
              next.supportsVision = false;
          }
          if (field === 'type' && value === 'gemini' && (!p.baseUrl || p.baseUrl.includes('deepseek') || p.baseUrl.includes('openai'))) {
            next.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
          }
          return next;
        }),
      };
    });
  };

  const handleSave = async (makeActive = false) => {
    setSaving(true);
    setTestResult(null);
    try {
      const payload: AISettings = {
        ...settings,
        activeProviderId: makeActive ? currentProvider.id : settings.activeProviderId,
      };
      const updated = await api.saveSettings(payload);
      setSettings(updated);
      onSettingsChanged?.();
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 2200);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testAI(currentProvider);
      setTestResult({ ok: true, text: `连接成功 (${res.latencyMs}ms)：${res.reply}` });
    } catch (e: any) {
      setTestResult({ ok: false, text: e.message || '连接失败' });
    } finally {
      setTesting(false);
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setModelsError('');
    setModelFilter('');
    try {
      const res = await api.fetchModels(currentProvider);
      setFetchedModels(res.models || []);
      if (!res.models?.length) {
        setModelsError('接口返回了空的模型列表，请手动输入模型名称。');
      }
    } catch (e: any) {
      setFetchedModels([]);
      setModelsError(e.message || '获取模型列表失败');
    } finally {
      setFetchingModels(false);
    }
  };

  const handleExportJson = async () => {
    const json = await api.exportJsonBackup();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zhiwu-sync-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = async (file: File) => {
    try {
      const text = await file.text();
      const res = await api.importJsonBackup(text);
      alert(`同步合并成功！共合并 ${res.notesCount} 篇笔记（保留原有数据，不覆盖）。`);
      onSettingsChanged?.();
    } catch (err: any) {
      alert(err.message || '导入失败');
    }
  };

  const handleCheckOta = async () => {
    saveOtaConfig(otaConfig);
    setCheckingOta(true);
    setOtaError('');
    setRemoteRelease(null);
    try {
      const info = await checkRemoteUpdate(otaConfig);
      setRemoteRelease(info);
    } catch (e: any) {
      setOtaError(e.message || '检查更新失败');
    } finally {
      setCheckingOta(false);
    }
  };

  const handleApplyOta = () => {
    if (!remoteRelease) return;
    setOtaError('');
    setOtaProgress('正在连接 GitHub 下载更新包...');
    try {
      triggerNativeOtaUpdate(
        remoteRelease.bundleDownloadUrl,
        remoteRelease.version,
        otaConfig.token,
        (ev) => {
          if (ev.status === 'error') {
            setOtaProgress('');
            setOtaError(ev.message);
          } else {
            setOtaProgress(ev.message);
          }
        }
      );
    } catch (e: any) {
      setOtaProgress('');
      setOtaError(e.message || '启动热更新失败');
    }
  };

  const filteredModels = modelFilter.trim()
    ? fetchedModels.filter((m) => m.toLowerCase().includes(modelFilter.trim().toLowerCase()))
    : fetchedModels;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          深浅主题、AI 模型与跨端通用备份。
        </p>
      </div>

      {/* Dual Minimal Theme Switcher */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-3.5">
        <h2 className="font-semibold text-sm">外观主题</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => onSelectTheme('dark')}
            className="text-left text-[var(--text-primary)] p-4 rounded-xl border transition cursor-pointer flex items-center justify-between"
            style={{
              background: theme === 'dark' ? 'var(--bg-active)' : 'var(--bg-subtle)',
              borderColor: theme === 'dark' ? 'var(--border-strong)' : 'var(--border-hairline)',
            }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#09090B] border border-white/15 flex items-center justify-center text-white">
                <Moon className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-semibold">曜石暗夜磨砂</div>
                <div className="text-[11px] text-[var(--text-muted)]">深空石墨 · 1px 玻璃高光</div>
              </div>
            </div>
            {theme === 'dark' && <CheckCircle2 className="w-4 h-4" />}
          </button>

          <button
            onClick={() => onSelectTheme('light')}
            className="text-left text-[var(--text-primary)] p-4 rounded-xl border transition cursor-pointer flex items-center justify-between"
            style={{
              background: theme === 'light' ? 'var(--bg-active)' : 'var(--bg-subtle)',
              borderColor: theme === 'light' ? 'var(--border-strong)' : 'var(--border-hairline)',
            }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#ECEEF2] border border-black/10 flex items-center justify-center text-[#1D1D1F]">
                <Sun className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-semibold">冰雾浅灰磨砂</div>
                <div className="text-[11px] text-[var(--text-muted)]">冷灰画布 · 乳白通透质感</div>
              </div>
            </div>
            {theme === 'light' && <CheckCircle2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Clean 2-Slot AI Model Config: Remote vs Local */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-[var(--text-secondary)]" />
          <h2 className="font-semibold text-sm">AI 模型配置</h2>
        </div>

        {/* Remote vs Local Switcher (clean single-line, zero redundant subtitle) */}
        <div className="grid grid-cols-2 gap-2.5">
          {[
            { id: 'remote' as const, label: '远程模型', icon: Cloud },
            { id: 'local' as const, label: '本地模型', icon: HardDrive },
          ].map((item) => {
            const Icon = item.icon;
            const isSelected = selectedId === item.id;
            const isActive = settings.activeProviderId === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setSelectedId(item.id);
                  setTestResult(null);
                  setFetchedModels([]);
                  setModelsError('');
                }}
                className="px-3 py-3 rounded-xl border transition cursor-pointer flex items-center justify-center gap-2 whitespace-nowrap"
                style={{
                  background: isSelected ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                  color: isSelected ? 'var(--btn-primary-fg)' : 'var(--text-primary)',
                  borderColor: isSelected ? 'transparent' : 'var(--border-hairline)',
                }}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="text-xs font-semibold">{item.label}</span>
                {isActive && (
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: isSelected ? 'var(--btn-primary-fg)' : 'var(--ok-fg)' }}
                    title="当前启用"
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Provider Form */}
        <div className="space-y-4">
          {selectedId === 'remote' && (
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1.5">接口协议</label>
              <select
                value={currentProvider.type}
                onChange={(e) => {
                  updateProviderField('type', e.target.value as 'openai' | 'gemini');
                  setFetchedModels([]);
                }}
                className="w-full px-3.5 py-2.5 rounded-xl zw-input text-xs"
              >
                <option value="openai">OpenAI 兼容协议（DeepSeek / 通义千问 / OpenAI / 中转站通用）</option>
                <option value="gemini">Google Gemini 原生协议</option>
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
              API Base URL
              <span className="text-[var(--text-muted)] ml-1.5">
                {selectedId === 'local' ? '（如 http://127.0.0.1:11434/v1）' : '（如 https://api.deepseek.com/v1）'}
              </span>
            </label>
            <input
              value={currentProvider.baseUrl}
              onChange={(e) => updateProviderField('baseUrl', e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl zw-input text-sm font-mono"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
              API Key {selectedId === 'local' && <span className="text-[var(--text-muted)]">（本地服务留空或填 ollama 即可）</span>}
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={currentProvider.apiKey}
                onChange={(e) => updateProviderField('apiKey', e.target.value)}
                placeholder={selectedId === 'local' ? 'ollama（可选）' : 'sk-...'}
                className="w-full pl-3.5 pr-10 py-2.5 rounded-xl zw-input text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] cursor-pointer"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Model Name + Fetch Live Model List (min-w-0 prevents right-edge overflow on mobile!) */}
          <div className="space-y-2.5">
            <label className="block text-xs text-[var(--text-secondary)]">模型名称</label>
            <div className="flex items-stretch gap-2 min-w-0">
              <input
                value={currentProvider.model}
                onChange={(e) => updateProviderField('model', e.target.value)}
                placeholder={selectedId === 'local' ? 'qwen2.5:7b / llava' : 'deepseek-chat / gpt-4o-mini'}
                className="flex-1 min-w-0 px-3 py-2.5 rounded-xl zw-input text-sm font-mono"
              />
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={fetchingModels}
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl zw-btn-secondary text-xs font-medium shrink-0 whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                {fetchingModels ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                获取列表
              </button>
            </div>

            {modelsError && (
              <div
                className="p-2.5 rounded-xl border text-xs"
                style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }}
              >
                {modelsError}
              </div>
            )}

            {fetchedModels.length > 0 && (
              <div
                className="p-3 rounded-xl border space-y-2"
                style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[var(--text-muted)]">
                    已获取 {fetchedModels.length} 个可用模型，点击选用：
                  </span>
                  {fetchedModels.length > 8 && (
                    <input
                      value={modelFilter}
                      onChange={(e) => setModelFilter(e.target.value)}
                      placeholder="筛选模型..."
                      className="w-36 px-2.5 py-1 rounded-lg zw-input text-[11px]"
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto pr-0.5">
                  {filteredModels.map((m) => {
                    const active = currentProvider.model === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => updateProviderField('model', m)}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-mono border transition cursor-pointer"
                        style={{
                          background: active ? 'var(--btn-primary-bg)' : 'var(--bg-card-solid)',
                          color: active ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                          borderColor: active ? 'transparent' : 'var(--border-hairline)',
                        }}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Vision Capability Toggle */}
          <label
            className="flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer"
            style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
          >
            <input
              type="checkbox"
              checked={Boolean(currentProvider.supportsVision)}
              onChange={(e) => updateProviderField('supportsVision', e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded accent-[var(--text-primary)]"
            />
            <div className="flex-1">
              <div className="text-xs font-semibold flex items-center gap-1.5">
                {currentProvider.supportsVision ? (
                  <Camera className="w-3.5 h-3.5" />
                ) : (
                  <ImageOff className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                )}
                此模型支持图片 / 视觉输入（多模态）
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                {currentProvider.supportsVision
                  ? '已开启：允许上传图片与手机拍照自动压缩识字。'
                  : '未开启：导入面板将禁止上传图片并明确提示不支持视觉输入。'}
              </p>
            </div>
          </label>
        </div>

        {testResult && (
          <div
            className="p-3 rounded-xl border text-xs"
            style={
              testResult.ok
                ? { background: 'var(--ok-bg)', borderColor: 'var(--ok-border)', color: 'var(--ok-fg)' }
                : { background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }
            }
          >
            {testResult.text}
          </div>
        )}

        <div
          className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            测试连接
          </button>

          <div className="flex items-center gap-2">
            {savedToast && (
              <span className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--ok-fg)' }}>
                <CheckCircle2 className="w-3.5 h-3.5" /> 已保存
              </span>
            )}
            <button
              onClick={() => handleSave(false)}
              disabled={saving}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl zw-btn-secondary text-xs cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              仅保存
            </button>
            <button
              onClick={() => handleSave(true)}
              disabled={saving}
              className="px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
            >
              保存并启用
            </button>
          </div>
        </div>
      </div>

      {/* Unified Cross-Device Sync & QR File Transfer */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-4">
        <div>
          <h2 className="font-semibold text-sm">跨端快传与通用备份（电脑 ↔ 安卓 APK）</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            支持同 Wi-Fi 扫码直接互传文件或全量同步笔记，亦支持 JSON 文件智能增量合并。
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {!IS_STANDALONE_MODE ? (
            <button
              onClick={() => setQrSendOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
            >
              <QrCode className="w-3.5 h-3.5" />
              生成扫码快传码（传给手机）
            </button>
          ) : (
            <button
              onClick={() => setQrScanOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
            >
              <QrCode className="w-3.5 h-3.5" />
              扫码从电脑导入 / 同步
            </button>
          )}
          <button
            onClick={handleExportJson}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            导出 JSON 备份
          </button>
          <label className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            导入并智能合并
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImportJson(f);
              }}
            />
          </label>
          {!IS_STANDALONE_MODE && (
            <a
              href="/api/settings/backup"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium"
            >
              下载原始 SQLite (.db)
            </a>
          )}
        </div>
      </div>

      {/* In-App Remote OTA Live Update (Android APK skips APK reinstall!) */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-sm flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              远程在线更新（免重装 APK）
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              当前版本 <span className="font-mono font-semibold text-[var(--text-primary)]">v{currentAppVer}</span>
              {nativeOta.isOtaActive ? '（热更新版）' : '（内置版）'}
            </p>
          </div>
          {nativeOta.isOtaActive && (
            <button
              type="button"
              onClick={() => {
                if (confirm('恢复为安装包内置版本？')) resetNativeOta();
              }}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg zw-btn-secondary text-[11px] cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              恢复内置
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-[var(--text-muted)] mb-1">GitHub 仓库</label>
            <input
              value={otaConfig.repo}
              onChange={(e) => setOtaConfig((p) => ({ ...p, repo: e.target.value }))}
              placeholder="huangkun666/zhiwu"
              className="w-full px-3 py-2 rounded-xl zw-input text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] text-[var(--text-muted)] mb-1">
              GitHub Token <span className="opacity-70">（私有仓库必填，公开留空）</span>
            </label>
            <div className="relative">
              <input
                type={showOtaToken ? 'text' : 'password'}
                value={otaConfig.token}
                onChange={(e) => setOtaConfig((p) => ({ ...p, token: e.target.value }))}
                placeholder="ghp_...（私有库填写一次即可）"
                className="w-full pl-3 pr-9 py-2 rounded-xl zw-input text-xs font-mono"
              />
              <button
                type="button"
                onClick={() => setShowOtaToken(!showOtaToken)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] cursor-pointer"
              >
                {showOtaToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>

        {otaError && (
          <div
            className="p-3 rounded-xl border text-xs"
            style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }}
          >
            {otaError}
          </div>
        )}

        {otaProgress && (
          <div
            className="p-3 rounded-xl border text-xs flex items-center gap-2"
            style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>{otaProgress}</span>
          </div>
        )}

        {remoteRelease && (
          <div
            className="p-3.5 rounded-xl border space-y-2 text-xs"
            style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">
                {remoteRelease.hasUpdate ? `发现新版本 v${remoteRelease.version}` : `已是最新版本 (v${remoteRelease.version})`}
              </span>
              {remoteRelease.updatedAt && (
                <span className="text-[10px] text-[var(--text-muted)]">
                  {new Date(remoteRelease.updatedAt).toLocaleString()}
                </span>
              )}
            </div>
            <p className="text-[var(--text-secondary)] leading-relaxed">{remoteRelease.changelog}</p>
            {remoteRelease.hasUpdate && (
              <div className="pt-1 flex flex-wrap gap-2">
                {!remoteRelease.needsApkReinstall && nativeOta.isNative ? (
                  <button
                    type="button"
                    disabled={Boolean(otaProgress)}
                    onClick={handleApplyOta}
                    className="px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer disabled:opacity-50"
                  >
                    立即一键热更新（无需重装 APK）
                  </button>
                ) : remoteRelease.needsApkReinstall ? (
                  <a
                    href={remoteRelease.apkDownloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold inline-block"
                  >
                    包含底层升级，点击下载新版 APK
                  </a>
                ) : (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    提示：请在安卓手机 App 内点击「立即热更新」直接免重装生效。
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCheckOta}
            disabled={checkingOta || Boolean(otaProgress)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer disabled:opacity-50"
          >
            {checkingOta ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            检查远程更新
          </button>
        </div>
      </div>

      <QrSendModal open={qrSendOpen} onClose={() => setQrSendOpen(false)} />
      <QrScannerModal
        open={qrScanOpen}
        onClose={() => setQrScanOpen(false)}
        onCompleted={() => onSettingsChanged?.()}
      />
    </div>
  );
}
