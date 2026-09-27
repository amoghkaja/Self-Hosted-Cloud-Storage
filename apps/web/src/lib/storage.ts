import { useCallback, useState } from 'react';

/**
 * Per-browser UI preferences (view mode, sort). Storage can be unavailable (private mode,
 * blocked site data), so every access is guarded and the default always works.
 */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`fc:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`fc:${key}`, JSON.stringify(value));
  } catch {
    // ignore: preference simply won't persist
  }
}

export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const set = useCallback(
    (v: T) => {
      setValue(v);
      writePref(key, v);
    },
    [key],
  );
  return [value, set];
}
