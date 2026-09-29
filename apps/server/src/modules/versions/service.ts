import { ErrorCode, MAX_VERSIONS_PER_FILE } from '@familycloud/shared/all';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { blobs, fileVersions, type NodeRow, nodes, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { DAY_MS } from '../../lib/time';
import { lockWriteAccess } from '../files/access';
import { blobUnused, deleteBlobFiles, QUOTA_LOCK } from '../files/tree';

export interface StoredBlob {
  id: string;
  volumeId: string;
}

/** Deletes the blob rows among `ids` that no file or version points at any more. */
export async function deleteUnusedBlobs(tx: Executor, ids: string[]): Promise<StoredBlob[]> {
  const unique = [...new Set(ids)];
  const out: StoredBlob[] = [];
  for (let i = 0; i < unique.length; i += 5000) {
    out.push(
      ...(await tx
        .delete(blobs)
        .where(sql`${inArray(blobs.id, unique.slice(i, i + 5000))} AND ${blobUnused}`)
        .returning({ id: blobs.id, volumeId: blobs.volumeId })),
    );
  }
  return out;
}

/**
 * Points a file at new contents. The old contents become a version (the newest
 * MAX_VERSIONS_PER_FILE are kept), or are let go when versions are off. Runs inside the caller's
 * transaction, which holds the shared quota lock and has the file's row locked. Returns how the
 * owner's stored bytes change (for their usage counter), and the blobs nothing uses any more
 * (delete their files with deleteBlobFiles once the transaction has committed).
 */
export async function replaceContent(
  tx: Executor,
  file: NodeRow,
  next: { blobId: string; size: number; mimeType: string | null },
  opts: { actorId: string | null; keepVersion: boolean },
): Promise<{ node: NodeRow; usageDelta: number; orphans: StoredBlob[] }> {
  // The same bytes again (an instant re-upload of an unchanged file): nothing to keep or count.
  let usageDelta = file.blobId === next.blobId ? 0 : next.size;
  const dropped: string[] = [];
  if (file.blobId && file.blobId !== next.blobId) {
    if (opts.keepVersion) {
      await tx.insert(fileVersions).values({
        nodeId: file.id,
        blobId: file.blobId,
        size: file.size,
        mimeType: file.mimeType,
        modifiedAt: file.updatedAt,
        modifiedBy: file.modifiedBy ?? file.createdBy,
      });
      const pruned = (await tx.execute(sql`
        DELETE FROM file_versions WHERE id IN (
          SELECT id FROM file_versions WHERE node_id = ${file.id}
          ORDER BY created_at DESC, id DESC OFFSET ${MAX_VERSIONS_PER_FILE}
        )
        RETURNING blob_id AS "blobId", size
      `)) as unknown as { blobId: string; size: number }[];
      for (const p of pruned) {
        usageDelta -= Number(p.size);
        dropped.push(p.blobId);
      }
    } else {
      usageDelta -= file.size;
      dropped.push(file.blobId);
    }
  }
  const [node] = await tx
    .update(nodes)
    .set({
      blobId: next.blobId,
      size: next.size,
      mimeType: next.mimeType,
      updatedAt: new Date(),
      modifiedBy: opts.actorId,
    })
    .where(eq(nodes.id, file.id))
    .returning();
  const orphans = await deleteUnusedBlobs(tx, dropped);
  return { node: node!, usageDelta, orphans };
}

/** The live file named `name` in a folder (case-insensitively), locked for replacing. */
export async function lockFileNamed(
  tx: Executor,
  folderId: string,
  name: string,
): Promise<NodeRow | null> {
  const [row] = await tx
    .select()
    .from(nodes)
    .where(
      sql`${nodes.parentId} = ${folderId} AND ${nodes.deletedAt} IS NULL
        AND lower(${nodes.name}) = lower(${name})`,
    )
    .for('update');
  return row?.type === 'file' ? row : null;
}

/**
 * Moves a file's contents onto another file of the same owner and removes the source. The
 * target keeps its identity (shares, links, place in an album) and what it held becomes a
 * version. This is how editors save over the network drive: write a temporary file, then
 * rename it over the original. Moving it the ordinary way would trash the original, and its
 * links with it, on every save.
 */
export async function moveContentOnto(
  ctx: AppContext,
  actorId: string,
  source: Pick<NodeRow, 'id' | 'ownerId' | 'parentId'>,
  target: Pick<NodeRow, 'id' | 'ownerId' | 'parentId'>,
): Promise<void> {
  const { versionRetentionDays } = await ctx.settings.get();
  const orphans = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
    // Through a share: edit access to both folders is re-checked under lock. Folders first,
    // then files, each in id order, like every other writer.
    if (actorId !== source.ownerId) {
      for (const folderId of [...new Set([source.parentId!, target.parentId!])].sort()) {
        await lockWriteAccess(tx, actorId, folderId);
      }
    }
    const rows = await tx
      .select()
      .from(nodes)
      .where(inArray(nodes.id, [source.id, target.id]))
      .orderBy(nodes.id)
      .for('update');
    const src = rows.find((r) => r.id === source.id);
    const dst = rows.find((r) => r.id === target.id);
    if (
      !src?.blobId ||
      !dst ||
      src.deletedAt ||
      dst.deletedAt ||
      src.type !== 'file' ||
      dst.type !== 'file' ||
      src.ownerId !== dst.ownerId ||
      src.parentId !== source.parentId ||
      dst.parentId !== target.parentId
    ) {
      throw new AppError(409, ErrorCode.CONFLICT, 'The files changed meanwhile');
    }
    // It's the same document: any history the source had comes along.
    await tx.update(fileVersions).set({ nodeId: dst.id }).where(eq(fileVersions.nodeId, src.id));
    const replaced = await replaceContent(
      tx,
      dst,
      { blobId: src.blobId, size: src.size, mimeType: src.mimeType },
      { actorId, keepVersion: versionRetentionDays > 0 },
    );
    // Its bytes now belong to the target; the temporary file's row (and anything that pointed
    // at it) goes. They were counted once as the source and now count as the target.
    await tx.delete(nodes).where(eq(nodes.id, src.id));
    const delta = replaced.usageDelta - src.size;
    if (delta !== 0) {
      await tx
        .update(users)
        .set({ usedBytes: sql`greatest(${users.usedBytes} + ${delta}, 0)` })
        .where(eq(users.id, dst.ownerId));
    }
    return replaced.orphans;
  });
  await deleteBlobFiles(ctx, orphans);
}

