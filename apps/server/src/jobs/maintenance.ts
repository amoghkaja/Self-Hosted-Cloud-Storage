import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { blobs, invites, nodes, sessions, storageVolumes, uploadSessions } from '../db/schema';
import { audit } from '../lib/audit';
import { DAY_MS } from '../lib/time';
import { purgeTrashRoots, QUOTA_LOCK } from '../modules/files/tree';
import { releaseUpload } from '../modules/uploads/service';

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Records a blob's checksum (used for integrity checks and verified volume moves). */
export async function hashBlob(ctx: AppContext, blobId: string): Promise<void> {
  const [blob] = await ctx.db.select().from(blobs).where(eq(blobs.id, blobId));
  if (!blob || blob.sha256) return;
  const digest = await sha256File(await ctx.volumes.blobFile(blob));
  await ctx.db.update(blobs).set({ sha256: digest }).where(eq(blobs.id, blobId));
}

/** Permanently deletes trash older than the retention window. */
export async function purgeExpiredTrash(
  ctx: AppContext,
): Promise<{ files: number; bytes: number }> {
  const { trashRetentionDays } = await ctx.settings.get();
  const cutoff = new Date(Date.now() - trashRetentionDays * DAY_MS);
  let total = { files: 0, bytes: 0 };
  for (;;) {
    const roots = await ctx.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(sql`${nodes.trashRootId} = ${nodes.id}`, lt(nodes.deletedAt, cutoff)))
      .limit(100);
    if (roots.length === 0) break;
    const r = await purgeTrashRoots(
      ctx,
      roots.map((x) => x.id),
    );
    total = { files: total.files + r.files, bytes: total.bytes + r.bytes };
    if (roots.length < 100) break;
  }
  if (total.files > 0) ctx.log.info(total, 'purged expired trash');
  return total;
}

/**
 * Recomputes every user's used/reserved bytes from the source of truth and fixes drift.
 * Holds the exclusive quota lock so no reservation/finalize interleaves with the recount.
 */
