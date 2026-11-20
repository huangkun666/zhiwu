import { useEffect, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  ImageOff,
  Loader2,
  Moon,
  Plus,
  Save,
  Smartphone,
  Sun,
  Upload,
  Wifi,
  Zap,
} from 'lucide-react';
import { api, IS_STANDALONE_MODE } from '../api/client';
import type { AIProviderConfig, AISettings } from '../types';
import type { ThemeMode } from '../utils/theme';

interface SettingsPageProps {
  theme: ThemeMode;
  onSelectTheme: (mode: ThemeMode) => void;
  onSettingsChanged?: () => void;
}

const VISION_MODEL_HINT = /gemini|gpt-4o|gpt-4\.1|vl|vision|llava|omni|claude-3|claude-sonnet-4|pixtral|qvq/i;

export function SettingsPage({ theme, onSelectTheme, onSettingsChanged }: SettingsPageProps) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [selectedId, setSelectedId] = useState<string>('deepseek');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedToast, setSavedToast] = useState(false);

  const [netInfo, setNetInfo] = useState<{ mobileUrl: string; qrDataUrl: string; ips: string[] } | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setSelectedId(s.activeProviderId || s.providers[0]?.id || 'deepseek');
    });
    if (!IS_STANDALONE_MODE) {
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      api
        .getNetworkInfo(port)
        .then(setNetInfo)
        .catch(() => {});
    }
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
          return next;
        }),
      };
    });
  };

  const addCustomProvider = () => {
    const id = `custom-${Date.now().toString(36)}`;
    const next: AIProviderConfig = {
      id,
      name: '自定义兼容接口',
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      supportsVision: true,
      requiresKey: true,
    };
    setSettings((prev) => (prev ? { ...prev, providers: [...prev.providers, next] } : prev));
    setSelectedId(id);
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

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          外观主题、单一 AI 模型与电脑/手机跨端通用备份。
        </p>
      </div>

      {/* Dual Minimal Theme Switcher */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-3.5">
        <h2 className="font-semibold text-sm">外观与质感主题</h2>
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

      {/* Unified Single-Model AI Config */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[var(--text-secondary)]" />
            <h2 className="font-semibold text-sm">AI 模型配置（单一模型）</h2>
          </div>
          <button
            onClick={addCustomProvider}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> 自定义接口
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {settings.providers.map((p) => {
            const isSelected = p.id === currentProvider.id;
            const isActive = p.id === settings.activeProviderId;
            return (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedId(p.id);
                  setTestResult(null);
                }}
                className="px-3.5 py-2 rounded-xl text-xs font-medium border transition flex items-center gap-1.5 cursor-pointer"
                style={{
                  background: isSelected ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                  color: isSelected ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                  borderColor: isSelected ? 'transparent' : 'var(--border-hairline)',
                }}
              >
                {p.name}
                {isActive && (
                  <span className="text-[10px] opacity-75">· 默认</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1">配置名称</label>
            <input
              value={currentProvider.name}
              onChange={(e) => updateProviderField('name', e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl zw-input text-sm"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1">协议类型</label>
            <select
              value={currentProvider.type}
              onChange={(e) => updateProviderField('type', e.target.value as 'openai' | 'gemini')}
              className="w-full px-3.5 py-2.5 rounded-xl zw-input text-sm"
            >
              <option value="openai">OpenAI 兼容协议 (DeepSeek / 通义 / Ollama)</option>
              <option value="gemini">Google Gemini 原生协议</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs text-[var(--text-secondary)] mb-1">API Base URL</label>
            <input
              value={currentProvider.baseUrl}
              onChange={(e) => updateProviderField('baseUrl', e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl zw-input text-sm font-mono"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs text-[var(--text-secondary)] mb-1">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={currentProvider.apiKey}
                onChange={(e) => updateProviderField('apiKey', e.target.value)}
                placeholder="sk-..."
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

          <div className="sm:col-span-2">
            <label className="block text-xs text-[var(--text-secondary)] mb-1">模型名称（统一用于全部功能）</label>
            <input
              value={currentProvider.model}
              onChange={(e) => updateProviderField('model', e.target.value)}
              placeholder="deepseek-chat / qwen-vl-plus / gemini-2.5-flash / gpt-4o-mini"
              className="w-full px-3.5 py-2.5 rounded-xl zw-input text-sm font-mono"
            />
          </div>

          <div className="sm:col-span-2">
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
                  {currentProvider.supportsVision ? <Camera className="w-3.5 h-3.5" /> : <ImageOff className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
                  此模型支持图片 / 视觉输入（多模态）
                </div>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  {currentProvider.supportsVision
                    ? '已开启：支持电脑上传图片与手机拍照自动压缩识字。'
                    : '未开启：导入面板将禁止图片上传并明确提示不支持视觉输入。'}
                </p>
              </div>
            </label>
          </div>
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
              保存并设为默认
            </button>
          </div>
        </div>
      </div>

      {/* Unified Cross-Device Sync & Backup (Desktop SQLite <-> Android APK!) */}
      <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-4">
        <div>
          <h2 className="font-semibold text-sm">跨端数据互通与备份（电脑 ↔ 安卓 APK 通用）</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            两端采用同一套 JSON 同步格式，导入时按笔记 ID 智能增量合并，不会覆盖原有内容。
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <button
            onClick={handleExportJson}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            导出通用 JSON 备份
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
          <button
            disabled={seeding}
            onClick={async () => {
              setSeeding(true);
              try {
                await api.seedSampleData();
                alert('示例数据加载完成！');
                onSettingsChanged?.();
              } catch (e: any) {
                alert(e.message);
              } finally {
                setSeeding(false);
              }
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
          >
            <Database className="w-3.5 h-3.5" />
            {seeding ? '加载中...' : '空库加载示例数据'}
          </button>
        </div>
      </div>

      {/* Desktop LAN QR Card */}
      {!IS_STANDALONE_MODE && netInfo?.qrDataUrl && (
        <div className="rounded-2xl zw-card p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-5">
          <img src={netInfo.qrDataUrl} alt="局域网扫码" className="w-32 h-32 p-2 bg-white rounded-xl shrink-0" />
          <div className="space-y-2 text-xs text-[var(--text-secondary)]">
            <div className="font-semibold text-sm text-[var(--text-primary)] flex items-center gap-1.5">
              <Smartphone className="w-4 h-4" />
              局域网手机扫码访问
            </div>
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono text-xs border"
              style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
            >
              <Wifi className="w-3.5 h-3.5" />
              {netInfo.mobileUrl}
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">
              同 Wi-Fi 可扫码直接浏览本机版；出门在外直接使用已打包的独立安卓 APK，数据可通过上方通用 JSON 随时合并。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
