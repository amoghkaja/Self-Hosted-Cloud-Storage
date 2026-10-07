import { type FileHandle, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ErrorCode,
  type FileNode,
  guessMimeType,
  type Settings,
  type UploadConflict,
  type UploadSession,
} from '@familycloud/shared/all';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import {
  blobs,
  type NodeRow,
  nodes,
  shareLinks,
  type UploadSessionRow,
  uploadChunks,
  uploadSessions,
  users,
} from '../../db/schema';
import { derivedWork, queueDerivedWork } from '../../jobs/derived';
import { scanningOn } from '../../jobs/scan';
import { toFileNode } from '../../lib/dto';
import { AppError, conflict, notFound } from '../../lib/errors';
import { DAY_MS, toIso } from '../../lib/time';
import { loadAccess, lockWriteAccess, requireFolder } from '../files/access';
import { deleteBlobFiles, insertNode, QUOTA_LOCK } from '../files/tree';
import { IN_SOME_ALBUM } from '../photos/media';
import {
  lockFileNamed,
  replaceContent,
  type StoredBlob,
  withRoomFromVersions,
} from '../versions/service';

const SESSION_TTL_MS = DAY_MS;
const MAX_OPEN_SESSIONS_PER_USER = 100;
/** Uploads in progress at once through one file request (each holds some of the owner's space). */
const MAX_OPEN_SESSIONS_PER_LINK = 20;

export function expectedChunkLength(
  s: Pick<UploadSessionRow, 'size' | 'chunkSize' | 'totalChunks'>,
  index: number,
) {
  if (index < s.totalChunks - 1) return s.chunkSize;
  return s.size - s.chunkSize * (s.totalChunks - 1);
}

export async function toUploadDto(
  ctx: AppContext,
  s: UploadSessionRow,
  node: FileNode | null = null,
): Promise<UploadSession> {
  const chunks = await ctx.db
    .select({ idx: uploadChunks.idx })
    .from(uploadChunks)
    .where(eq(uploadChunks.uploadId, s.id))
    .orderBy(asc(uploadChunks.idx));
  let resolvedNode = node;
  if (!resolvedNode && s.status === 'completed' && s.nodeId) {
    const [row] = await ctx.db
      .select({ node: nodes, thumb: blobs.thumbStatus, scan: blobs.scanStatus })
      .from(nodes)
      .leftJoin(blobs, eq(blobs.id, nodes.blobId))
      .where(eq(nodes.id, s.nodeId));
    if (row) resolvedNode = toFileNode({ ...row.node, thumb: row.thumb, scan: row.scan });
  }
  return {
    id: s.id,
    name: s.name,
    size: s.size,
    chunkSize: s.chunkSize,
    totalChunks: s.totalChunks,
    receivedChunks: chunks.map((c) => c.idx),
    status: s.status,
    expiresAt: toIso(s.expiresAt),
    node: resolvedNode,
  };
}

export function assertFileSizeAllowed(settings: Settings, size: number): void {
  if (settings.maxFileSizeBytes != null && size > settings.maxFileSizeBytes) {
    throw new AppError(
      413,
      ErrorCode.FILE_TOO_LARGE,
      'This file is larger than the allowed maximum',
    );
  }
}

/**
 * Atomically reserves `size` bytes against the charged user's quota and the global cap.
 * Must run inside a transaction; takes the exclusive quota lock so concurrent reservations
 * (and the global sum) stay consistent. Record the reservation as an upload session in the same
 * transaction; `releaseUpload` returns it if the write fails.
 */
