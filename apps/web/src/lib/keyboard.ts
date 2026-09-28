/**
 * iOS Safari doesn't resize the page when the on-screen keyboard opens, so bottom sheets
 * (dialogs on phones) would sit behind it. This keeps --kb set to the keyboard's height, which
 * the sheets add to their bottom offset. Android with interactive-widget=resizes-content already
 * shrinks the page, so --kb stays 0 there.
 */
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Ignore small differences (browser toolbars collapsing) and pinch-zoom.
      root.style.setProperty('--kb', kb > 80 && vv.scale <= 1.01 ? `${Math.round(kb)}px` : '0px');
    });
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
