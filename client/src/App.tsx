import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { categoryPaths } from '../../server/src/shared/categoryPaths';
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
  const [linkedNoteId] = useState(() => new URLSearchParams(window.location.search).get('note'));
  const [page, setPage] = useState<PageId>(linkedNoteId ? 'notes' : 'home');
  const [pageContext, setPageContext] = useState<any>(linkedNoteId ? { noteId: linkedNoteId } : null);
  const [theme, setTheme] = useState<ThemeMode>(getSavedTheme);
  const [categories, setCategories] = useState<Category[]>([]);
  const categoryRequest = useRef(0);
  const categoryLabels = useMemo(() => {
    const paths = categoryPaths(categories);
    return new Map(categories.map(({ id, name }) => [id, paths.get(id)?.join(' / ') ?? name]));
  }, [categories]);
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

  const refreshCategories = useCallback(async () => {
    const request = ++categoryRequest.current;
    try {
      const next = await api.getCategories();
      if (request === categoryRequest.current) setCategories(next);
    } catch {
      // Keep the last category list when the connection is unavailable.
    }
  }, []);

  const refreshGlobal = useCallback(async () => {
    try {
      const [dash, settings] = await Promise.all([
        api.getDashboard(),
        api.getSettings(),
        refreshCategories(),
      ]);
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
  }, [refreshCategories]);

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

  const handleOpenImport = () => {
    setImportOpen(true);
    void refreshCategories();
  };

  return (
    <>
      <Layout
        page={page}
        theme={theme}
        onToggleTheme={() => handleToggleTheme()}
        onNavigate={(p) => handleNavigate(p)}
        onOpenImport={handleOpenImport}
        onOpenSearch={() => setSearchOpen(true)}
        badges={badges}
      >
        {page === 'home' && (
          <HomePage
            initialSubTab={pageContext?.subTab || 'overview'}
            refreshTick={refreshTick}
            masteryChanges={pageContext?.masteryChanges}
            onNavigate={handleNavigate}
            onOpenImport={handleOpenImport}
            onRefreshGlobal={refreshGlobal}
          />
        )}
        {page === 'notes' && (
          <NotesPage
            categoryLabels={categoryLabels}
            initialNoteId={pageContext?.noteId}
            onRefreshGlobal={refreshGlobal}
            onOpenImport={handleOpenImport}
            onNavigate={handleNavigate}
          />
        )}
        {page === 'practice' && (
          <PracticePage
            categories={categories}
            categoryLabels={categoryLabels}
            activeMistakesCount={badges.activeMistakes}
            initialContext={pageContext}
            onRefreshGlobal={refreshGlobal}
            onNavigate={handleNavigate}
          />
        )}
        {page === 'review' && (
          <ReviewPage onRefreshGlobal={refreshGlobal}
            onReturnHome={(masteryChanges) => handleNavigate('home', { masteryChanges })} />
        )}
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
        categoryLabels={categoryLabels}
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
