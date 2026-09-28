/**
 * Where keyboard focus should go back to once a dialog closes. Menus unmount their items before
 * the dialog they opened can record `document.activeElement`, so a menu remembers the element
 * that invoked it (its trigger, or the right-clicked row) for a moment.
 */
let invoker: { el: HTMLElement; at: number } | null = null;

export function rememberInvoker(el: HTMLElement | null | undefined) {
  invoker = el ? { el, at: performance.now() } : null;
}

/**
 * The element that invoked a menu within the last second (i.e. the menu that just closed).
 * Not cleared on read: effects can run twice (StrictMode) and must see the same answer.
 */
export function recentInvoker(): HTMLElement | null {
  return invoker && performance.now() - invoker.at < 1000 ? invoker.el : null;
}

/**
 * Focuses `el`, or when it has been removed from the page (the item was moved or deleted), the
 * current item of the closest container marked `data-focus-fallback` (e.g. the file grid).
 * Returns false when there was nowhere sensible to go.
 */
export function restoreFocus(el: HTMLElement | null, fallback: HTMLElement | null): boolean {
  if (el?.isConnected && el !== document.body) {
    el.focus();
    return true;
  }
  if (fallback?.isConnected) {
    (fallback.querySelector<HTMLElement>('[tabindex="0"]') ?? fallback).focus();
    return true;
  }
  return false;
}

export const fallbackFor = (el: HTMLElement | null) =>
  el?.closest<HTMLElement>('[data-focus-fallback]') ?? null;
