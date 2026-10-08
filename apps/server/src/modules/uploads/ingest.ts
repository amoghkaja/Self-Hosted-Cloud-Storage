import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ErrorCode } from '@familycloud/shared/all';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AppContext } from '../../context';
import { blobs, type NodeRow, nodes, uploadSessions, users } from '../../db/schema';
import { derivedWork, queueDerivedWork } from '../../jobs/derived';
import { AppError, conflict } from '../../lib/errors';
import { DAY_MS } from '../../lib/time';
import { lockWriteAccess } from '../files/access';
import { deleteBlobFiles, insertNode, QUOTA_LOCK } from '../files/tree';
import {
  lockFileIn,
  replaceContent,
  type StoredBlob,
  withRoomFromVersions,
} from '../versions/service';
import { assertFileSizeAllowed, releaseUpload, reserveSpace } from './service';

export interface IngestInput {
  uploaderId: string;
  parent: { id: string; ownerId: string };
  name: string;
  size: number;
  mimeType: string;
  /** The file's bytes (a WebDAV PUT body), exactly `size` of them. */
  body: NodeJS.ReadableStream;
  /** Replace this file's contents in place (WebDAV PUT over an existing file). */
  replaceNodeId?: string | null;
  /** If-Match: only replace while the file still has this blob (else 412). */
  expectBlobId?: string | null;
}

class TooLarge extends Error {}

/**
 * Single-request file write used by WebDAV PUT. Same guarantees as chunked uploads: quota
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

  const who = { owner: chargeUserId, actor: input.uploaderId };
  const { session, volume } = await withRoomFromVersions(ctx, who, input.size, () =>
    ctx.db.transaction(async (tx) => {
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
    }),
  );

  const tmp = ctx.volumes.tmpPath(volume.path, session.id);
  const final = ctx.volumes.blobPath(volume.path, blobId);
  let committed = false;
  try {
    await ctx.volumes.assertOnline(volume);
    await mkdir(path.dirname(tmp), { recursive: true });
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
      await pipeline(input.body, counter, (await open(tmp, 'w')).createWriteStream());
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
    const fh = await open(tmp, 'r+');
    await fh.datasync();
    await fh.close();
    await mkdir(path.dirname(final), { recursive: true });
    await rename(tmp, final);

    const work = derivedWork(input.mimeType, input.name);
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
        ...work,
      });
      let node: NodeRow;
      let created = true;
      let usageDelta = input.size;
      let orphans: StoredBlob[] = [];
      if (input.replaceNodeId) {
        const existing = await lockFileIn(tx, input.replaceNodeId, input.parent.id);
        // Moved elsewhere meanwhile: access was checked for the folder it used to be in.
        if (!existing) throw conflict('The file changed while saving');
        if (input.expectBlobId != null && existing.blobId !== input.expectBlobId) {
          throw new AppError(412, ErrorCode.CONFLICT, 'The file changed since it was read');
        }
        // Saving over a file keeps what was there as a version (a network-drive save that went
        // wrong can be undone). Its bytes go only when nothing points at them any more.
        const replaced = await replaceContent(
          tx,
          existing,
          { blobId, size: input.size, mimeType: input.mimeType },
          { actorId: input.uploaderId, keepVersion: settings.versionRetentionDays > 0 },
        );
        node = replaced.node;
        usageDelta = replaced.usageDelta;
        orphans = replaced.orphans;
        created = false;
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
          'fail', // WebDAV addresses a file by its path: a clash means someone created it first
        );
        await tx.update(nodes).set({ updatedAt: new Date() }).where(eq(nodes.id, input.parent.id));
      }
      await tx
        .update(users)
        .set({
          usedBytes: sql`greatest(${users.usedBytes} + ${usageDelta}, 0)`,
          reservedBytes: sql`greatest(${users.reservedBytes} - ${input.size}, 0)`,
        })
        .where(eq(users.id, chargeUserId));
      await tx
        .update(uploadSessions)
        .set({ nodeId: node.id })
        .where(eq(uploadSessions.id, session.id));
      return { node, created, orphans };
    });
    committed = true;

    await deleteBlobFiles(ctx, result.orphans);
    await queueDerivedWork(ctx, blobId, work);
    return { node: result.node, created: result.created };
  } finally {
    if (!committed) {
      await unlink(tmp).catch(() => {});
      await unlink(final).catch(() => {});
      await releaseUpload(ctx, session.id, 'aborted');
    }
  }
}
