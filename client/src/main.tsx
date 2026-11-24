import { Capacitor } from '@capacitor/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, getSavedTheme } from './utils/theme';
import './index.css';

// MainActivity places the Android WebView below the system bars and display cutout.
if (Capacitor.getPlatform() === 'android') document.documentElement.dataset.nativeInsets = 'true';
applyTheme(getSavedTheme());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
