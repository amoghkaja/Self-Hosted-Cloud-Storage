import { useSyncExternalStore } from 'react';

// A single polite live region for status messages that have no visible toast
// ("3 items selected", "Upload complete"). Screen readers read it without moving focus.
let message = '';
const listeners = new Set<() => void>();

export function announce(text: string) {
  // Clearing first makes repeated identical messages be read again.
  message = '';
  for (const l of listeners) l();
  setTimeout(() => {
    message = text;
    for (const l of listeners) l();
  }, 50);
}

export function Announcer() {
  const text = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => message,
  );
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}
