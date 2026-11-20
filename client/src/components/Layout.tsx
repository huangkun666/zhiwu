import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  FileCheck2,
  Flame,
  LayoutDashboard,
  MessageSquareText,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
} from 'lucide-react';
import type { PageId } from '../types';
import type { ThemeMode } from '../utils/theme';

interface LayoutProps {
  page: PageId;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onNavigate: (page: PageId) => void;
  onOpenImport: () => void;
  onOpenSearch: () => void;
  badges: { dueReviews: number; activeMistakes: number };
  children: React.ReactNode;
}

const CORE_NAV_ITEMS: {
  id: PageId;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'home', label: '概览与图谱', shortLabel: '首页', icon: LayoutDashboard },
  { id: 'notes', label: '笔记库', shortLabel: '笔记', icon: BookOpen },
  { id: 'practice', label: '出题与错题', shortLabel: '刷题', icon: FileCheck2 },
  { id: 'review', label: '复习与闪卡', shortLabel: '复习', icon: Flame },
  { id: 'tutor', label: '费曼助教', shortLabel: '助教', icon: MessageSquareText },
];

export function Layout({
  page,
  theme,
  onToggleTheme,
  onNavigate,
  onOpenImport,
  onOpenSearch,
  badges,
  children,
}: LayoutProps) {
  // Automatically hide mobile bottom tab bar when soft keyboard is open (native app feel)
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const checkViewport = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      // When keyboard pops up on mobile, visualViewport height shrinks noticeably
      const activeTag = document.activeElement?.tagName;
      const isTextFocused = activeTag === 'INPUT' || activeTag === 'TEXTAREA';
      setKeyboardOpen(isTextFocused && vv.height < window.screen.height * 0.72);
    };
    const onFocusIn = (e: FocusEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        setTimeout(checkViewport, 120);
      }
    };
    const onFocusOut = () => setTimeout(() => setKeyboardOpen(false), 120);

    window.visualViewport?.addEventListener('resize', checkViewport);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      window.visualViewport?.removeEventListener('resize', checkViewport);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const getBadge = (id: PageId) => {
    if (id === 'review' && badges.dueReviews > 0) return badges.dueReviews;
    if (id === 'practice' && badges.activeMistakes > 0) return badges.activeMistakes;
    return 0;
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row text-[var(--text-primary)]">
      {/* Desktop Frosted Minimal Sidebar */}
      <aside
        className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 z-30 border-r"
        style={{
          background: 'var(--bg-sidebar)',
          backdropFilter: 'blur(24px) saturate(150%)',
          WebkitBackdropFilter: 'blur(24px) saturate(150%)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        {/* Brand Row */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <button onClick={() => onNavigate('home')} className="flex items-center gap-2.5 cursor-pointer">
            <div className="w-7 h-7 rounded-lg zw-btn-primary flex items-center justify-center text-xs font-bold tracking-tight">
              知
            </div>
            <div className="text-left">
              <div className="text-[15px] font-semibold tracking-tight leading-none">知悟</div>
              <div className="text-[10px] text-[var(--text-muted)] mt-1">Knowledge Workspace</div>
            </div>
          </button>
          <button
            onClick={onToggleTheme}
            title={theme === 'dark' ? '切换为浅灰磨砂' : '切换为曜石暗夜'}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>

        {/* Primary Actions */}
        <div className="px-3.5 pb-3 space-y-2">
          <button
            onClick={onOpenImport}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl zw-btn-primary font-semibold text-xs tracking-wide cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            导入笔记
          </button>
          <button
            onClick={onOpenSearch}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl zw-btn-secondary text-[var(--text-muted)] text-xs cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5" />
              检索...
            </span>
            <kbd
              className="px-1.5 py-0.5 rounded text-[10px] font-mono border"
              style={{ borderColor: 'var(--border-hairline)', background: 'var(--bg-card-solid)' }}
            >
              Ctrl K
            </kbd>
          </button>
        </div>

        {/* 5 Core Navigation Pillars */}
        <nav className="flex-1 px-3 py-1 space-y-0.5 overflow-y-auto">
          {CORE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const badge = getBadge(item.id);
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-[13px] transition cursor-pointer"
                style={{
                  background: active ? 'var(--bg-active)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 500,
                }}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`w-4 h-4 ${
                      active ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                    }`}
                  />
                  {item.label}
                </span>
                {badge > 0 && (
                  <span
                    className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-md"
                    style={{
                      background: item.id === 'practice' ? 'var(--danger-bg)' : 'var(--bg-subtle)',
                      color: item.id === 'practice' ? 'var(--danger-fg)' : 'var(--text-secondary)',
                    }}
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Quiet Footer: Settings only */}
        <div
          className="p-3 border-t"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <button
            onClick={() => onNavigate('settings')}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-medium transition cursor-pointer"
            style={{
              background: page === 'settings' ? 'var(--bg-active)' : 'var(--bg-subtle)',
              color: page === 'settings' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Settings className="w-3.5 h-3.5" />
            设置
          </button>
        </div>
      </aside>

      {/* Mobile Top Glass Header */}
      <header
        className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] zw-glass border-b"
      >
        <button onClick={() => onNavigate('home')} className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg zw-btn-primary flex items-center justify-center text-xs font-bold">
            知
          </div>
          <span className="font-semibold text-[15px] tracking-tight">知悟</span>
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleTheme}
            className="p-2 rounded-xl text-[var(--text-secondary)] active:bg-[var(--bg-hover)]"
            aria-label="切换深浅主题"
          >
            {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
          </button>
          <button
            onClick={onOpenSearch}
            className="p-2 rounded-xl text-[var(--text-secondary)] active:bg-[var(--bg-hover)]"
            aria-label="搜索"
          >
            <Search className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={() => onNavigate('settings')}
            className="p-2 rounded-xl active:bg-[var(--bg-hover)]"
            style={{
              background: page === 'settings' ? 'var(--bg-active)' : 'transparent',
              color: page === 'settings' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
            aria-label="设置"
          >
            <Settings className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={onOpenImport}
            className="ml-1 flex items-center gap-1 px-3 py-1.5 rounded-xl zw-btn-primary text-xs font-semibold active:scale-95 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            导入
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className={`flex-1 md:pl-60 ${keyboardOpen ? 'pb-4' : 'pb-22'} md:pb-10 min-h-screen`}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7">{children}</div>
      </main>

      {/* Mobile Frosted Bottom Tab Bar (auto-hides while typing on soft keyboard) */}
      {!keyboardOpen && (
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 zw-glass border-t px-1 pt-1.5 pb-safe">
        <div className="grid grid-cols-5">
          {CORE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const badge = getBadge(item.id);
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className="relative flex flex-col items-center justify-center py-1 rounded-xl transition"
                style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
              >
                <div className="relative">
                  <Icon className="w-[19px] h-[19px]" />
                  {badge > 0 && (
                    <span
                      className="absolute -top-1.5 -right-2.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center"
                      style={{
                        background: 'var(--btn-primary-bg)',
                        color: 'var(--btn-primary-fg)',
                      }}
                    >
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className={`text-[10.5px] mt-0.5 ${active ? 'font-semibold' : ''}`}>{item.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>
      )}
    </div>
  );
}
