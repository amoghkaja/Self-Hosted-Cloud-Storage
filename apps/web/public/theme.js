// Applies the saved light/dark choice before the app renders, so there's no flash of the other
// theme. "system" (or nothing saved) follows the device. Kept tiny and outside the bundle.
try {
  const t = localStorage.getItem('fc-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
