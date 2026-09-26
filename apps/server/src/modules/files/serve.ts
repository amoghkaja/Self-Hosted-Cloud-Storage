import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { ErrorCode, type ThumbSize } from '@familycloud/shared';
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import yazl from 'yazl';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { contentDisposition, isInlineSafe, parseRange, servedContentType } from '../../lib/http';
import { thumbPath } from '../../storage/thumbs';

/** Locks rendered user content into an opaque, script-less sandbox even if a browser sniffs it. */
const SANDBOX_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
// Chrome/Firefox PDF viewers break under `sandbox`; PDFs are not HTML-XSS vectors in them.
const PDF_CSP = "frame-ancestors 'self'";

export interface BlobRef {
  blobId: string;
  volumeId: string;
  size: number;
  name: string;
  mimeType: string | null;
}

/**
 * Streams a stored file with Range (seeking), ETag/304 and download-safe headers.
 * Memory use is constant regardless of file size.
 */
export async function sendBlob(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  blob: BlobRef,
  opts: { inline: boolean },
) {
  const file = await ctx.volumes.blobFile({ id: blob.blobId, volumeId: blob.volumeId });
  const inline = opts.inline && isInlineSafe(blob.mimeType);
  const etag = `"${blob.blobId}"`;

  reply
    .header('ETag', etag)
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, no-cache')
    .header('X-Content-Type-Options', 'nosniff')
    .header(
      'Content-Security-Policy',
      blob.mimeType === 'application/pdf' && inline ? PDF_CSP : SANDBOX_CSP,
    )
    .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', blob.name))
    .header('Content-Type', servedContentType(blob.mimeType, inline));

  if (req.headers['if-none-match'] === etag) return reply.status(304).send();

  const range = parseRange(req.headers.range, blob.size);
  if (range === 'unsatisfiable') {
    reply.header('Content-Range', `bytes */${blob.size}`);
    throw new AppError(416, ErrorCode.VALIDATION, 'Requested range not satisfiable');
  }

  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(file, 'r');
  } catch (err) {
    req.log.error({ err, blobId: blob.blobId }, 'blob file missing');
    throw new AppError(500, ErrorCode.BLOB_MISSING, 'This file is unavailable (storage error)');
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? blob.size - 1;
  if (range) {
    reply.status(206).header('Content-Range', `bytes ${start}-${end}/${blob.size}`);
  }
  reply.header('Content-Length', String(blob.size === 0 ? 0 : end - start + 1));
  if (blob.size === 0 || req.method === 'HEAD') {
    await fh.close();
    return reply.send('');
  }
  return reply.send(fh.createReadStream({ start, end, autoClose: true }));
}

export async function sendThumbnail(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  blobId: string,
  size: ThumbSize,
) {
  const file = thumbPath(ctx.config.cacheDir, blobId, size);
  const st = await stat(file).catch(() => null);
  if (!st) throw notFound('Thumbnail');
  const etag = `"${blobId}-${size}"`;
  reply
    .header('ETag', etag)
    // Keyed by immutable blob id: the bytes behind this URL never change.
    .header('Cache-Control', 'private, max-age=31536000, immutable')
    .header('Content-Type', 'image/webp')
    .header('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === etag) return reply.status(304).send();
  reply.header('Content-Length', String(st.size));
  return reply.send(createReadStream(file));
}

// ── zip ─────────────────────────────────────────────────────────────────────

const MAX_ZIP_ENTRIES = 50_000;

interface TreeEntry {
  id: string;
  type: 'folder' | 'file';
  path: string;
  size: number;
  updatedAt: string;
  blobId: string | null;
  volumeId: string | null;
}

/** All live descendants of a folder with their relative paths (recursive CTE, one query). */
export async function listTree(exec: Executor, folderId: string, limit = MAX_ZIP_ENTRIES + 1) {
  return (await exec.execute(sql`
    WITH RECURSIVE t AS (
      SELECT n.id, n.type, n.blob_id, n.size, n.updated_at, n.name::text AS path, 1 AS depth
      FROM nodes n WHERE n.parent_id = ${folderId} AND n.deleted_at IS NULL
      UNION ALL
      SELECT n.id, n.type, n.blob_id, n.size, n.updated_at, t.path || '/' || n.name, t.depth + 1
      FROM nodes n JOIN t ON n.parent_id = t.id
      WHERE n.deleted_at IS NULL AND t.type = 'folder' AND t.depth < 64
    )
    SELECT t.id, t.type, t.path, t.size, t.updated_at AS "updatedAt", b.id AS "blobId", b.volume_id AS "volumeId"
    FROM t LEFT JOIN blobs b ON b.id = t.blob_id
    ORDER BY t.path
    LIMIT ${limit}
  `)) as unknown as TreeEntry[];
}

export interface ZipRoot {
  id: string;
  type: 'folder' | 'file';
  name: string;
  size: number;
  updatedAt: Date;
  blobId: string | null;
  volumeId: string | null;
}

/**
 * Streams a store-only zip (no temp files, no compression of already-compressed media).
 * Files are opened lazily one at a time, so thousands of entries don't exhaust file descriptors,
 * and bytes flow continuously so proxies (Cloudflare's 100 s timeout) never see an idle response.
 */
export async function sendZip(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  roots: ZipRoot[],
  zipName: string,
) {
  const entries: TreeEntry[] = [];
  const usedNames = new Set<string>();
  for (const root of roots) {
    let name = root.name;
    for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${root.name} (${i})`;
    usedNames.add(name.toLowerCase());
    if (root.type === 'file') {
      entries.push({
        id: root.id,
        type: 'file',
        path: name,
        size: root.size,
        updatedAt: root.updatedAt.toISOString(),
        blobId: root.blobId,
        volumeId: root.volumeId,
      });
    } else {
      entries.push({
        ...root,
        type: 'folder',
        path: name,
        updatedAt: root.updatedAt.toISOString(),
      });
      const tree = await listTree(ctx.db, root.id);
      for (const e of tree) entries.push({ ...e, path: `${name}/${e.path}` });
    }
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw badRequest(`Too many files for one zip (max ${MAX_ZIP_ENTRIES})`);
    }
  }

  const zip = new yazl.ZipFile();
  for (const e of entries) {
    const mtime = new Date(e.updatedAt);
    if (e.type === 'folder') {
      zip.addEmptyDirectory(e.path, { mtime });
      continue;
    }
    if (!e.blobId || !e.volumeId) continue;
    const ref = { id: e.blobId, volumeId: e.volumeId };
    zip.addReadStreamLazy(e.path, { compress: false, mtime, size: Number(e.size) }, (cb) => {
      ctx.volumes
        .blobFile(ref)
        .then((file) => cb(null, createReadStream(file)))
        .catch((err: Error) => cb(err, undefined as never));
    });
  }
  zip.end();
  zip.outputStream.on('error', (err) => req.log.error({ err }, 'zip stream failed'));

  reply
    .header('Content-Type', 'application/zip')
    .header('Content-Disposition', contentDisposition('attachment', zipName))
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff');
  return reply.send(zip.outputStream);
}
