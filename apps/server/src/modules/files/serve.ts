import { createReadStream, type ReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { type PassThrough, Readable } from 'node:stream';
import { ErrorCode, fileKind, type ThumbSize } from '@familycloud/shared/all';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import yazl from 'yazl';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { blobs } from '../../db/schema';
import { scanningOn } from '../../jobs/scan';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { contentDisposition, isInlineSafe, parseRange, servedContentType } from '../../lib/http';
import { previewPath, streamPath, thumbPath } from '../../storage/thumbs';

/** Locks rendered user content into an opaque, script-less sandbox even if a browser sniffs it. */
const SANDBOX_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
// Chrome/Firefox PDF viewers break under `sandbox`; PDFs are not HTML-XSS vectors in them.
const PDF_CSP = "frame-ancestors 'self'";

/**
 * Whether an If-None-Match / If-Match header value lists `etag`: handles `*`, comma-separated
 * lists and weak validators (`W/"…"`, ignored when `strong` comparison is required).
 */
export function etagMatches(
  header: string | string[] | undefined,
  etag: string,
  strong = false,
): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  return value.split(',').some((raw) => {
    const tag = raw.trim();
    if (tag.startsWith('W/')) return !strong && tag.slice(2) === etag;
    return tag === etag;
  });
}

export interface BlobRef {
  blobId: string;
  volumeId: string;
  size: number;
  name: string;
  mimeType: string | null;
}

/**
 * Every way out for a file, or a picture of it, passes here. A blob with a virus in it is never
 * sent, and one a stranger sent through a file request waits for its scan first.
 */
export async function refuseUnsafe(ctx: AppContext, blobId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ status: blobs.scanStatus, signature: blobs.scanSignature })
    .from(blobs)
    .where(eq(blobs.id, blobId));
  if (row?.status === 'infected') {
    throw new AppError(
      403,
      ErrorCode.FILE_INFECTED,
      `This file is blocked: a virus was found in it (${row.signature ?? 'unknown'}). Delete it.`,
    );
  }
  if (row?.status === 'held' && (await scanningOn(ctx))) {
    throw new AppError(
      409,
      ErrorCode.FILE_SCANNING,
      'This file is still being checked for viruses. Try again in a minute.',
    );
  }
}

const blobEtag = (blobId: string) => `"${blobId}"`;

/**
 * The part of a file a request asks for (null: all of it). A resumed download whose validator
 * no longer matches (the file was saved over) must get the whole new file, never a slice of it
 * spliced onto the old bytes. Dates can't match: no Last-Modified is sent.
 */
function requestedRange(req: FastifyRequest, size: number, etag: string) {
  const ifRange = req.headers['if-range'];
  return ifRange === undefined || String(ifRange).trim() === etag
    ? parseRange(req.headers.range, size)
    : null;
}

/**
 * Whether sendBlob answers this request with the start of the file (a new download), rather than
 * the rest of one already under way, a HEAD, a 304 or a 416. A Range that isn't honoured, or
 * that covers the whole file, sends the start too.
 */
export function sendsFileStart(
  req: FastifyRequest,
  blob: Pick<BlobRef, 'blobId' | 'size'>,
): boolean {
  if (req.method === 'HEAD') return false;
  const etag = blobEtag(blob.blobId);
  if (etagMatches(req.headers['if-none-match'], etag)) return false;
  const range = requestedRange(req, blob.size, etag);
  return range === null || (range !== 'unsatisfiable' && range.start === 0);
}

/** Sends a stored file (see sendFileRange). */
export async function sendBlob(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  blob: BlobRef,
  opts: { inline: boolean },
) {
  await refuseUnsafe(ctx, blob.blobId);
  const file = await ctx.volumes.blobFile({ id: blob.blobId, volumeId: blob.volumeId });
  return sendFileRange(req, reply, {
    file,
    size: blob.size,
    etag: blobEtag(blob.blobId),
    name: blob.name,
    mimeType: blob.mimeType,
    inline: opts.inline,
    logId: blob.blobId,
  });
}

/**
 * Plays a video: the 720p streaming copy when the worker has made one (small enough for family
 * abroad, and H.264 so it plays in every browser), otherwise the original. An original of a type
 * that can't be shown inline goes out as a download; `watchOnly` (a public link, where downloads
 * have their own rules) refuses that instead.
 */
