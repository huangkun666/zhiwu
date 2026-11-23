import { useEffect, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Cloud,
  Cpu,
  Eye,
  EyeOff,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  ImageOff,
  Loader2,
  Moon,
  QrCode,
  RefreshCw,
  RotateCcw,
  Save,
  Sun,
  Zap,
} from 'lucide-react';
import { api, IS_STANDALONE_MODE } from '../api/client';
import { LibraryBackupPanel } from '../components/LibraryBackupPanel';
import { QrScannerModal } from '../components/QrScannerModal';
import { QrSendModal } from '../components/QrSendModal';
import type { AIProviderConfig, AISettings } from '../types';
import {
  checkAllBranchesUpdate,
  formatRelativeTime,
  getCurrentRef,
  getNativeOtaState,
  OTA_REPO,
  resetNativeOta,
  triggerNativeCommitUpdate,
  type RemoteCommitInfo,
  type UpdateCheckResult,
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
  const [qrBackupOnly, setQrBackupOnly] = useState(false);

  // Remote branch & commit update state
  const nativeOta = getNativeOtaState();
  const currentRef = getCurrentRef();
  const [checkingOta, setCheckingOta] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [selectedBranch, setSelectedBranch] = useState(currentRef.branch);
  const [selectedCommitSha, setSelectedCommitSha] = useState('');
  const [otaProgress, setOtaProgress] = useState('');
  const [otaError, setOtaError] = useState('');

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

  const selectBranch = (branchName: string, info: UpdateCheckResult) => {
    setSelectedBranch(branchName);
    const branch = info.branches.find((b) => b.name === branchName);
    const commits = branch?.commits || [];
    const firstInstallable = commits.find((c) => c.bundle && !c.isCurrent) || commits[0];
    setSelectedCommitSha(firstInstallable?.sha || '');
  };

  const handleCheckOta = async () => {
    setCheckingOta(true);
    setOtaError('');
    try {
      const info = await checkAllBranchesUpdate();
      setUpdateInfo(info);
      const defaultBranch = info.branches.some((b) => b.name === selectedBranch)
        ? selectedBranch
        : info.currentBranchInfo?.name || info.branches[0]?.name || 'main';
      selectBranch(defaultBranch, info);
    } catch (e: any) {
      setOtaError(e.message || '检查更新失败');
    } finally {
      setCheckingOta(false);
    }
  };

  const handleApplyCommit = (branchName: string, commit: RemoteCommitInfo) => {
    setOtaError('');
    setOtaProgress(`正在下载 ${branchName} @ ${commit.shortSha}...`);
    try {
      triggerNativeCommitUpdate(branchName, commit, (ev) => {
        if (ev.status === 'error') {
          setOtaProgress('');
          setOtaError(ev.message);
        } else {
          setOtaProgress(ev.message);
        }
      });
    } catch (e: any) {
      setOtaProgress('');
      setOtaError(e.message || '更新失败');
    }
  };

  const activeBranchObj = updateInfo?.branches.find((b) => b.name === selectedBranch) || null;
  const branchCommits = activeBranchObj?.commits || [];
  const selectedCommitObj = branchCommits.find((c) => c.sha === selectedCommitSha) || null;

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

      <LibraryBackupPanel
        onRestored={onSettingsChanged}
        onOpenBackupTransfer={() => {
          setQrBackupOnly(true);
          setQrScanOpen(true);
        }}
      />

      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-4">
        <div>
          <h2 className="font-semibold text-sm">局域网快传</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            电脑和手机连接同一 Wi-Fi 后，可扫码传输文件。
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {!IS_STANDALONE_MODE ? (
            <button
              onClick={() => setQrSendOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
            >
              <QrCode className="w-3.5 h-3.5" />
              打开扫码快传
            </button>
          ) : (
            <button
              onClick={() => {
                setQrBackupOnly(false);
                setQrScanOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
            >
              <QrCode className="w-3.5 h-3.5" />
              扫码从电脑导入 / 同步
            </button>
          )}
        </div>
      </div>

      {/* Application Update: Read-only Repo + Branch & Commit Selector */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <GitBranch className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
            <h2 className="font-semibold text-sm">应用更新</h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              {currentRef.branch} @ {currentRef.shortSha}
            </span>
            {nativeOta.isOtaActive && (
              <button
                type="button"
                onClick={() => {
                  if (confirm('恢复为安装包内置版本？')) resetNativeOta();
                }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg zw-btn-secondary text-[11px] cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                恢复内置
              </button>
            )}
          </div>
        </div>

        {/* Read-only repository row + Check button */}
        <div className="flex items-center justify-between gap-2.5 min-w-0">
          <div
            className="flex-1 min-w-0 px-3 py-2 rounded-xl border text-xs font-mono text-[var(--text-secondary)] truncate select-all"
            style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
          >
            {OTA_REPO}
          </div>
          <button
            type="button"
            onClick={handleCheckOta}
            disabled={checkingOta || Boolean(otaProgress)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl zw-btn-secondary text-xs font-medium shrink-0 whitespace-nowrap cursor-pointer disabled:opacity-50"
          >
            {checkingOta ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            检查更新
          </button>
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

        {updateInfo && (
          <div className="space-y-4 pt-1">
            {/* 1. Current Branch Status */}
            {updateInfo.currentBranchInfo && (
              <div
                className="p-3.5 rounded-xl border space-y-2.5"
                style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-semibold truncate">
                      {updateInfo.currentBranchInfo.hasUpdate
                        ? `${updateInfo.currentBranchInfo.name} 有 ${updateInfo.currentBranchInfo.aheadBy} 个新提交`
                        : `${updateInfo.currentBranchInfo.name} 已是最新`}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">
                    {updateInfo.currentBranchInfo.headShortSha}
                  </span>
                </div>

                <div className="text-xs text-[var(--text-secondary)] truncate">
                  {updateInfo.currentBranchInfo.headMessage}
                  {updateInfo.currentBranchInfo.headDate && (
                    <span className="text-[var(--text-muted)] ml-2">
                      {formatRelativeTime(updateInfo.currentBranchInfo.headDate)}
                    </span>
                  )}
                </div>

                {updateInfo.currentBranchInfo.hasUpdate && (
                  <div className="pt-0.5 flex flex-wrap items-center gap-2">
                    {updateInfo.currentBranchInfo.headBundle ? (
                      updateInfo.currentBranchInfo.headBundle.nativeVersion > nativeOta.nativeVersion ? (
                        <a
                          href={updateInfo.apkDownloadUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="px-3.5 py-1.5 rounded-xl zw-btn-primary text-xs font-semibold inline-block"
                        >
                          下载新版 APK
                        </a>
                      ) : nativeOta.isNative ? (
                        <button
                          type="button"
                          disabled={Boolean(otaProgress)}
                          onClick={() => {
                            const b = updateInfo.currentBranchInfo!;
                            handleApplyCommit(b.name, {
                              sha: b.headSha,
                              shortSha: b.headShortSha,
                              message: b.headMessage,
                              date: b.headDate,
                              author: '',
                              isCurrent: false,
                              bundle: b.headBundle,
                              needsApkReinstall: false,
                              isBuildingLikely: false,
                            });
                          }}
                          className="px-3.5 py-1.5 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer disabled:opacity-50"
                        >
                          更新到最新 ({updateInfo.currentBranchInfo.headShortSha})
                        </button>
                      ) : (
                        <span className="text-[11px] text-[var(--text-muted)]">当前环境不支持端内应用更新</span>
                      )
                    ) : (
                      <span className="text-[11px] text-[var(--text-muted)]">最新提交构建中，请稍后刷新</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 2. Non-current branches with new commits */}
            {updateInfo.otherUpdatedBranches.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">其他分支有新提交</span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {updateInfo.otherUpdatedBranches.length} 个分支
                  </span>
                </div>
                <div
                  className="rounded-xl border divide-y overflow-hidden"
                  style={{ borderColor: 'var(--border-hairline)', background: 'var(--bg-subtle)' }}
                >
                  {updateInfo.otherUpdatedBranches.map((b) => {
                    const isViewing = selectedBranch === b.name;
                    return (
                      <div
                        key={b.name}
                        className="px-3.5 py-2.5 flex items-center justify-between gap-3"
                        style={{ borderColor: 'var(--border-hairline)' }}
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-mono font-semibold truncate">{b.name}</span>
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0"
                              style={{ background: 'var(--bg-active)', color: 'var(--text-primary)' }}
                            >
                              +{b.aheadBy}
                            </span>
                            {b.headDate && (
                              <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                                {formatRelativeTime(b.headDate)}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] truncate">
                            <span className="font-mono mr-1.5">{b.headShortSha}</span>
                            {b.headMessage}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => selectBranch(b.name, updateInfo)}
                          className="px-2.5 py-1 rounded-lg zw-btn-secondary text-[11px] shrink-0 cursor-pointer"
                          style={
                            isViewing
                              ? { background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)', borderColor: 'transparent' }
                              : undefined
                          }
                        >
                          {isViewing ? '已选中' : '查看'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 3. Branch & Commit Selector */}
            <div className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-end">
                <div>
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">分支</label>
                  <select
                    value={selectedBranch}
                    onChange={(e) => selectBranch(e.target.value, updateInfo)}
                    className="w-full px-3 py-2 rounded-xl zw-input text-xs font-mono"
                  >
                    {updateInfo.branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                        {b.isCurrent ? ' (当前)' : ''}
                        {b.hasUpdate ? ` (+${b.aheadBy})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="text-[11px] text-[var(--text-muted)] sm:text-right pb-1">
                  共 {branchCommits.length} 条提交
                </div>
              </div>

              <div
                className="rounded-xl border divide-y max-h-64 overflow-y-auto"
                style={{ borderColor: 'var(--border-hairline)', background: 'var(--bg-subtle)' }}
              >
                {branchCommits.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[var(--text-muted)]">暂无提交记录</div>
                ) : (
                  branchCommits.map((c) => {
                    const isSelected = selectedCommitSha === c.sha;
                    const selectable = Boolean(c.bundle) && !c.isCurrent;
                    return (
                      <button
                        key={c.sha}
                        type="button"
                        onClick={() => setSelectedCommitSha(c.sha)}
                        className="w-full text-left px-3.5 py-2.5 flex items-center justify-between gap-2.5 transition cursor-pointer"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          background: isSelected ? 'var(--bg-active)' : 'transparent',
                        }}
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <GitCommitHorizontal className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                            <span className="text-xs font-mono font-semibold shrink-0">{c.shortSha}</span>
                            <span className="text-xs text-[var(--text-primary)] truncate">{c.message}</span>
                          </div>
                          <div className="text-[10px] text-[var(--text-muted)] pl-5">
                            {formatRelativeTime(c.date)}
                          </div>
                        </div>
                        <span
                          className="px-2 py-0.5 rounded-md text-[10px] shrink-0 border"
                          style={
                            c.isCurrent
                              ? { background: 'var(--ok-bg)', borderColor: 'var(--ok-border)', color: 'var(--ok-fg)' }
                              : selectable
                                ? { background: 'var(--bg-card-solid)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }
                                : { background: 'transparent', borderColor: 'var(--border-hairline)', color: 'var(--text-muted)' }
                          }
                        >
                          {c.isCurrent ? '当前' : c.bundle ? '可切换' : c.isBuildingLikely ? '构建中' : '无构建包'}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              {selectedCommitObj && !selectedCommitObj.isCurrent && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] font-mono text-[var(--text-muted)]">
                    目标：{selectedBranch} @ {selectedCommitObj.shortSha}
                  </span>
                  {selectedCommitObj.needsApkReinstall ? (
                    <a
                      href={updateInfo.apkDownloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold inline-block"
                    >
                      下载新版 APK
                    </a>
                  ) : selectedCommitObj.bundle ? (
                    nativeOta.isNative ? (
                      <button
                        type="button"
                        disabled={Boolean(otaProgress)}
                        onClick={() => handleApplyCommit(selectedBranch, selectedCommitObj)}
                        className="px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer disabled:opacity-50"
                      >
                        切换到 {selectedBranch} @ {selectedCommitObj.shortSha}
                      </button>
                    ) : (
                      <span className="text-[11px] text-[var(--text-muted)]">请在安卓端执行切换</span>
                    )
                  ) : (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {selectedCommitObj.isBuildingLikely ? '该提交构建中' : '该提交无可用构建包'}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <QrSendModal open={qrSendOpen} onClose={() => setQrSendOpen(false)} />
      <QrScannerModal
        open={qrScanOpen}
        backupOnly={qrBackupOnly}
        onClose={() => setQrScanOpen(false)}
        onCompleted={() => onSettingsChanged?.()}
      />
    </div>
  );
}
