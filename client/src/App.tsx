import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import { GlobalSearchModal } from './components/GlobalSearchModal';
import { Layout } from './components/Layout';
import { QuickImportModal } from './components/QuickImportModal';
import { HomePage } from './pages/HomePage';
import { NotesPage } from './pages/NotesPage';
import { PracticePage } from './pages/PracticePage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { TutorPage } from './pages/TutorPage';
import type { ActiveModelCapability, Category, PageId } from './types';
import { applyTheme, getSavedTheme, type ThemeMode } from './utils/theme';

export default function App() {
  const [page, setPage] = useState<PageId>('home');
  const [pageContext, setPageContext] = useState<any>(null);
  const [theme, setTheme] = useState<ThemeMode>(getSavedTheme);
  const [categories, setCategories] = useState<Category[]>([]);
  const [badges, setBadges] = useState({ dueReviews: 0, activeMistakes: 0 });
  const [activeCapability, setActiveCapability] = useState<ActiveModelCapability | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [importOpen, setImportOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const handleToggleTheme = (next?: ThemeMode) => {
    const resolved: ThemeMode = next || (theme === 'dark' ? 'light' : 'dark');
    setTheme(resolved);
    applyTheme(resolved);
  };

  const refreshGlobal = useCallback(async () => {
    try {
      const [cats, dash, settings] = await Promise.all([
        api.getCategories(),
        api.getDashboard(),
        api.getSettings(),
      ]);
      setCategories(cats);
      setBadges({
        dueReviews: dash.stats.totalDueReviews,
        activeMistakes: dash.stats.activeMistakes,
      });
      if (settings.activeCapability) {
        setActiveCapability(settings.activeCapability);
      }
    } catch {
      // ignore initial offline error
    }
    setRefreshTick((t) => t + 1);
  }, []);

  useEffect(() => {
    refreshGlobal();
  }, [refreshGlobal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleNavigate = (target: PageId, context?: any) => {
    setPageContext(context || null);
    setPage(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      <Layout
        page={page}
        theme={theme}
        onToggleTheme={() => handleToggleTheme()}
        onNavigate={(p) => handleNavigate(p)}
        onOpenImport={() => setImportOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
        badges={badges}
      >
        {page === 'home' && (
          <HomePage
            initialSubTab={pageContext?.subTab || 'overview'}
            refreshTick={refreshTick}
            onNavigate={handleNavigate}
            onOpenImport={() => setImportOpen(true)}
            onRefreshGlobal={refreshGlobal}
          />
        )}
        {page === 'notes' && (
          <NotesPage
            categories={categories}
            initialNoteId={pageContext?.noteId}
            onRefreshGlobal={refreshGlobal}
            onOpenImport={() => setImportOpen(true)}
            onNavigate={handleNavigate}
          />
        )}
        {page === 'practice' && (
          <PracticePage
            categories={categories}
            activeMistakesCount={badges.activeMistakes}
            initialContext={pageContext}
            onRefreshGlobal={refreshGlobal}
            onNavigate={handleNavigate}
          />
        )}
        {page === 'review' && <ReviewPage onRefreshGlobal={refreshGlobal} />}
        {page === 'tutor' && <TutorPage initialContext={pageContext} onRefreshGlobal={refreshGlobal} />}
        {page === 'settings' && (
          <SettingsPage
            theme={theme}
            onSelectTheme={(m) => handleToggleTheme(m)}
            onSettingsChanged={refreshGlobal}
          />
        )}
      </Layout>

      <QuickImportModal
        open={importOpen}
        categories={categories}
        activeCapability={activeCapability}
        onClose={() => setImportOpen(false)}
        onOpenSettings={() => handleNavigate('settings')}
        onImported={(notes) => {
          refreshGlobal();
          if (notes.length > 0) {
            handleNavigate('notes', { noteId: notes[0].id });
          }
        }}
      />

      <GlobalSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelectNote={(noteId) => handleNavigate('notes', { noteId })}
      />
    </>
  );
}