/**
 * Deletes versions for good (the owner's choice, expiry, or making room): their rows, the
 * owners' usage, and blobs nothing else uses, then the bytes on disk.
 */
export async function deleteVersions(
  ctx: AppContext,
  ids: string[],
): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const removed = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
      const rows = (await tx.execute(sql`
        DELETE FROM file_versions v USING nodes n
        WHERE v.node_id = n.id AND v.id IN (${sql.join(
          batch.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        RETURNING v.blob_id AS "blobId", v.size, n.owner_id AS "ownerId"
      `)) as unknown as { blobId: string; size: number; ownerId: string }[];
      const perOwner = new Map<string, number>();
      for (const r of rows)
        perOwner.set(r.ownerId, (perOwner.get(r.ownerId) ?? 0) + Number(r.size));
      for (const [ownerId, total] of perOwner) {
        await tx
          .update(users)
          .set({ usedBytes: sql`greatest(${users.usedBytes} - ${total}, 0)` })
          .where(eq(users.id, ownerId));
      }
      const orphans = await deleteUnusedBlobs(
        tx,
        rows.map((r) => r.blobId),
      );
      return { rows, orphans };
    });
    await deleteBlobFiles(ctx, removed.orphans);
    count += removed.rows.length;
    bytes += removed.rows.reduce((s, r) => s + Number(r.size), 0);
  }
  return { count, bytes };
}

/** Deletes versions older than the retention period (all of them when versions are off). */
export async function purgeExpiredVersions(
  ctx: AppContext,
): Promise<{ count: number; bytes: number }> {
  const { versionRetentionDays } = await ctx.settings.get();
  const cutoff = new Date(Date.now() - versionRetentionDays * DAY_MS);
  let total = { count: 0, bytes: 0 };
  for (;;) {
    const rows = await ctx.db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(sql`${fileVersions.createdAt} < ${cutoff.toISOString()}::timestamptz`)
      .limit(1000);
    if (rows.length === 0) break;
    const r = await deleteVersions(
      ctx,
      rows.map((x) => x.id),
    );
    total = { count: total.count + r.count, bytes: total.bytes + r.bytes };
    if (rows.length < 1000 || r.count === 0) break;
  }
  if (total.count > 0) ctx.log.info(total, 'deleted expired file versions');
  return total;
}

/**
 * Deletes a person's oldest versions until `needed` more bytes fit in their quota. Versions are
 * a safety net, not something that should stop anyone from saving (Nextcloud does the same).
 * Returns whether anything was freed.
 */
export async function makeRoomFromVersions(
  ctx: AppContext,
  userId: string,
  needed: number,
): Promise<boolean> {
  const [u] = await ctx.db
    .select({ quota: users.quotaBytes, used: users.usedBytes, reserved: users.reservedBytes })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.quota === null) return false;
  const short = u.used + u.reserved + needed - u.quota;
  if (short <= 0) return true;
  const oldest = (await ctx.db.execute(sql`
    SELECT v.id, v.size FROM file_versions v JOIN nodes n ON n.id = v.node_id
    WHERE n.owner_id = ${userId}
    ORDER BY v.created_at, v.id
    LIMIT 5000
  `)) as unknown as { id: string; size: number }[];
  const pick: string[] = [];
  let freed = 0;
  for (const v of oldest) {
    if (freed >= short) break;
    pick.push(v.id);
    freed += Number(v.size);
  }
  if (freed < short) return false; // not enough to matter: leave them
  await deleteVersions(ctx, pick);
  ctx.log.info({ userId, versions: pick.length, bytes: freed }, 'freed quota from old versions');
  return true;
}

/**
 * Runs a transaction that reserves `size` bytes of `owner`'s storage. When their quota is full
 * and it's their own save, their oldest file versions make room first and it runs once more.
 * Someone else's upload (through a share or a file request) never clears the owner's history:
 * only the owner may delete versions.
 */
export async function withRoomFromVersions<T>(
  ctx: AppContext,
  who: { owner: string; actor: string | null },
  size: number,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== ErrorCode.QUOTA_EXCEEDED) throw err;
    if (who.actor !== who.owner) throw err;
    if (!(await makeRoomFromVersions(ctx, who.owner, size))) throw err;
    return run();
  }
}
