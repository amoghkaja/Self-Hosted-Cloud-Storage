import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { Toast as T } from 'radix-ui';
import { useSyncExternalStore } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}

// A tiny external store: toasts can be raised from anywhere (mutations, the upload manager)
// without prop drilling or context.
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function push(
  tone: Tone,
  message: string,
  opts: { action?: ToastItem['action']; duration?: number } = {},
) {
  const item: ToastItem = {
    id: nextId++,
    tone,
    message,
    action: opts.action,
    duration: opts.duration ?? (tone === 'error' ? 8000 : opts.action ? 7000 : 4000),
  };
  items = [...items.slice(-4), item];
  emit();
  return item.id;
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string, opts?: { action?: ToastItem['action']; duration?: number }) =>
    push('success', message, opts),
  error: (message: string, opts?: { action?: ToastItem['action']; duration?: number }) =>
    push('error', message, opts),
  info: (message: string, opts?: { action?: ToastItem['action']; duration?: number }) =>
    push('info', message, opts),
  dismiss,
};

const icons = {
  success: <CircleCheck size={18} className="text-success" aria-hidden />,
  error: <CircleAlert size={18} className="text-danger" aria-hidden />,
  info: <Info size={18} className="text-accent" aria-hidden />,
};

/** Mount once near the root. Errors are announced assertively, others politely. */
export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
  return (
    <T.Provider swipeDirection="right">
      {list.map((t) => (
        <T.Root
          key={t.id}
          duration={t.duration}
          type={t.tone === 'error' ? 'foreground' : 'background'}
          onOpenChange={(open) => !open && dismiss(t.id)}
          className={cn(
            'flex w-full items-start gap-3 rounded-xl border border-border bg-surface p-3 pr-2 shadow-pop animate-pop-in',
            'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:animate-fade-in',
          )}
        >
          <span className="mt-0.5">{icons[t.tone]}</span>
          <T.Description className="flex-1 text-sm">{t.message}</T.Description>
          {t.action && (
            <T.Action altText={t.action.label} asChild>
              <button
                type="button"
                onClick={t.action.onClick}
                className="rounded-md px-2 py-1 text-sm font-medium text-accent hover:bg-accent-soft"
              >
                {t.action.label}
              </button>
            </T.Action>
          )}
          <T.Close aria-label="Dismiss" className="rounded-md p-1 text-muted hover:bg-surface-2">
            <X size={16} aria-hidden />
          </T.Close>
        </T.Root>
      ))}
      {/* Top on phones (the upload panel owns the bottom), bottom-centre on larger screens. */}
      <T.Viewport className="fixed top-14 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 p-3 sm:top-auto sm:bottom-0" />
    </T.Provider>
  );
}