export async function sendVideoStream(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  blob: BlobRef,
  opts: { watchOnly?: boolean } = {},
) {
  await refuseUnsafe(ctx, blob.blobId);
  const [row] = await ctx.db
    .select({ status: blobs.streamStatus })
    .from(blobs)
    .where(eq(blobs.id, blob.blobId));
  if (row?.status === 'ready') {
    const file = streamPath(ctx.config.cacheDir, blob.blobId);
    const st = await stat(file).catch(() => null);
    if (st) {
      return sendFileRange(req, reply, {
        file,
        size: st.size,
        etag: `"${blob.blobId}-720"`,
        name: `${blob.name.replace(/\.[^.]*$/, '')}.mp4`,
        mimeType: 'video/mp4',
        inline: true,
        logId: blob.blobId,
      });
    }
  }
  if (opts.watchOnly && !isInlineSafe(blob.mimeType)) {
    throw new AppError(404, ErrorCode.NOT_FOUND, "This video can't be played here yet");
  }
  return sendBlob(ctx, req, reply, blob, { inline: true });
}

/**
 * Sends the rendering of an Office document for reading it in the browser: HTML for spreadsheets
 * (an attachment the viewer fetches and rebuilds from an allowlist, never a page of its own), a
 * PDF for everything else. 404 until the worker has made it (the viewer offers a download
 * meanwhile).
 */
export async function sendOfficePreview(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  blob: BlobRef,
) {
  await refuseUnsafe(ctx, blob.blobId);
  const [row] = await ctx.db
    .select({ status: blobs.previewStatus })
    .from(blobs)
    .where(eq(blobs.id, blob.blobId));
  const sheet = fileKind(blob.mimeType, blob.name) === 'spreadsheet';
  const file = previewPath(ctx.config.cacheDir, blob.blobId, sheet ? 'html' : 'pdf');
  const st = row?.status === 'ready' ? await stat(file).catch(() => null) : null;
  if (!st) {
    // The viewer tells "still converting" from "can't be previewed" by this header.
    throw new AppError(404, ErrorCode.NOT_FOUND, 'The preview is not ready', {
      'X-Preview-Status': row?.status ?? 'none',
    });
  }
  return sendFileRange(req, reply, {
    file,
    size: st.size,
    etag: `"${blob.blobId}-${sheet ? 'html' : 'pdf'}"`,
    name: `${blob.name.replace(/\.[^.]*$/, '')}.${sheet ? 'html' : 'pdf'}`,
    mimeType: sheet ? 'text/html' : 'application/pdf',
    inline: !sheet,
    logId: blob.blobId,
  });
}

/**
 * Streams a file with Range (seeking), ETag/304 and download-safe headers.
 * Memory use is constant regardless of file size.
 */
