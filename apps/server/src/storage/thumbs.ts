import path from 'node:path';
import { THUMB_SIZES, type ThumbSize } from '@familycloud/shared/all';

export function thumbPath(cacheDir: string, blobId: string, size: ThumbSize): string {
  return path.join(cacheDir, 'thumbs', blobId.slice(-2), `${blobId}-${size}.webp`);
}

export function thumbPaths(cacheDir: string, blobId: string): string[] {
  return THUMB_SIZES.map((s) => thumbPath(cacheDir, blobId, s));
}

/** Whether the worker can try to render a thumbnail for this MIME type. */
export function isThumbnailable(mime: string | null): boolean {
  if (!mime) return false;
  if (mime === 'image/svg+xml') return false; // never rasterize untrusted SVG server-side
  return mime.startsWith('image/') || mime.startsWith('video/') || mime === 'application/pdf';
}
