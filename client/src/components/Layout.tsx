import React from 'react';
import {
  BookOpen,
  BrainCircuit,
  FileCheck2,
  Flame,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  Search,
  Settings,
  Smartphone,
} from 'lucide-react';
import type { PageId } from '../types';

interface LayoutProps {
  page: PageId;
  onNavigate: (page: PageId) => void;
  onOpenImport: () => void;
  onOpenSearch: () => void;
  onOpenQr: () => void;
  badges: { dueReviews: number; activeMistakes: number };
  children: React.ReactNode;
}

// Converged 5 core learning pillars — 1:1 parity across Desktop Sidebar & Android Bottom Bar
const CORE_NAV_ITEMS: {
  id: PageId;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'home', label: '学习概览与图谱', shortLabel: '首页', icon: LayoutDashboard },
  { id: 'notes', label: '笔记库与归纳', shortLabel: '笔记', icon: BookOpen },
  { id: 'practice', label: '出题与错题本', shortLabel: '刷题', icon: FileCheck2 },
  { id: 'review', label: '复习与闪卡', shortLabel: '复习', icon: Flame },
  { id: 'tutor', label: '费曼助教', shortLabel: '助教', icon: MessageSquareText },
];

export function Layout({
  page,
  onNavigate,
  onOpenImport,
  onOpenSearch,
  onOpenQr,
  badges,
  children,
}: LayoutProps) {
  const getBadge = (id: PageId) => {
    if (id === 'review' && badges.dueReviews > 0) return badges.dueReviews;
    if (id === 'practice' && badges.activeMistakes > 0) return badges.activeMistakes;
    return 0;
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#FAF9F6] text-[#1C1B18]">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 bg-white border-r border-[#EAE6DF] z-30">
        {/* Brand */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-[#F2EFEA]">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#3B5BDB] to-[#2641B3] flex items-center justify-center text-white shadow-sm">
            <BrainCircuit className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-[#141311] leading-none">知悟</h1>
            <p className="text-[11px] text-[#8A857C] mt-1">个人 AI 学习平台</p>
          </div>
        </div>

        {/* Primary Actions */}
        <div className="p-3.5 space-y-2">
          <button
            onClick={onOpenImport}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#3B5BDB] text-white font-semibold text-sm hover:bg-[#2F4AC2] transition shadow-sm cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            导入笔记
          </button>
          <button
            onClick={onOpenSearch}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-[#F5F3EE] hover:bg-[#ECE9E2] text-[#6F6B63] text-xs transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5" />
              全文检索...
            </span>
            <kbd className="px-1.5 py-0.5 bg-white rounded border border-[#E2DED6] text-[10px] font-mono">Ctrl K</kbd>
          </button>
        </div>

        {/* 5 Core Navigation Pillars */}
        <nav className="flex-1 px-3 py-1 space-y-1 overflow-y-auto">
          {CORE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const badge = getBadge(item.id);
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition cursor-pointer ${
                  active
                    ? 'bg-[#F3F5FC] text-[#3B5BDB] font-semibold'
                    : 'text-[#4A4741] hover:bg-[#F5F3EE] hover:text-[#1C1B18]'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${active ? 'text-[#3B5BDB]' : 'text-[#7A756C]'}`} />
                  {item.label}
                </span>
                {badge > 0 && (
                  <span
                    className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                      item.id === 'practice'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Compact Footer: Settings & Android QR */}
        <div className="p-3 border-t border-[#F2EFEA] grid grid-cols-2 gap-1.5">
          <button
            onClick={() => onNavigate('settings')}
            className={`flex items-center justify-center gap-1.5 py-2 px-2 rounded-xl text-xs font-medium border transition cursor-pointer ${
              page === 'settings'
                ? 'bg-[#F3F5FC] border-[#3B5BDB]/30 text-[#3B5BDB] font-semibold'
                : 'bg-[#FAF9F6] border-[#EAE6DF] text-[#4A4741] hover:bg-[#F1EFEA]'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            设置
          </button>
          <button
            onClick={onOpenQr}
            className="flex items-center justify-center gap-1.5 py-2 px-2 rounded-xl bg-[#FAF9F6] border border-[#EAE6DF] text-xs font-medium text-[#4A4741] hover:bg-[#EEF8F6] hover:text-[#0F766E] transition cursor-pointer"
          >
            <Smartphone className="w-3.5 h-3.5 text-[#0F766E]" />
            手机扫码
          </button>
        </div>
      </aside>

      {/* Mobile Top Header (Clean, zero hidden drawer needed!) */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-white/95 backdrop-blur border-b border-[#EAE6DF]">
        <button onClick={() => onNavigate('home')} className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#3B5BDB] flex items-center justify-center text-white">
            <BrainCircuit className="w-4 h-4" />
          </div>
          <span className="font-bold text-base text-[#141311]">知悟</span>
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={onOpenSearch}
            className="p-2 rounded-xl text-[#524F49] active:bg-[#F5F3EE]"
            aria-label="搜索"
          >
            <Search className="w-5 h-5" />
          </button>
          <button
            onClick={() => onNavigate('settings')}
            className={`p-2 rounded-xl active:bg-[#F5F3EE] ${
              page === 'settings' ? 'text-[#3B5BDB] bg-[#F3F5FC]' : 'text-[#524F49]'
            }`}
            aria-label="设置"
          >
            <Settings className="w-5 h-5" />
          </button>
          <button
            onClick={onOpenImport}
            className="ml-1 flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold active:scale-95 transition"
          >
            <Plus className="w-4 h-4" />
            导入
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 md:pl-60 pb-20 md:pb-8 min-h-screen">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">{children}</div>
      </main>

      {/* Mobile Bottom Tab Bar (All 5 core learning pillars directly reachable!) */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-[#EAE6DF] px-1 pt-1.5 pb-safe">
        <div className="grid grid-cols-5">
          {CORE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const badge = getBadge(item.id);
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`relative flex flex-col items-center justify-center py-1 rounded-xl transition ${
                  active ? 'text-[#3B5BDB]' : 'text-[#7A756C]'
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {badge > 0 && (
                    <span
                      className={`absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${
                        item.id === 'practice' ? 'bg-red-500' : 'bg-amber-500'
                      }`}
                    >
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className={`text-[11px] mt-0.5 ${active ? 'font-semibold' : ''}`}>{item.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
