import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ErrorCode } from '@familycloud/shared/all';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AppContext } from '../../context';
import { blobs, type NodeRow, nodes, users } from '../../db/schema';
import { AppError, conflict } from '../../lib/errors';
import { isThumbnailable, thumbPaths } from '../../storage/thumbs';
import { lockWriteAccess } from '../files/access';
import { insertNode, QUOTA_LOCK } from '../files/tree';
import { assertFileSizeAllowed, releaseReservation, reserveSpace } from './service';

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
  /** On a name clash when creating: fail (WebDAV) or pick "name (1)". */
  onConflict?: 'fail' | 'rename';
}

class TooLarge extends Error {}

/**
 * Single-request file write used by WebDAV PUT/COPY. Same guarantees as chunked uploads: quota
 * is reserved up front, bytes land in a temp file on the chosen volume, and the node/blob rows
 * plus usage counters change in one transaction. Replacing keeps the node id (so shares and
 * links survive) and swaps in a new blob.
 */
export async function ingest(
  ctx: AppContext,
  input: IngestInput,
): Promise<{ node: NodeRow; created: boolean }> {
  const settings = await ctx.settings.get();
  assertFileSizeAllowed(settings, input.size);
  const chargeUserId = input.parent.ownerId;

  const volume = await ctx.db.transaction(async (tx) => {
    await reserveSpace(tx, settings, {
      chargeUserId,
      uploaderId: input.uploaderId,
      size: input.size,
    });
    return ctx.volumes.pickVolume(tx, input.size);
  });

  const blobId = uuidv7();
  const tmp = ctx.volumes.tmpPath(volume.path, `put-${blobId}`);
  const final = ctx.volumes.blobPath(volume.path, blobId);
  let committed = false;
  try {
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
    const result = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
      // The body may have taken minutes to stream: re-check access now, under row locks, so a
      // share revoked mid-upload can't still create or replace the file.
      await lockWriteAccess(tx, input.uploaderId, input.parent.id);
      await tx.insert(blobs).values({
        id: blobId,
        volumeId: volume.id,
        size: input.size,
        thumbStatus: thumbable ? 'pending' : 'unsupported',
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
        if (existing?.type !== 'file') throw conflict('The file changed while saving');
        [node] = (await tx
          .update(nodes)
          .set({ blobId, size: input.size, mimeType: input.mimeType, updatedAt: new Date() })
          .where(eq(nodes.id, existing.id))
          .returning()) as [NodeRow];
        created = false;
        if (existing.blobId) {
          const [old] = await tx
            .delete(blobs)
            .where(eq(blobs.id, existing.blobId))
            .returning({ id: blobs.id, volumeId: blobs.volumeId, size: blobs.size });
          if (old) {
            oldBlob = old;
            freed = old.size;
          }
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
      }
      await tx
        .update(users)
        .set({
          usedBytes: sql`greatest(${users.usedBytes} + ${input.size} - ${freed}, 0)`,
          reservedBytes: sql`greatest(${users.reservedBytes} - ${input.size}, 0)`,
        })
        .where(eq(users.id, chargeUserId));
      return { node, created, oldBlob };
    });
    committed = true;

    if (result.oldBlob) {
      const oldFile = await ctx.volumes.blobFile(result.oldBlob).catch(() => null);
      for (const f of [
        ...(oldFile ? [oldFile] : []),
        ...thumbPaths(ctx.config.cacheDir, result.oldBlob.id),
      ]) {
        await unlink(f).catch(() => {});
      }
    }
    await ctx.jobs.send('hash', { blobId }).catch(() => {});
    if (thumbable) await ctx.jobs.send('thumbnail', { blobId }).catch(() => {});
    return { node: result.node, created: result.created };
  } finally {
    if (!committed) {
      await unlink(tmp).catch(() => {});
      await unlink(final).catch(() => {});
      await releaseReservation(ctx, chargeUserId, input.size);
    }
  }
}
