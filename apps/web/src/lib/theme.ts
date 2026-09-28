import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'fc-theme';
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** The page's actual colours, so the browser chrome (address bar, status bar) matches. */
function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.content = bg;
  }
}

export function setTheme(t: ThemeChoice) {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {}
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  syncThemeColor();
  for (const l of listeners) l();
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const t = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => 'system' as const,
  );
  return [t, setTheme];
}

if (typeof window !== 'undefined') {
  syncThemeColor();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
}
