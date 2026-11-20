export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'zhiwu_theme_mode';

export function getSavedTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore
  }
  return 'dark'; // Default to Linear Obsidian Dark
}

export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', mode);
  // Force synchronous reflow so all CSS vars snap atomically with zero mid-fade contrast flash
  void window.getComputedStyle(root).color;
  requestAnimationFrame(() => {
    root.classList.remove('theme-switching');
  });

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', mode === 'dark' ? '#09090B' : '#ECEEF2');
  }
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}
