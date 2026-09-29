import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ErrorCode, isOfficeDocument } from '@familycloud/shared/all';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AppContext } from '../../context';
import { blobs, type NodeRow, nodes, uploadSessions, users } from '../../db/schema';
import { AppError, conflict } from '../../lib/errors';
import { DAY_MS } from '../../lib/time';
import { derivedPaths, isThumbnailable, isVideo } from '../../storage/thumbs';
import { lockWriteAccess } from '../files/access';
import { blobUnused, insertNode, QUOTA_LOCK } from '../files/tree';
import { assertFileSizeAllowed, releaseUpload, reserveSpace } from './service';

export type IngestSource =
  | { kind: 'stream'; body: NodeJS.ReadableStream }
  | { kind: 'copy'; fromFile: string };

export interface IngestInput {
  uploaderId: string;
  parent: { id: string; ownerId: string };
  name: string;
  size: number;
  mimeType: string;
  source: IngestSource;
  /** Replace this file's contents in place (WebDAV PUT over an existing file). */
  replaceNodeId?: string | null;
  /** If-Match: only replace while the file still has this blob (else 412). */
  expectBlobId?: string | null;
  /** On a name clash when creating: fail (WebDAV) or pick "name (1)". */
  onConflict?: 'fail' | 'rename';
}

class TooLarge extends Error {}

/**
 * Single-request file write used by WebDAV PUT/COPY. Same guarantees as chunked uploads: quota
 * is reserved up front, bytes land in a temp file on the chosen volume, and the node/blob rows
 * plus usage counters change in one transaction. Replacing keeps the node id (so shares and
 * links survive) and swaps in a new blob.
 * The write is recorded as an upload session, so usage reconciliation, volume placement and
 * drains all see the bytes in flight, and upload expiry cleans up after a crash.
 */
