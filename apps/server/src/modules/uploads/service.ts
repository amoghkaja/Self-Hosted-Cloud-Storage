import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ErrorCode,
  type FileNode,
  guessMimeType,
  type Settings,
  type UploadSession,
} from '@familycloud/shared/all';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AppContext } from '../../context';
import type { Tx } from '../../db/client';
import {
  blobs,
  nodes,
  type UploadSessionRow,
  uploadChunks,
  uploadSessions,
  users,
} from '../../db/schema';
import { toFileNode } from '../../lib/dto';
import { AppError, conflict, notFound } from '../../lib/errors';
import { DAY_MS, toIso } from '../../lib/time';
import { isThumbnailable } from '../../storage/thumbs';
import { lockWriteAccess, requireFolder } from '../files/access';
import { insertNode, QUOTA_LOCK } from '../files/tree';

const SESSION_TTL_MS = DAY_MS;
const MAX_OPEN_SESSIONS_PER_USER = 100;

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
      .select({ node: nodes, thumb: blobs.thumbStatus })
      .from(nodes)
      .leftJoin(blobs, eq(blobs.id, nodes.blobId))
      .where(eq(nodes.id, s.nodeId));
    if (row) resolvedNode = toFileNode({ ...row.node, thumb: row.thumb });
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
 * (and the global sum) stay consistent. Release with `releaseReservation` if the write fails.
 */
export async function reserveSpace(
  tx: Tx,
  settings: Settings,
  input: { chargeUserId: string; uploaderId: string; size: number },
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

export async function releaseReservation(ctx: AppContext, chargeUserId: string, size: number) {
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
    await tx
      .update(users)
      .set({ reservedBytes: sql`greatest(${users.reservedBytes} - ${size}, 0)` })
      .where(eq(users.id, chargeUserId));
  });
}

/**
 * Starts an upload: authorizes, checks limits, atomically reserves quota on the destination
 * owner's account (and against the global cap), picks a volume and pre-allocates a sparse file.
 */
export async function createUpload(
  ctx: AppContext,
  userId: string,
  input: { parentId: string; name: string; size: number; mimeType?: string | undefined },
): Promise<UploadSessionRow> {
  const parent = await requireFolder(ctx.db, userId, input.parentId, 'edit');
  const chargeUserId = parent.node.ownerId;
  const settings = await ctx.settings.get();
  assertFileSizeAllowed(settings, input.size);
  const chunkSize = ctx.config.chunkSize;
  const totalChunks = Math.max(1, Math.ceil(input.size / chunkSize));
  const mimeType = guessMimeType(input.name, input.mimeType);

  const { session, volumePath } = await ctx.db.transaction(async (tx) => {
    await reserveSpace(tx, settings, { chargeUserId, uploaderId: userId, size: input.size });
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
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      })
      .returning();
    return { session: row!, volumePath: volume.path };
  });

  try {
    const tmp = ctx.volumes.tmpPath(volumePath, session.id);
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

  const volumePath = await ctx.volumes.pathOf(session.volumeId);
  const tmp = ctx.volumes.tmpPath(volumePath, session.id);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(tmp, 'r+');
  } catch {
    await releaseUpload(ctx, session.id, 'aborted');
    throw conflict('Upload data was lost; please start again', ErrorCode.UPLOAD_STATE);
  }

  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > expected) cb(new ChunkTooLarge());
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(
      body,
      counter,
      fh.createWriteStream({ start: index * session.chunkSize, autoClose: true }),
    );
  } catch (err) {
    await fh.close().catch(() => {});
    if (err instanceof ChunkTooLarge) {
      throw new AppError(
        400,
        ErrorCode.CHUNK_INVALID,
        `Chunk ${index} is larger than ${expected} bytes`,
      );
    }
    throw err;
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
    const fh = await open(tmp, 'r+');
    await fh.datasync();
    await fh.close();
    await mkdir(path.dirname(final), { recursive: true });
    await rename(tmp, final);
  } catch (err) {
    await releaseUpload(ctx, claimed.id, 'aborted');
    throw err;
  }

  const thumbable = isThumbnailable(claimed.mimeType);
  try {
    const node = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
      // Access is re-checked here, under row locks, because a share may have been revoked
      // (or the folder trashed) while the chunks were uploading.
      const parent = await lockWriteAccess(tx, claimed.userId, claimed.parentId);
      await tx.insert(blobs).values({
        id: claimed.blobId,
        volumeId: claimed.volumeId,
        size: claimed.size,
        thumbStatus: thumbable ? 'pending' : 'unsupported',
      });
      const row = await insertNode(
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
      await tx
        .update(users)
        .set({
          usedBytes: sql`${users.usedBytes} + ${claimed.size}`,
          reservedBytes: sql`greatest(${users.reservedBytes} - ${claimed.size}, 0)`,
        })
        .where(eq(users.id, claimed.chargeUserId));
      await tx
        .update(uploadSessions)
        .set({ status: 'completed', nodeId: row.id })
        .where(eq(uploadSessions.id, claimed.id));
      await tx.update(nodes).set({ updatedAt: new Date() }).where(eq(nodes.id, parent.id));
      return row;
    });

    await ctx.jobs.send('hash', { blobId: claimed.blobId }).catch(() => {});
    if (thumbable) await ctx.jobs.send('thumbnail', { blobId: claimed.blobId }).catch(() => {});
    return {
      session: { ...claimed, status: 'completed', nodeId: node.id },
      node: toFileNode({ ...node, thumb: thumbable ? 'pending' : 'unsupported' }),
    };
  } catch (err) {
    await unlink(final).catch(() => {});
    await releaseUpload(ctx, claimed.id, 'aborted');
    throw err;
  }
}

/** Ends an upload that will not complete: returns the reservation and removes the temp file. */
export async function releaseUpload(
  ctx: AppContext,
  sessionId: string,
  status: 'aborted' | 'expired',
): Promise<boolean> {
  const released = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
    const [s] = await tx
      .update(uploadSessions)
      .set({ status })
      .where(
        and(
          eq(uploadSessions.id, sessionId),
          inArray(uploadSessions.status, ['uploading', 'finalizing']),
        ),
      )
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
  if (volumePath) await unlink(ctx.volumes.tmpPath(volumePath, released.id)).catch(() => {});
  return true;
}
