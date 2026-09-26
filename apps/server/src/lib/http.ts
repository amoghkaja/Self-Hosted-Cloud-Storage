/** RFC 6266 / RFC 5987 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop accents: "Résumé" -> "Resume"
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range: bytes=...` header.
 * Returns null when absent or not satisfiable-as-single (caller sends the full body),
 * or 'unsatisfiable' for syntactically valid ranges outside the resource.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or malformed: ignore and serve the whole file (RFC 9110 allows this)
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start: number;
  let end: number;
  if (s === '') {
    const suffix = Number(e);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * MIME types safe to render inline in the browser. Everything else (HTML, SVG, XML, JS, unknown)
 * is forced to download, because rendering it on our origin would be stored XSS.
 */
const INLINE_SAFE = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
]);

export function isInlineSafe(mime: string | null | undefined): boolean {
  return !!mime && INLINE_SAFE.has(mime.toLowerCase());
}

/** Content-Type to send: text is pinned to UTF-8 plain text so it can never be sniffed into HTML. */
export function servedContentType(mime: string | null | undefined, inline: boolean): string {
  if (!inline) return 'application/octet-stream';
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('text/')) return 'text/plain; charset=utf-8';
  return m;
}