export async function reserveSpace(
  tx: Tx,
  settings: Settings,
  // uploaderId: null for a file request's sender, who has no quota of their own.
  input: { chargeUserId: string; uploaderId: string | null; size: number },
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK})`);
  if (settings.globalCapacityBytes != null) {
    const [row] = await tx
      .select({
        total: sql<number>`coalesce(sum(${users.usedBytes} + ${users.reservedBytes}), 0)::bigint`,
      })
      .from(users);
    if (Number(row?.total ?? 0) + input.size > settings.globalCapacityBytes) {
      throw new AppError(
        507,
        ErrorCode.CAPACITY_EXCEEDED,
        'The family storage limit has been reached',
      );
    }
  }
  const reserved = await tx
    .update(users)
    .set({ reservedBytes: sql`${users.reservedBytes} + ${input.size}` })
    .where(
      and(
        eq(users.id, input.chargeUserId),
        sql`(${users.quotaBytes} IS NULL OR ${users.usedBytes} + ${users.reservedBytes} + ${input.size} <= ${users.quotaBytes})`,
      ),
    )
    .returning({ id: users.id });
  if (reserved.length === 0) {
    const detail =
      input.chargeUserId === input.uploaderId
        ? 'Not enough storage left in your quota for this file'
        : "Not enough storage left in the folder owner's quota for this file";
    throw new AppError(507, ErrorCode.QUOTA_EXCEEDED, detail);
  }
}

/**
 * Starts an upload: authorizes, checks limits, atomically reserves quota on the destination
 * owner's account (and against the global cap), picks a volume and pre-allocates a sparse file.
 */
export async function createUpload(
  ctx: AppContext,
  userId: string,
  input: {
    parentId: string;
    name: string;
    size: number;
    mimeType?: string | undefined;
    onConflict?: UploadConflict;
    /** Sent through this file request by someone without an account (`userId` is the owner). */
    linkId?: string;
  },
): Promise<UploadSessionRow> {
  const parent = await requireFolder(ctx.db, userId, input.parentId, 'edit');
  const chargeUserId = parent.node.ownerId;
  const settings = await ctx.settings.get();
  assertFileSizeAllowed(settings, input.size);
  const chunkSize = ctx.config.chunkSize;
  const totalChunks = Math.max(1, Math.ceil(input.size / chunkSize));
  const mimeType = guessMimeType(input.name, input.mimeType);

  // A file request's sender is nobody: they can't make the owner's old versions go.
  const who = { owner: chargeUserId, actor: input.linkId ? null : userId };
  const { session, volume } = await withRoomFromVersions(ctx, who, input.size, () =>
    ctx.db.transaction(async (tx) => {
      await reserveSpace(tx, settings, { chargeUserId, uploaderId: who.actor, size: input.size });
      // Counted under the reservation lock so parallel requests can't exceed the limit.
      const [open_] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(uploadSessions)
        .where(and(eq(uploadSessions.userId, userId), eq(uploadSessions.status, 'uploading')));
      if ((open_?.n ?? 0) >= MAX_OPEN_SESSIONS_PER_USER) {
        throw new AppError(
          429,
          ErrorCode.RATE_LIMITED,
          'Too many uploads in progress. Wait for some to finish.',
        );
      }
      if (input.linkId) {
        const [viaLink] = await tx
          .select({
            n: sql<number>`count(*) FILTER (WHERE ${uploadSessions.status} = 'uploading')::int`,
            bytes: sql<number>`coalesce(sum(${uploadSessions.size}), 0)::bigint`,
          })
          .from(uploadSessions)
          .where(
            and(
              eq(uploadSessions.linkId, input.linkId),
              inArray(uploadSessions.status, ['uploading', 'finalizing']),
            ),
          );
        if ((viaLink?.n ?? 0) >= MAX_OPEN_SESSIONS_PER_LINK) {
          throw new AppError(
            429,
            ErrorCode.RATE_LIMITED,
            'Too many uploads at once through this link. Wait for some to finish.',
          );
        }
        // Received so far plus on the way, under the same lock as every reservation.
        const [link] = await tx
          .select({ got: shareLinks.uploadBytes, max: shareLinks.maxUploadBytes })
          .from(shareLinks)
          .where(eq(shareLinks.id, input.linkId));
        if (link?.max != null && link.got + Number(viaLink?.bytes ?? 0) + input.size > link.max) {
          throw new AppError(
            507,
            ErrorCode.CAPACITY_EXCEEDED,
            "This link can't take that much more. Ask whoever sent it for a new one.",
          );
        }
      }
      const volume = await ctx.volumes.pickVolume(tx, input.size);
      const [row] = await tx
        .insert(uploadSessions)
        .values({
          userId,
          chargeUserId,
          parentId: parent.node.id,
          name: input.name,
          size: input.size,
          mimeType,
          chunkSize,
          totalChunks,
          volumeId: volume.id,
          blobId: uuidv7(),
          replaceExisting: input.onConflict === 'replace',
          linkId: input.linkId ?? null,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        })
        .returning();
      return { session: row!, volume };
    }),
  );

  try {
    await ctx.volumes.assertOnline(volume);
    const tmp = ctx.volumes.tmpPath(volume.path, session.id);
    await mkdir(path.dirname(tmp), { recursive: true });
    const fh = await open(tmp, 'w');
    await fh.truncate(input.size); // sparse: no disk used until bytes arrive
    await fh.close();
  } catch (err) {
    await releaseUpload(ctx, session.id, 'aborted');
    throw err;
  }
  return session;
}

/**
 * "Instant upload": when a file with the same SHA-256 and size is already stored, and the
 * uploader can already see a copy of it (their own files, something shared with them, or a photo
 * in a family album), the new file points at the same bytes and nothing is transferred.
 *
 * Matching only against visible copies keeps the hash from revealing whether someone else has a
 * particular private file. The new file is charged to its folder owner's quota like any upload;
 * the saving is in transfer time and disk space. Returns null when there's no usable copy.
 */
export async function instantUpload(
  ctx: AppContext,
  userId: string,
  input: {
    parentId: string;
    name: string;
    size: number;
    mimeType?: string | undefined;
    sha256: string;
    onConflict?: UploadConflict;
  },
): Promise<FileNode | null> {
  const parent = await requireFolder(ctx.db, userId, input.parentId, 'edit');
  const settings = await ctx.settings.get();
  assertFileSizeAllowed(settings, input.size);

  const candidates = await ctx.db
    .select({
      blobId: blobs.id,
      volumeId: blobs.volumeId,
      thumb: blobs.thumbStatus,
      scan: blobs.scanStatus,
      nodeId: nodes.id,
      ownerId: nodes.ownerId,
      inAlbum: sql<boolean>`${IN_SOME_ALBUM}`,
    })
    .from(blobs)
    .innerJoin(nodes, eq(nodes.blobId, blobs.id))
    .where(
      and(
        eq(blobs.sha256, input.sha256),
        eq(blobs.size, input.size),
        sql`${nodes.deletedAt} IS NULL`,
      ),
    )
    .limit(20);
  let match: (typeof candidates)[number] | undefined;
  for (const c of candidates) {
    const visible =
      c.ownerId === userId || c.inAlbum || (await loadAccess(ctx.db, userId, c.nodeId)) !== null;
    if (!visible) continue;
    const vol = await ctx.volumes.pathOf(c.volumeId).catch(() => null);
    if (vol && (await ctx.volumes.status({ id: c.volumeId, path: vol })).online) {
      match = c;
      break;
    }
  }
  if (!match) return null;
  const found = match;

  const mimeType = guessMimeType(input.name, input.mimeType);
  // Quota lock first, then the blob row (the order "empty trash" uses too, so they can't deadlock).
  const gone = new Error('blob gone');
  const keepVersion = settings.versionRetentionDays > 0;
  const who = { owner: parent.node.ownerId, actor: userId };
  const committed = await withRoomFromVersions(ctx, who, input.size, () =>
    ctx.db.transaction(async (tx) => {
      await reserveSpace(tx, settings, {
        chargeUserId: parent.node.ownerId,
        uploaderId: userId,
        size: input.size,
      });
      // The copy must still exist: this row lock also stops a concurrent "empty trash" from
      // deleting the bytes before our file points at them.
      const [still] = await tx
        .select({ id: blobs.id })
        .from(blobs)
        .where(eq(blobs.id, found.blobId))
        .for('key share');
      // Throwing rolls back the reservation made above.
      if (!still) throw gone;
      const target = await lockWriteAccess(tx, userId, parent.node.id);
      const existing =
        input.onConflict === 'replace' ? await lockFileNamed(tx, target.id, input.name) : null;
      let row: NodeRow;
      let usageDelta = input.size;
      let orphans: StoredBlob[] = [];
      if (existing) {
        const replaced = await replaceContent(
          tx,
          existing,
          { blobId: found.blobId, size: input.size, mimeType },
          { actorId: userId, keepVersion },
        );
        ({ node: row, usageDelta, orphans } = replaced);
      } else {
        row = await insertNode(
          tx,
          {
            ownerId: target.ownerId,
            parentId: target.id,
            type: 'file',
            name: input.name,
            blobId: found.blobId,
            size: input.size,
            mimeType,
            createdBy: userId,
          },
          'rename',
        );
      }
      await tx
        .update(users)
        .set({
          usedBytes: sql`greatest(${users.usedBytes} + ${usageDelta}, 0)`,
          reservedBytes: sql`greatest(${users.reservedBytes} - ${input.size}, 0)`,
        })
        .where(eq(users.id, target.ownerId));
      await tx.update(nodes).set({ updatedAt: new Date() }).where(eq(nodes.id, target.id));
      return { row, orphans };
    }),
  ).catch((err) => {
    if (err === gone) return null;
    throw err;
  });
  if (!committed) return null;
  await deleteBlobFiles(ctx, committed.orphans);
  return toFileNode({ ...committed.row, thumb: found.thumb });
}

export async function getOwnedSession(ctx: AppContext, userId: string, id: string) {
  const [s] = await ctx.db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, id), eq(uploadSessions.userId, userId)));
  if (!s) throw notFound('Upload');
  return s;
}

class ChunkTooLarge extends Error {}

/**
 * Chunk writes in progress, per upload (in this process: the app runs as one). Finalizing stops
 * them before the temp file becomes the stored file: a second copy of a chunk still streaming (a
 * slow retry, or a sender trickling bytes on purpose) would otherwise go on writing into the file
 * after it was committed, checksummed and scanned, and into every file that shares its bytes.
 */
const chunkWriters = new Map<
  string,
  { closed: boolean; active: Map<AbortController, Promise<void>> }
>();

function writersOf(uploadId: string) {
  let w = chunkWriters.get(uploadId);
  if (!w) {
    w = { closed: false, active: new Map() };
    chunkWriters.set(uploadId, w);
  }
  return w;
}

/** Turns away new chunk writes, stops those in progress and waits until their files are closed. */
async function stopChunkWriters(uploadId: string): Promise<void> {
  const w = writersOf(uploadId);
  w.closed = true;
  for (const writer of w.active.keys()) writer.abort();
  await Promise.all(w.active.values());
}

/** A chunk sent again once the upload had every chunk: report where it is instead of failing. */
async function lateChunk(ctx: AppContext, uploadId: string) {
  const [now] = await ctx.db.select().from(uploadSessions).where(eq(uploadSessions.id, uploadId));
  if (now?.status === 'finalizing' || now?.status === 'completed') {
    return { session: now, node: null };
  }
  throw conflict(`Upload is ${now?.status ?? 'gone'}`, ErrorCode.UPLOAD_STATE);
}

/**
 * Writes one chunk straight from the request stream into the pre-allocated file at its offset.
 * Chunks may arrive in any order and in parallel; re-sending a chunk is harmless (idempotent).
 */
export async function writeChunk(
  ctx: AppContext,
  session: UploadSessionRow,
  index: number,
  body: NodeJS.ReadableStream,
  declaredLength: number | null,
): Promise<{ session: UploadSessionRow; node: FileNode | null }> {
  if (session.status === 'completed') return { session, node: null };
  if (session.status !== 'uploading') {
    throw conflict(`Upload is ${session.status}`, ErrorCode.UPLOAD_STATE);
  }
  if (index >= session.totalChunks) {
    throw new AppError(400, ErrorCode.CHUNK_INVALID, 'Chunk index out of range');
  }
  const expected = expectedChunkLength(session, index);
  if (declaredLength !== null && declaredLength !== expected) {
    throw new AppError(400, ErrorCode.CHUNK_INVALID, `Chunk ${index} must be ${expected} bytes`);
  }

  const writers = writersOf(session.id);
  // Finalizing has begun: the upload already has this chunk.
  if (writers.closed) return lateChunk(ctx, session.id);
  const writer = new AbortController();
  let release = () => {};
  writers.active.set(
    writer,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let fh: FileHandle | undefined;
  let written = 0;
  try {
    const volumePath = await ctx.volumes.pathOf(session.volumeId);
    const tmp = ctx.volumes.tmpPath(volumePath, session.id);
    try {
      fh = await open(tmp, 'r+');
    } catch {
      // A disk that is briefly gone must not cost the upload: 503, and the client retries.
      await ctx.volumes.assertOnline({ id: session.volumeId, path: volumePath });
      if (await releaseUpload(ctx, session.id, 'aborted', ['uploading'])) {
        throw conflict('Upload data was lost; please start again', ErrorCode.UPLOAD_STATE);
      }
      // A late retry of a chunk after the last one arrived: finalizing already moved the file.
      return lateChunk(ctx, session.id);
    }
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > expected) cb(new ChunkTooLarge());
        else cb(null, chunk);
      },
    });
    await pipeline(
      body,
      counter,
      fh.createWriteStream({ start: index * session.chunkSize, autoClose: true }),
      { signal: writer.signal },
    );
  } catch (err) {
    if (err instanceof ChunkTooLarge) {
      throw new AppError(
        400,
        ErrorCode.CHUNK_INVALID,
        `Chunk ${index} is larger than ${expected} bytes`,
      );
    }
    // Stopped by finalizing: another copy of this chunk already arrived.
    if (writer.signal.aborted) return lateChunk(ctx, session.id);
    throw err;
  } finally {
    // Also waits for writes still in flight, so a stopped writer is really done.
    await fh?.close().catch(() => {});
    writers.active.delete(writer);
    if (!writers.closed && writers.active.size === 0 && chunkWriters.get(session.id) === writers) {
      chunkWriters.delete(session.id);
    }
    release();
  }
  if (written !== expected) {
    throw new AppError(
      400,
      ErrorCode.CHUNK_INVALID,
      `Chunk ${index} was ${written} bytes, expected ${expected}`,
    );
  }

  const inserted = await ctx.db
    .insert(uploadChunks)
    .values({ uploadId: session.id, idx: index })
    .onConflictDoNothing()
    .returning();
  let current: UploadSessionRow | undefined;
  if (inserted.length > 0) {
    [current] = await ctx.db
      .update(uploadSessions)
      .set({
        receivedCount: sql`${uploadSessions.receivedCount} + 1`,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      })
      .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.status, 'uploading')))
      .returning();
  } else {
    [current] = await ctx.db.select().from(uploadSessions).where(eq(uploadSessions.id, session.id));
  }
  if (!current) throw conflict('Upload is no longer active', ErrorCode.UPLOAD_STATE);

  if (current.status === 'uploading' && current.receivedCount === current.totalChunks) {
    return finalizeUpload(ctx, current);
  }
  return { session: current, node: null };
}

/**
 * Turns a fully received upload into a file. Exactly one request wins the uploading→finalizing
 * transition; the rest report the in-progress state. The work is a rename plus one short
 * transaction, so it finishes well inside proxy timeouts even for very large files.
 */
export async function finalizeUpload(
  ctx: AppContext,
  session: UploadSessionRow,
): Promise<{ session: UploadSessionRow; node: FileNode | null }> {
  const [claimed] = await ctx.db
    .update(uploadSessions)
    .set({ status: 'finalizing' })
    .where(
      and(
        eq(uploadSessions.id, session.id),
        eq(uploadSessions.status, 'uploading'),
        sql`${uploadSessions.receivedCount} = ${uploadSessions.totalChunks}`,
      ),
    )
    .returning();
  if (!claimed) {
    const [now] = await ctx.db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, session.id));
    return { session: now ?? session, node: null };
  }

  const volumePath = await ctx.volumes.pathOf(claimed.volumeId);
  const tmp = ctx.volumes.tmpPath(volumePath, claimed.id);
  const final = ctx.volumes.blobPath(volumePath, claimed.blobId);
  try {
    await stopChunkWriters(claimed.id);
    const fh = await open(tmp, 'r+');
    await fh.datasync();
    await fh.close();
    await mkdir(path.dirname(final), { recursive: true });
    await rename(tmp, final);
  } catch (err) {
    if (!(await ctx.volumes.status({ id: claimed.volumeId, path: volumePath }, true)).online) {
      // The disk is briefly gone: hand the upload back, so a retried chunk finalizes it later.
      await ctx.db
        .update(uploadSessions)
        .set({ status: 'uploading' })
        .where(and(eq(uploadSessions.id, claimed.id), eq(uploadSessions.status, 'finalizing')));
      throw new AppError(
        503,
        ErrorCode.VOLUME_OFFLINE,
        'Storage is offline. Ask your admin to check the disks.',
      );
    }
    if (await releaseUpload(ctx, claimed.id, 'aborted')) throw err;
    throw conflict('The upload was cancelled', ErrorCode.UPLOAD_STATE);
  } finally {
    // Moved (a chunk sent again finds no temp file), or handed back to take chunks again.
    chunkWriters.delete(claimed.id);
  }

  const work = derivedWork(claimed.mimeType, claimed.name);
  // A stranger's file (sent through a file request) isn't served until it has been scanned.
  const held = claimed.linkId !== null && (await scanningOn(ctx));
  const { versionRetentionDays } = await ctx.settings.get();
  let committed: { node: NodeRow; orphans: StoredBlob[] };
  try {
    committed = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
      // Cancelled or expired while finalizing: its reservation is already released, so
      // committing would count the bytes twice and bring back a file the user cancelled.
      const [live] = await tx
        .update(uploadSessions)
        .set({ status: 'completed' })
        .where(and(eq(uploadSessions.id, claimed.id), eq(uploadSessions.status, 'finalizing')))
        .returning({ id: uploadSessions.id });
      if (!live) throw conflict('The upload was cancelled', ErrorCode.UPLOAD_STATE);
      // Sent through a file request: the request must still be on (a revoke waits for us).
      if (claimed.linkId) {
        const [link] = await tx
          .select({ revokedAt: shareLinks.revokedAt })
          .from(shareLinks)
          .where(eq(shareLinks.id, claimed.linkId))
          .for('share');
        if (!link || link.revokedAt) {
          throw conflict('This upload link was turned off', ErrorCode.UPLOAD_STATE);
        }
        await tx
          .update(shareLinks)
          .set({
            uploadCount: sql`${shareLinks.uploadCount} + 1`,
            uploadBytes: sql`${shareLinks.uploadBytes} + ${claimed.size}`,
          })
          .where(eq(shareLinks.id, claimed.linkId));
      }
      // Access is re-checked here, under row locks, because a share may have been revoked
      // (or the folder trashed) while the chunks were uploading.
      const parent = await lockWriteAccess(tx, claimed.userId, claimed.parentId);
      await tx.insert(blobs).values({
        id: claimed.blobId,
        volumeId: claimed.volumeId,
        size: claimed.size,
        ...work,
        scanStatus: held ? 'held' : 'pending',
      });
      // "Replace": save over the file of that name, keeping its old contents as a version.
      const existing = claimed.replaceExisting
        ? await lockFileNamed(tx, parent.id, claimed.name)
        : null;
      let row: NodeRow;
      let usageDelta = claimed.size;
      let orphans: StoredBlob[] = [];
      if (existing) {
        ({
          node: row,
          usageDelta,
          orphans,
        } = await replaceContent(
          tx,
          existing,
          { blobId: claimed.blobId, size: claimed.size, mimeType: claimed.mimeType },
          { actorId: claimed.userId, keepVersion: versionRetentionDays > 0 },
        ));
      } else {
        row = await insertNode(
          tx,
          {
            ownerId: parent.ownerId,
            parentId: parent.id,
            type: 'file',
            name: claimed.name,
            blobId: claimed.blobId,
            size: claimed.size,
            mimeType: claimed.mimeType,
            createdBy: claimed.userId,
          },
          'rename',
        );
      }
      await tx
        .update(users)
        .set({
          usedBytes: sql`greatest(${users.usedBytes} + ${usageDelta}, 0)`,
          reservedBytes: sql`greatest(${users.reservedBytes} - ${claimed.size}, 0)`,
        })
        .where(eq(users.id, claimed.chargeUserId));
      await tx
        .update(uploadSessions)
        .set({ nodeId: row.id })
        .where(eq(uploadSessions.id, claimed.id));
      await tx.update(nodes).set({ updatedAt: new Date() }).where(eq(nodes.id, parent.id));
      return { node: row, orphans };
    });
  } catch (err) {
    await unlink(final).catch(() => {});
    await releaseUpload(ctx, claimed.id, 'aborted');
    throw err;
  }
  // Committed: from here on nothing may remove the new file's bytes.
  const { node, orphans } = committed;
  await deleteBlobFiles(ctx, orphans);
  await queueDerivedWork(ctx, claimed.blobId, work);
  return {
    session: { ...claimed, status: 'completed', nodeId: node.id },
    node: toFileNode({ ...node, thumb: work.thumbStatus }),
  };
}

/**
 * Ends an upload that will not complete (if it is still in one of the `from` states): returns
 * the reservation and removes the temp file. Once this succeeds the upload can no longer
 * commit (both commit paths require the session to still be active).
 */
export async function releaseUpload(
  ctx: AppContext,
  sessionId: string,
  status: 'aborted' | 'expired',
  from: UploadSessionRow['status'][] = ['uploading', 'finalizing'],
): Promise<boolean> {
  const released = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
    const [s] = await tx
      .update(uploadSessions)
      .set({ status })
      .where(and(eq(uploadSessions.id, sessionId), inArray(uploadSessions.status, from)))
      .returning();
    if (!s) return null;
    await tx
      .update(users)
      .set({ reservedBytes: sql`greatest(${users.reservedBytes} - ${s.size}, 0)` })
      .where(eq(users.id, s.chargeUserId));
    return s;
  });
  if (!released) return false;
  const volumePath = await ctx.volumes.pathOf(released.volumeId).catch(() => null);
  if (volumePath) {
    await unlink(ctx.volumes.tmpPath(volumePath, released.id)).catch(() => {});
    // A finalize interrupted after its rename (a crash) leaves the file with no blob row.
    const [blob] = await ctx.db
      .select({ id: blobs.id })
      .from(blobs)
      .where(eq(blobs.id, released.blobId));
    if (!blob) await unlink(ctx.volumes.blobPath(volumePath, released.blobId)).catch(() => {});
  }
  return true;
}
