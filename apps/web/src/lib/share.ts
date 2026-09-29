/**
 * The phone's own share sheet (WhatsApp, iMessage, Mail…). Only offered on touch devices: desktop
 * browsers that have it show a small, unfamiliar dialog where copying the link is simpler.
 */
export function canShareNatively(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches
  );
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unavailable';

/** Opens the share sheet. 'unavailable' when the browser refused (e.g. not right after a tap). */
export async function shareNatively(data: { title: string; url: string }): Promise<ShareOutcome> {
  try {
    await navigator.share({ title: data.title, text: data.title, url: data.url });
    return 'shared';
  } catch (err) {
    return (err as DOMException)?.name === 'AbortError' ? 'cancelled' : 'unavailable';
  }
}
