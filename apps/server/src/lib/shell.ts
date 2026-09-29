import { API_PREFIX } from '@familycloud/shared/all';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Fills the SPA's index.html with the family's branding before it's sent, so the browser tab,
 * "Add to Home Screen" and link previews (WhatsApp, iMessage) show the right name and icon
 * without waiting for JavaScript, which previewers never run. Share-link previews stay generic:
 * the file's name is never put in the page.
 */
export function renderShell(
  html: string,
  opts: { appName: string; publicUrl: string; logoVersion: string | null; sharePage: boolean },
): string {
  const name = escapeHtml(opts.appName);
  const v = opts.logoVersion ? encodeURIComponent(opts.logoVersion) : null;
  const icon = (size: string, fallback: string) =>
    v ? `${API_PREFIX}/brand/icon/${size}?v=${v}` : fallback;
  const title = opts.sharePage ? `Shared with you · ${name}` : name;
  const description = opts.sharePage
    ? `Open the link to see what was shared from ${name}.`
    : `${name}: our family's private cloud.`;
  const image = `${opts.publicUrl}${icon('512', '/icon-512.png')}`;
  const head = [
    `<link rel="icon" href="${icon('192', '/favicon.svg')}"${v ? ' type="image/png"' : ' type="image/svg+xml"'} />`,
    `<link rel="apple-touch-icon" href="${icon('180', '/apple-touch-icon.png')}" />`,
    `<meta name="description" content="${description}" />`,
    `<meta name="apple-mobile-web-app-title" content="${name}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${name}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<title>${title}</title>`,
  ].join('\n    ');
  return html
    .replace(/\s*<link rel="icon"[^>]*>/, '')
    .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '')
    .replace(/<title>[^<]*<\/title>/, head)
    .replace(
      /<noscript>[^<]*<\/noscript>/,
      `<noscript>${name} needs JavaScript to run.</noscript>`,
    );
}
