import { useEffect, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Cpu,
  Download,
  Eye,
  EyeOff,
  ImageOff,
  Loader2,
  Plus,
  Save,
  Smartphone,
  Wifi,
  Zap,
} from 'lucide-react';
import { api, IS_STANDALONE_MODE } from '../api/client';
import type { AIProviderConfig, AISettings } from '../types';

interface SettingsPageProps {
  onSettingsChanged?: () => void;
}

const VISION_MODEL_HINT = /gemini|gpt-4o|gpt-4\.1|vl|vision|llava|omni|claude-3|claude-sonnet-4|pixtral|qvq/i;

export function SettingsPage({ onSettingsChanged }: SettingsPageProps) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [selectedId, setSelectedId] = useState<string>('deepseek');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedToast, setSavedToast] = useState(false);

  const [netInfo, setNetInfo] = useState<{ mobileUrl: string; qrDataUrl: string; ips: string[] } | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setSelectedId(s.activeProviderId || s.providers[0]?.id || 'deepseek');
    });
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    api
      .getNetworkInfo(port)
      .then(setNetInfo)
      .catch(() => {});
  }, []);

  if (!settings) {
    return <div className="p-12 text-center text-sm text-[#8A857C]">加载配置中...</div>;
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
          // Auto-suggest vision flag when typing a well-known vision/multimodal model name
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

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#141311]">模型配置与系统设置</h1>
        <p className="text-xs text-[#7A756C] mt-0.5">
          全站统一使用你选定的单个模型，所有配置与 API Key 仅存储在本地 SQLite 数据库中。
        </p>
      </div>

      {/* Unified Single-Model AI Config */}
      <div className="rounded-2xl bg-white border border-[#EAE6DF] p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-[#3B5BDB]" />
            <h2 className="font-bold text-base text-[#141311]">AI 模型配置（单一模型）</h2>
          </div>
          <button
            onClick={addCustomProvider}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#F5F3EE] hover:bg-[#ECE9E2] text-xs font-semibold text-[#3D3A35] cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> 添加自定义接口
          </button>
        </div>

        {/* Provider Pills */}
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
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition flex items-center gap-1.5 cursor-pointer ${
                  isSelected
                    ? 'bg-[#3B5BDB] border-[#3B5BDB] text-white shadow-sm'
                    : 'bg-[#FAF9F6] border-[#E5E2DC] text-[#4A4741] hover:border-[#CFCAC0]'
                }`}
              >
                {p.name}
                {isActive && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      isSelected ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    当前使用
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Selected Provider Form */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div>
            <label className="block text-xs font-medium text-[#524F49] mb-1">配置名称</label>
            <input
              value={currentProvider.name}
              onChange={(e) => updateProviderField('name', e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm focus:outline-none focus:border-[#3B5BDB]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#524F49] mb-1">接口协议类型</label>
            <select
              value={currentProvider.type}
              onChange={(e) => updateProviderField('type', e.target.value as 'openai' | 'gemini')}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm"
            >
              <option value="openai">OpenAI 兼容协议 (DeepSeek / 通义 / Ollama / OpenRouter)</option>
              <option value="gemini">Google Gemini 原生协议</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-[#524F49] mb-1">API Base URL</label>
            <input
              value={currentProvider.baseUrl}
              onChange={(e) => updateProviderField('baseUrl', e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm font-mono focus:outline-none focus:border-[#3B5BDB]"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-[#524F49] mb-1">
              API Key{' '}
              {currentProvider.requiresKey === false && (
                <span className="text-[#8A857C]">（本地 Ollama 无需真实 Key）</span>
              )}
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={currentProvider.apiKey}
                onChange={(e) => updateProviderField('apiKey', e.target.value)}
                placeholder="sk-..."
                className="w-full pl-3.5 pr-10 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm font-mono focus:outline-none focus:border-[#3B5BDB]"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8A857C]"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Unified Single Model Name */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-[#524F49] mb-1">模型名称（统一用于总结、出题、助教及图片识别）</label>
            <input
              value={currentProvider.model}
              onChange={(e) => updateProviderField('model', e.target.value)}
              placeholder="如 deepseek-chat / qwen-vl-plus / gemini-2.5-flash / gpt-4o-mini"
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm font-mono focus:outline-none focus:border-[#3B5BDB]"
            />
          </div>

          {/* Explicit Vision Capability Toggle */}
          <div className="sm:col-span-2">
            <label
              className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
                currentProvider.supportsVision
                  ? 'bg-[#EEF8F6] border-[#0F766E]/25'
                  : 'bg-[#FAF9F6] border-[#E5E2DC]'
              }`}
            >
              <input
                type="checkbox"
                checked={Boolean(currentProvider.supportsVision)}
                onChange={(e) => updateProviderField('supportsVision', e.target.checked)}
                className="w-4 h-4 mt-0.5 accent-[#0F766E] rounded"
              />
              <div className="flex-1">
                <div className="text-sm font-semibold text-[#141311] flex items-center gap-1.5">
                  {currentProvider.supportsVision ? (
                    <Camera className="w-4 h-4 text-[#0F766E]" />
                  ) : (
                    <ImageOff className="w-4 h-4 text-[#8A857C]" />
                  )}
                  此模型支持图片 / 视觉输入（多模态）
                </div>
                <p className="text-xs text-[#6F6B63] mt-0.5">
                  {currentProvider.supportsVision
                    ? '已开启：允许在电脑上传图片或安卓手机直接拍照导入笔记并自动识别。'
                    : '未开启：导入面板将禁用图片上传并明确告知不支持视觉输入（如 DeepSeek 文本模型请保持关闭）。'}
                </p>
              </div>
            </label>
          </div>
        </div>

        {testResult && (
          <div
            className={`p-3 rounded-xl text-xs font-medium ${
              testResult.ok
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}
          >
            {testResult.text}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#F2EFEA]">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#F5F3EE] hover:bg-[#ECE9E2] text-xs font-semibold text-[#1C1B18] cursor-pointer disabled:opacity-60"
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4 text-amber-500" />}
            测试当前模型连接
          </button>

          <div className="flex items-center gap-2">
            {savedToast && (
              <span className="text-xs text-emerald-700 font-semibold flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> 已保存
              </span>
            )}
            <button
              onClick={() => handleSave(false)}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-[#DDD8CE] bg-white text-xs font-semibold text-[#1C1B18] hover:bg-[#FAF9F6] cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              仅保存
            </button>
            <button
              onClick={() => handleSave(true)}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold hover:bg-[#2F4AC2] cursor-pointer"
            >
              保存并设为当前默认模型
            </button>
          </div>
        </div>
      </div>

      {/* Android Mobile Access & PWA Card (only in Desktop/Server mode) */}
      {!IS_STANDALONE_MODE && (
        <div className="rounded-2xl bg-white border border-[#EAE6DF] p-5 sm:p-6">
          <div className="flex items-center gap-2 mb-4">
            <Smartphone className="w-5 h-5 text-[#0F766E]" />
            <h2 className="font-bold text-base text-[#141311]">安卓手机端直连与桌面 App 安装</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-5 items-center">
            <div className="sm:col-span-4 flex flex-col items-center">
              {netInfo?.qrDataUrl ? (
                <img
                  src={netInfo.qrDataUrl}
                  alt="安卓端扫码访问"
                  className="w-40 h-40 p-2 bg-white rounded-2xl border border-[#EAE6DF]"
                />
              ) : (
                <div className="w-40 h-40 rounded-2xl bg-[#F5F3EE] flex items-center justify-center text-xs text-[#8A857C]">
                  获取中...
                </div>
              )}
            </div>
            <div className="sm:col-span-8 space-y-3 text-xs text-[#4A4741] leading-relaxed">
              {netInfo?.mobileUrl && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#FAF9F6] border border-[#E5E2DC]">
                  <Wifi className="w-4 h-4 text-[#0F766E] shrink-0" />
                  <span className="font-mono font-semibold text-[#141311] truncate">{netInfo.mobileUrl}</span>
                </div>
              )}
              <p>
                <strong>局域网即扫即用：</strong>手机与电脑连在同一 Wi-Fi 下，用安卓 Chrome / Edge 扫码打开，点击右上角「<strong>安装应用 / 添加到主屏幕</strong>」即可使用。
              </p>
              <p className="text-[#6F6B63]">
                <strong>独立安卓 APK 模式：</strong>本项目已内置独立手机端引擎与 Capacitor 安卓工程，打包 APK 后无需电脑开机、随时随地独立运行！
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Data Backup */}
      <div className="rounded-2xl bg-white border border-[#EAE6DF] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="font-bold text-sm text-[#141311]">
            {IS_STANDALONE_MODE ? '手机本地数据备份与恢复' : '本地数据库一键备份'}
          </h3>
          <p className="text-xs text-[#7A756C] mt-0.5">
            {IS_STANDALONE_MODE
              ? '所有笔记、闪卡、错题和图谱均独立存储在手机本地，无需连接电脑。可随时导出 JSON 备份。'
              : '你的所有笔记、闪卡、错题、图谱和复习进度都完整保存在本地 data/zhiwu.db 文件中。'}
          </p>
        </div>
        {IS_STANDALONE_MODE ? (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={async () => {
                const json = await api.exportJsonBackup();
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `zhiwu-backup-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-[#1C1B18] text-white text-xs font-semibold cursor-pointer"
            >
              <Download className="w-4 h-4" />
              导出备份
            </button>
            <label className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-[#DDD8CE] bg-white text-xs font-semibold text-[#1C1B18] cursor-pointer">
              导入恢复
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    const text = await f.text();
                    const res = await api.importJsonBackup(text);
                    alert(`恢复成功！共导入 ${res.notesCount} 篇笔记。`);
                    onSettingsChanged?.();
                  } catch (err: any) {
                    alert(err.message || '恢复失败');
                  }
                }}
              />
            </label>
          </div>
        ) : (
          <a
            href="/api/settings/backup"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#1C1B18] text-white text-xs font-semibold hover:bg-[#33312B] shrink-0"
          >
            <Download className="w-4 h-4" />
            导出 SQLite 备份
          </a>
        )}
      </div>
    </div>
  );
}
