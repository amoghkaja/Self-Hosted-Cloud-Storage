import { X } from 'lucide-react';
import { AlertDialog, Dialog as D } from 'radix-ui';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { fallbackFor, recentInvoker, restoreFocus } from './focusReturn';

/**
 * Radix only restores focus to its own Trigger. Our dialogs are opened from menus, shortcuts
 * and buttons elsewhere, so remember whatever had focus at open time and return to it on close
 * (otherwise keyboard and screen-reader users are dumped at the top of the page). A menu has
 * already unmounted its items when the dialog opens, so we fall back to the menu's invoker; and
 * if the opener is gone by the time we close (the item was moved or deleted), to its list.
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<{ el: HTMLElement | null; fallback: HTMLElement | null }>({
    el: null,
    fallback: null,
  });
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement as HTMLElement | null;
    // Opened from a menu item (still focused, or already removed): return to the menu's invoker.
    const fromMenu = !active || active === document.body || !!active.closest('[role="menu"]');
    const el = (fromMenu ? recentInvoker() : null) ?? active;
    opener.current = { el, fallback: fallbackFor(el) };
  }, [open]);
  return (e: Event) => {
    const { el, fallback } = opener.current;
    if (restoreFocus(el, fallback)) e.preventDefault();
  };
}

const overlay = 'fixed inset-0 z-40 bg-overlay animate-fade-in';
const panel =
  'fixed z-50 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-pop animate-pop-in ' +
  // Bottom sheet on phones, centered card from sm up.
  'inset-x-2 bottom-2 sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2';

const widths = { sm: 'sm:w-[400px]', md: 'sm:w-[520px]', lg: 'sm:w-[720px]' } as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row, right-aligned. */
  footer?: ReactNode;
  size?: keyof typeof widths;
  /** Hide the title visually (still used as the accessible name). */
  hideTitle?: boolean;
}

/**
 * Modal dialog: focus is trapped inside and restored on close, Escape closes, background is
 * inert to assistive tech (all via Radix).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  hideTitle,
}: DialogProps) {
  const onCloseAutoFocus = useReturnFocus(open);
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content
          className={cn(panel, widths[size])}
          onCloseAutoFocus={onCloseAutoFocus}
          // No description: opt out explicitly instead of repeating the title to screen readers.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-2">
            <div className="min-w-0">
              <D.Title className={cn('text-lg font-semibold', hideTitle && 'sr-only')}>
                {title}
              </D.Title>
              {description && (
                <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
              )}
            </div>
            <D.Close
              aria-label="Close"
              className="-mt-1 -mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
            >
              <X size={18} aria-hidden />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3">
              {footer}
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** May return a promise; the dialog shows progress and stays open until it settles. */
  onConfirm: () => unknown | Promise<unknown>;
}

/** Interrupting confirmation (role="alertdialog"): focus starts on Cancel for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const onCloseAutoFocus = useReturnFocus(open);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // The caller surfaces the error (toast); keep the dialog open so they can retry.
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={overlay} />
        <AlertDialog.Content
          className={cn(panel, widths.sm, 'p-5')}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={busy}>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
