/**
 * Copies text to the clipboard. `navigator.clipboard` only exists in secure contexts, and a
 * home server is often opened over plain HTTP on the LAN (http://192.168.x.x), so fall back to
 * the legacy copy command there. Resolves to whether the copy worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or not focused: try the fallback.
  }
  const previous = document.activeElement as HTMLElement | null;
  // Stay inside an open dialog so its focus trap doesn't pull focus (and the selection) back.
  const host = previous?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  host.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.({ preventScroll: true });
  }
}