async function sendFileRange(
  req: FastifyRequest,
  reply: FastifyReply,
  f: {
    file: string;
    size: number;
    etag: string;
    name: string;
    mimeType: string | null;
    inline: boolean;
    logId: string;
  },
) {
  const inline = f.inline && isInlineSafe(f.mimeType);
  const { etag } = f;

  reply
    .header('ETag', etag)
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, no-cache')
    .header('X-Content-Type-Options', 'nosniff')
    .header(
      'Content-Security-Policy',
      f.mimeType === 'application/pdf' && inline ? PDF_CSP : SANDBOX_CSP,
    )
    .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', f.name))
    .header('Content-Type', servedContentType(f.mimeType, inline));

  if (etagMatches(req.headers['if-none-match'], etag)) return reply.status(304).send();

  const range = requestedRange(req, f.size, etag);
  if (range === 'unsatisfiable') {
    reply.header('Content-Range', `bytes */${f.size}`);
    throw new AppError(416, ErrorCode.VALIDATION, 'Requested range not satisfiable');
  }

  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(f.file, 'r');
  } catch (err) {
    req.log.error({ err, blobId: f.logId }, 'blob file missing');
    throw new AppError(500, ErrorCode.BLOB_MISSING, 'This file is unavailable (storage error)');
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? f.size - 1;
  if (range) {
    reply.status(206).header('Content-Range', `bytes ${start}-${end}/${f.size}`);
  }
  reply.header('Content-Length', String(f.size === 0 ? 0 : end - start + 1));
  if (f.size === 0 || req.method === 'HEAD') {
    await fh.close();
    // HEAD gets an empty stream: Fastify replaces Content-Length with the body's length for a
    // string, which would tell WebDAV clients and download managers the file is empty.
    return reply.send(req.method === 'HEAD' ? Readable.from([]) : '');
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
  await refuseUnsafe(ctx, blobId);
  const file = thumbPath(ctx.config.cacheDir, blobId, size);
  const st = await stat(file).catch(() => null);
  if (!st) {
    // Marked ready but the cache is gone (e.g. restored from a backup without it): render the
    // thumbnails again. The status flip makes sure only the first request queues the job.
    const [flipped] = await ctx.db
      .update(blobs)
      .set({ thumbStatus: 'pending' })
      .where(and(eq(blobs.id, blobId), eq(blobs.thumbStatus, 'ready')))
      .returning({ id: blobs.id });
    if (flipped) {
      await ctx.jobs.send('thumbnail', { blobId }).catch(() => {});
    }
    throw notFound('Thumbnail');
  }
  const etag = `"${blobId}-${size}"`;
  reply
    .header('ETag', etag)
    // Keyed by immutable blob id: the bytes behind this URL never change.
    .header('Cache-Control', 'private, max-age=31536000, immutable')
    .header('Content-Type', 'image/webp')
    .header('X-Content-Type-Options', 'nosniff');
  if (etagMatches(req.headers['if-none-match'], etag)) return reply.status(304).send();
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
  mimeType: string | null;
  blobId: string | null;
  volumeId: string | null;
}

/** All live descendants of a folder with their relative paths (recursive CTE, one query). */
export async function listTree(exec: Executor, folderId: string, limit = MAX_ZIP_ENTRIES + 1) {
  return (await exec.execute(sql`
    WITH RECURSIVE t AS (
      SELECT n.id, n.type, n.blob_id, n.size, n.updated_at, n.mime_type, n.name::text AS path, 1 AS depth
      FROM nodes n WHERE n.parent_id = ${folderId} AND n.deleted_at IS NULL
      UNION ALL
      SELECT n.id, n.type, n.blob_id, n.size, n.updated_at, n.mime_type, t.path || '/' || n.name, t.depth + 1
      FROM nodes n JOIN t ON n.parent_id = t.id
      WHERE n.deleted_at IS NULL AND t.type = 'folder' AND t.depth < 512
    )
    SELECT t.id, t.type, t.path, t.size, t.updated_at AS "updatedAt", t.mime_type AS "mimeType",
           b.id AS "blobId", b.volume_id AS "volumeId"
    FROM t LEFT JOIN blobs b ON b.id = t.blob_id
    WHERE b.scan_status IS NULL OR b.scan_status NOT IN ('infected', 'held')
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
    // yazl rejects entry paths that look like a Windows drive ("C: backup/…") as absolute.
    const base = root.name.replace(/^([a-zA-Z]):/, '$1_');
    let name = base;
    for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${base} (${i})`;
    usedNames.add(name.toLowerCase());
    if (root.type === 'file') {
      // Left out, like blocked files inside a folder (listTree).
      if (
        root.blobId &&
        (await refuseUnsafe(ctx, root.blobId).then(
          () => false,
          () => true,
        ))
      )
        continue;
      entries.push({
        id: root.id,
        type: 'file',
        path: name,
        size: root.size,
        updatedAt: root.updatedAt.toISOString(),
        mimeType: null,
        blobId: root.blobId,
        volumeId: root.volumeId,
      });
    } else {
      entries.push({
        ...root,
        type: 'folder',
        path: name,
        updatedAt: root.updatedAt.toISOString(),
        mimeType: null,
      });
      const tree = await listTree(ctx.db, root.id);
      for (const e of tree) entries.push({ ...e, path: `${name}/${e.path}` });
    }
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw badRequest(`Too many files for one zip (max ${MAX_ZIP_ENTRIES})`);
    }
  }

  reply
    .header('Content-Type', 'application/zip')
    .header('Content-Disposition', contentDisposition('attachment', zipName))
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff');
  // Fastify would drain the whole archive (reading every file) just to discard it.
  if (req.method === 'HEAD') return reply.send(Readable.from([]));

  const zip = new yazl.ZipFile();
  const output = zip.outputStream as PassThrough;
  const reading = new Set<ReadStream>();
  // yazl reports read failures (a missing blob, a size mismatch) on the ZipFile, and a stream
  // error nobody listens to would crash the process. Abort the download instead; the headers
  // are already sent, so the client sees a failed transfer rather than a corrupt zip.
  zip.on('error', (err: Error) => {
    req.log.error({ err }, 'zip stream failed');
    output.destroy(err);
  });
  // A client that disconnects destroys the output; release the file being read, which would
  // otherwise stay open (paused by backpressure) for good.
  output.once('close', () => {
    for (const s of reading) s.destroy();
  });
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
        .then((file) => {
          if (output.destroyed) return;
          const stream = createReadStream(file);
          reading.add(stream);
          stream.once('close', () => reading.delete(stream));
          stream.on('error', (err) => zip.emit('error', err));
          cb(null, stream);
        })
        .catch((err: Error) => zip.emit('error', err));
    });
  }
  zip.end();
  return reply.send(output);
}