export async function ingest(
  ctx: AppContext,
  input: IngestInput,
): Promise<{ node: NodeRow; created: boolean }> {
  const settings = await ctx.settings.get();
  assertFileSizeAllowed(settings, input.size);
  const chargeUserId = input.parent.ownerId;
  const blobId = uuidv7();

  const { session, volume } = await ctx.db.transaction(async (tx) => {
    await reserveSpace(tx, settings, {
      chargeUserId,
      uploaderId: input.uploaderId,
      size: input.size,
    });
    const volume = await ctx.volumes.pickVolume(tx, input.size);
    const [session] = await tx
      .insert(uploadSessions)
      .values({
        userId: input.uploaderId,
        chargeUserId,
        parentId: input.parent.id,
        name: input.name,
        size: input.size,
        mimeType: input.mimeType,
        chunkSize: ctx.config.chunkSize,
        totalChunks: Math.max(1, Math.ceil(input.size / ctx.config.chunkSize)),
        volumeId: volume.id,
        blobId,
        expiresAt: new Date(Date.now() + DAY_MS),
      })
      .returning({ id: uploadSessions.id });
    return { session: session!, volume };
  });

  const tmp = ctx.volumes.tmpPath(volume.path, session.id);
  const final = ctx.volumes.blobPath(volume.path, blobId);
  let committed = false;
  try {
    await ctx.volumes.assertOnline(volume);
    await mkdir(path.dirname(tmp), { recursive: true });
    if (input.source.kind === 'copy') {
      // Reflink (instant, no extra space) where the filesystem supports it; plain copy otherwise.
      await copyFile(input.source.fromFile, tmp, fsConstants.COPYFILE_FICLONE);
    } else {
      let written = 0;
      const limit = input.size;
      const counter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          written += chunk.length;
          if (written > limit) cb(new TooLarge());
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(input.source.body, counter, (await open(tmp, 'w')).createWriteStream());
      } catch (err) {
        if (err instanceof TooLarge) {
          throw new AppError(400, ErrorCode.VALIDATION, 'Body is larger than the declared length');
        }
        throw err;
      }
      if (written !== limit) {
        throw new AppError(
          400,
          ErrorCode.VALIDATION,
          `Expected ${limit} bytes but received ${written}`,
        );
      }
    }
    const fh = await open(tmp, 'r+');
    await fh.datasync();
    await fh.close();
    await mkdir(path.dirname(final), { recursive: true });
    await rename(tmp, final);

    const thumbable = isThumbnailable(input.mimeType);
    const video = isVideo(input.mimeType);
    const office = isOfficeDocument(input.mimeType, input.name);
    const result = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
      const [live] = await tx
        .update(uploadSessions)
        .set({ status: 'completed' })
        .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.status, 'uploading')))
        .returning({ id: uploadSessions.id });
      if (!live) throw conflict('The upload was cancelled', ErrorCode.UPLOAD_STATE);
      // The body may have taken minutes to stream: re-check access now, under row locks, so a
      // share revoked mid-upload can't still create or replace the file.
      await lockWriteAccess(
        tx,
        input.uploaderId,
        input.parent.id,
        input.replaceNodeId ?? input.parent.id,
      );
      await tx.insert(blobs).values({
        id: blobId,
        volumeId: volume.id,
        size: input.size,
        thumbStatus: thumbable ? 'pending' : 'unsupported',
        streamStatus: video ? 'pending' : 'none',
        previewStatus: office ? 'pending' : 'none',
      });
      let node: NodeRow;
      let created = true;
      let freed = 0;
      let oldBlob: { id: string; volumeId: string } | null = null;
      if (input.replaceNodeId) {
        const [existing] = await tx
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, input.replaceNodeId), isNull(nodes.deletedAt)))
          .for('update');
        // Moved elsewhere meanwhile: access was checked for the folder it used to be in.
        if (existing?.type !== 'file' || existing.parentId !== input.parent.id) {
          throw conflict('The file changed while saving');
        }
        if (input.expectBlobId != null && existing.blobId !== input.expectBlobId) {
          throw new AppError(412, ErrorCode.CONFLICT, 'The file changed since it was read');
        }
        [node] = (await tx
          .update(nodes)
          .set({ blobId, size: input.size, mimeType: input.mimeType, updatedAt: new Date() })
          .where(eq(nodes.id, existing.id))
          .returning()) as [NodeRow];
        created = false;
        // The old version's size comes off the quota even when its bytes stay (another file
        // still uses them); the bytes themselves go only when nothing points at them.
        freed = existing.size;
        if (existing.blobId) {
          const [old] = await tx
            .delete(blobs)
            .where(and(eq(blobs.id, existing.blobId), blobUnused))
            .returning({ id: blobs.id, volumeId: blobs.volumeId, size: blobs.size });
          if (old) oldBlob = old;
        }
      } else {
        node = await insertNode(
          tx,
          {
            ownerId: input.parent.ownerId,
            parentId: input.parent.id,
            type: 'file',
            name: input.name,
            blobId,
            size: input.size,
            mimeType: input.mimeType,
            createdBy: input.uploaderId,
          },
          input.onConflict ?? 'fail',
        );
        await tx.update(nodes).set({ updatedAt: new Date() }).where(eq(nodes.id, input.parent.id));
      }
      await tx
        .update(users)
        .set({
          usedBytes: sql`greatest(${users.usedBytes} + ${input.size} - ${freed}, 0)`,
          reservedBytes: sql`greatest(${users.reservedBytes} - ${input.size}, 0)`,
        })
        .where(eq(users.id, chargeUserId));
      await tx
        .update(uploadSessions)
        .set({ nodeId: node.id })
        .where(eq(uploadSessions.id, session.id));
      return { node, created, oldBlob };
    });
    committed = true;

    if (result.oldBlob) {
      const oldFile = await ctx.volumes.blobFile(result.oldBlob).catch(() => null);
      for (const f of [
        ...(oldFile ? [oldFile] : []),
        ...derivedPaths(ctx.config.cacheDir, result.oldBlob.id),
      ]) {
        await unlink(f).catch(() => {});
      }
    }
    await ctx.jobs.send('hash', { blobId }).catch(() => {});
    if (thumbable) await ctx.jobs.send('thumbnail', { blobId }).catch(() => {});
    if (video) await ctx.jobs.send('video-stream', { blobId }).catch(() => {});
    return { node: result.node, created: result.created };
  } finally {
    if (!committed) {
      await unlink(tmp).catch(() => {});
      await unlink(final).catch(() => {});
      await releaseUpload(ctx, session.id, 'aborted');
    }
  }
}
