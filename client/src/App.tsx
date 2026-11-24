import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { categoryPaths } from '../../server/src/shared/categoryPaths';
import { api } from './api/client';
import { servePhoneMcp } from './api/phoneMcpBridge';
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

function routeFromLocation(): { page: PageId; context: any } {
  const params = new URLSearchParams(window.location.search);
  const noteId = params.get('note');
  if (noteId) return {
    page: 'notes',
    context: {
      noteId,
      citation: ['part', 'at', 'sig', 'page'].some((key) => params.has(key)) ? params : undefined,
      fromTutor: Boolean(window.history.state?.fromTutor),
    },
  };
  const sessionId = params.get('chat');
  if (params.has('chat')) return { page: 'tutor', context: sessionId ? { sessionId, scrollTop: window.history.state?.chatScrollTop } : null };
  return { page: 'home', context: null };
}

export default function App() {
  const [{ page, context: pageContext }, setRoute] = useState(routeFromLocation);
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
  const [externalNoteRevision, setExternalNoteRevision] = useState(0);

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

  useEffect(() => servePhoneMcp(() => {
    setExternalNoteRevision(value => value + 1);
    void refreshGlobal();
  }), [refreshGlobal]);

  useEffect(() => {
    const restoreRoute = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', restoreRoute);
    return () => window.removeEventListener('popstate', restoreRoute);
  }, []);

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
    if (target === 'tutor' && page === 'tutor' && !context) return;
    const query = new URLSearchParams(window.location.search);
    if (query.has('note') || query.has('chat')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    setRoute({ page: target, context: context || null });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const rememberTutorSession = (id: string | null) => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('chat') === (id ?? '')) return;
    window.history.replaceState(null, '', '?' + new URLSearchParams({ chat: id ?? '' }));
  };

  const openTutorCitation = (href: string, sessionId: string, chatScrollTop: number) => {
    const chat = new URLSearchParams({ chat: sessionId });
    window.history.replaceState({ chatScrollTop }, '', `?${chat}`);
    window.history.pushState({ fromTutor: true }, '', href);
    setRoute(routeFromLocation());
    window.scrollTo(0, 0);
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
            key={pageContext?.citation?.toString() ?? pageContext?.noteId}
            categoryLabels={categoryLabels}
            externalNoteRevision={externalNoteRevision}
            initialNoteId={pageContext?.noteId}
            citation={pageContext?.citation}
            onReturnToTutor={pageContext?.fromTutor ? () => window.history.back() : undefined}
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
        <TutorPage visible={page === 'tutor'} initialContext={page === 'tutor' ? pageContext : null}
          onRefreshGlobal={refreshGlobal} onOpenCitation={openTutorCitation} onSessionChange={rememberTutorSession} />
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