export async function reconcileUsage(
  ctx: AppContext,
): Promise<{ id: string; before: number; after: number }[]> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK})`);
    const drift = (await tx.execute(sql`
      WITH calc AS (
        SELECT u.id, u.used_bytes, u.reserved_bytes,
          coalesce((SELECT sum(n.size) FROM nodes n WHERE n.owner_id = u.id AND n.type = 'file'), 0)::bigint AS used,
          coalesce((SELECT sum(s.size) FROM upload_sessions s
                    WHERE s.charge_user_id = u.id AND s.status IN ('uploading', 'finalizing')), 0)::bigint AS reserved
        FROM users u
      )
      UPDATE users SET used_bytes = calc.used, reserved_bytes = calc.reserved
      FROM calc
      WHERE users.id = calc.id AND (calc.used <> calc.used_bytes OR calc.reserved <> calc.reserved_bytes)
      RETURNING users.id, calc.used_bytes AS before, calc.used AS after
    `)) as unknown as { id: string; before: number; after: number }[];
    if (drift.length) ctx.log.warn({ drift }, 'corrected storage usage drift');
    return drift;
  });
}

/** Releases abandoned uploads and prunes finished session rows. */
export async function expireUploads(ctx: AppContext): Promise<number> {
  const stale = await ctx.db
    .select({ id: uploadSessions.id })
    .from(uploadSessions)
    .where(and(eq(uploadSessions.status, 'uploading'), lt(uploadSessions.expiresAt, new Date())))
    .limit(1000);
  for (const s of stale) await releaseUpload(ctx, s.id, 'expired');
  await ctx.db
    .delete(uploadSessions)
    .where(
      and(
        inArray(uploadSessions.status, ['completed', 'aborted', 'expired']),
        lt(uploadSessions.createdAt, new Date(Date.now() - 2 * DAY_MS)),
      ),
    );
  return stale.length;
}

export async function cleanupSessions(ctx: AppContext): Promise<void> {
  const now = new Date();
  await ctx.db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now), lt(sessions.absoluteExpiresAt, now)));
  await ctx.db.delete(invites).where(lt(invites.expiresAt, new Date(Date.now() - 30 * DAY_MS)));
}

/**
 * Moves every blob off a draining volume, verifying each copy by checksum before the source is
 * deleted, then retires the volume. Safe to stop and resume at any point: each blob flips
 * volumes in its own transaction, and readers holding the old file keep reading it.
 */
export async function drainVolume(ctx: AppContext, volumeId: string): Promise<void> {
  const failed = new Set<string>();
  let moved = 0;
  const setMessage = (statusMessage: string) =>
    ctx.db
      .update(storageVolumes)
      .set({ statusMessage, updatedAt: new Date() })
      .where(eq(storageVolumes.id, volumeId));

  for (;;) {
    const [vol] = await ctx.db.select().from(storageVolumes).where(eq(storageVolumes.id, volumeId));
    if (vol?.status !== 'draining') return; // cancelled or gone

    const batch = await ctx.db
      .select()
      .from(blobs)
      .where(
        and(
          eq(blobs.volumeId, volumeId),
          failed.size ? notInArray(blobs.id, [...failed]) : undefined,
        ),
      )
      .limit(20);

    if (batch.length === 0) {
      const [inflight] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.volumeId, volumeId),
            inArray(uploadSessions.status, ['uploading', 'finalizing']),
          ),
        );
      if ((inflight?.n ?? 0) > 0) {
        await setMessage(`Moved ${moved} files; waiting for ${inflight?.n} uploads to finish…`);
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      if (failed.size > 0) {
        await setMessage(
          `${failed.size} files could not be moved (missing or unreadable). See the server logs.`,
        );
        return;
      }
      await ctx.db
        .update(storageVolumes)
        .set({
          status: 'retired',
          statusMessage: `Drained ${new Date().toISOString().slice(0, 10)}. Safe to unmount.`,
          updatedAt: new Date(),
        })
        .where(and(eq(storageVolumes.id, volumeId), eq(storageVolumes.status, 'draining')));
      await audit(ctx.db, {
        actorId: null,
        action: 'volume.retired',
        targetType: 'volume',
        targetId: volumeId,
        meta: { moved },
      });
      return;
    }

    for (const blob of batch) {
      try {
        await moveBlob(ctx, blob, vol.path);
        moved++;
      } catch (err) {
        if (
          (err as { code?: string }).code === 'STORAGE_FULL' ||
          (err as { status?: number }).status === 507
        ) {
          await setMessage(`Paused after ${moved} files: other volumes are out of space.`);
          throw err;
        }
        failed.add(blob.id);
        ctx.log.error({ err, blobId: blob.id, volumeId }, 'failed to move blob during drain');
      }
    }
    await setMessage(`Moving files… ${moved} done`);
  }
}

async function moveBlob(ctx: AppContext, blob: typeof blobs.$inferSelect, fromPath: string) {
  const target = await ctx.volumes.pickVolume(ctx.db, blob.size, blob.volumeId);
  const src = ctx.volumes.blobPath(fromPath, blob.id);
  const dst = ctx.volumes.blobPath(target.path, blob.id);
  const tmp = path.join(target.path, 'tmp', `migrate-${blob.id}`);
  await mkdir(path.dirname(tmp), { recursive: true });

  const hash = createHash('sha256');
  const tap = new Transform({
    transform(chunk: Buffer, _e, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), tap, createWriteStream(tmp));
  const srcHash = hash.digest('hex');
  const fh = await open(tmp, 'r+');
  await fh.datasync();
  await fh.close();
  if ((await sha256File(tmp)) !== srcHash) {
    await unlink(tmp).catch(() => {});
    throw new Error('copy verification failed');
  }
  if (blob.sha256 && blob.sha256 !== srcHash) {
    ctx.log.error(
      { blobId: blob.id },
      'source checksum mismatch: file was corrupted on disk before the move',
    );
    await audit(ctx.db, {
      actorId: null,
      action: 'blob.checksum_mismatch',
      targetType: 'blob',
      targetId: blob.id,
    });
  }
  await mkdir(path.dirname(dst), { recursive: true });
  await rename(tmp, dst);
  const flipped = await ctx.db
    .update(blobs)
    .set({ volumeId: target.id, sha256: blob.sha256 ?? srcHash })
    .where(and(eq(blobs.id, blob.id), eq(blobs.volumeId, blob.volumeId)))
    .returning({ id: blobs.id });
  if (flipped.length === 0) {
    await unlink(dst).catch(() => {}); // deleted meanwhile
    return;
  }
  await unlink(src).catch(() => {});
}

/** Re-queues work that may have been lost (e.g. the worker was down when it was enqueued). */
export async function recoverPendingWork(ctx: AppContext): Promise<void> {
  const pending = await ctx.db
    .select({ id: blobs.id })
    .from(blobs)
    .where(
      and(
        eq(blobs.thumbStatus, 'pending'),
        lt(blobs.createdAt, new Date(Date.now() - 10 * 60_000)),
      ),
    )
    .limit(2000);
  for (const b of pending)
    await ctx.jobs.send('thumbnail', { blobId: b.id }, { singletonKey: b.id });
  const unhashed = await ctx.db
    .select({ id: blobs.id })
    .from(blobs)
    .where(and(isNull(blobs.sha256), lt(blobs.createdAt, new Date(Date.now() - 10 * 60_000))))
    .limit(2000);
  for (const b of unhashed) await ctx.jobs.send('hash', { blobId: b.id }, { singletonKey: b.id });
  const draining = await ctx.db
    .select({ id: storageVolumes.id })
    .from(storageVolumes)
    .where(eq(storageVolumes.status, 'draining'));
  for (const v of draining)
    await ctx.jobs.send('drain-volume', { volumeId: v.id }, { singletonKey: v.id });
}
