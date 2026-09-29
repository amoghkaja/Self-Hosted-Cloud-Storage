import path from 'node:path';
import { isOfficeDocument, THUMB_SIZES, type ThumbSize } from '@familycloud/shared/all';

export function thumbPath(cacheDir: string, blobId: string, size: ThumbSize): string {
  return path.join(cacheDir, 'thumbs', blobId.slice(-2), `${blobId}-${size}.webp`);
}

/** The 720p streaming copy of a video (derived data, like thumbnails: not counted in quotas). */
export function streamPath(cacheDir: string, blobId: string): string {
  return path.join(cacheDir, 'stream', blobId.slice(-2), `${blobId}-720.mp4`);
}

export function thumbPaths(cacheDir: string, blobId: string): string[] {
  return THUMB_SIZES.map((s) => thumbPath(cacheDir, blobId, s));
}

/** The PDF rendering of an Office document. */
/** Office previews: a PDF of every document, plus HTML of spreadsheets (read as a real sheet). */
export type PreviewFormat = 'pdf' | 'html';
export function previewPath(cacheDir: string, blobId: string, format: PreviewFormat = 'pdf') {
  return path.join(cacheDir, 'preview', blobId.slice(-2), `${blobId}.${format}`);
}

/** Everything derived from a blob (thumbnails, streaming copy, preview), to delete along with it. */
export function derivedPaths(cacheDir: string, blobId: string): string[] {
  return [
    ...thumbPaths(cacheDir, blobId),
    streamPath(cacheDir, blobId),
    previewPath(cacheDir, blobId, 'pdf'),
    previewPath(cacheDir, blobId, 'html'),
  ];
}

export const isVideo = (mime: string | null) => !!mime?.startsWith('video/');

/** Whether the worker can try to render a thumbnail for this MIME type. */
export function isThumbnailable(mime: string | null): boolean {
  if (!mime) return false;
  if (mime === 'image/svg+xml') return false; // never rasterize untrusted SVG server-side
  // Office documents: from the first page of their PDF preview (see the office job).
  return (
    mime.startsWith('image/') ||
    mime.startsWith('video/') ||
    mime === 'application/pdf' ||
    isOfficeDocument(mime)
  );
}
