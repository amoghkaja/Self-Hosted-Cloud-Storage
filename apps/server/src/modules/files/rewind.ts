import type { RewindPreview, RewindResult } from '@familycloud/shared/all';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { nodes } from '../../db/schema';
import { queueUnfinishedWork } from '../../jobs/derived';
import { AppError, badRequest } from '../../lib/errors';
import { DAY_MS } from '../../lib/time';
import { restoreVersion } from '../versions/service';
import { deleteBlobFiles, QUOTA_LOCK, restoreSubtree } from './tree';

interface Plan {
  /** Trash entries that were there then and deleted since, newest first, so a folder comes back
   *  before the files that were deleted from it earlier (and those then land back inside it). */
  restore: { id: string; name: string }[];
  /**
   * Per file, the version that held its contents then: saved by then and replaced since. A
   * rename bumps the time a version records as saved, never lowers it, so at worst a file
   * renamed and then saved over since keeps what it holds now; it never gets the wrong contents.
   */
  revert: { nodeId: string; versionId: string; name: string }[];
  added: number;
}

const MAX_ITEMS = 10_000;

/**
 * What rewinding a folder to `at` would do. Everything under it counts, including what's in the
 * trash now, since folder contents are found by parent even after deletion. Moves and renames
 * aren't recorded, so they stay as they are, and so do files added since.
 */
async function plan(exec: Executor, folderId: string, at: Date): Promise<Plan> {
  const when = at.toISOString();
  const sub = sql`
    WITH RECURSIVE sub AS (
      SELECT id, type FROM nodes WHERE id = ${folderId}
      UNION ALL
      SELECT n.id, n.type FROM nodes n JOIN sub s ON n.parent_id = s.id WHERE s.type = 'folder'
    )
  `;
  const restore = (await exec.execute(sql`
    ${sub}
    SELECT n.id, n.name FROM nodes n JOIN sub ON sub.id = n.id
    WHERE n.trash_root_id = n.id AND n.deleted_at > ${when}::timestamptz
      -- Something in the entry existed then: the item itself, or (moved into a folder made
      -- since) something inside it. Entries made wholly since stay in the trash.
      AND EXISTS (
        SELECT 1 FROM nodes d WHERE d.trash_root_id = n.id AND d.created_at <= ${when}::timestamptz
      )
    ORDER BY n.deleted_at DESC, n.id
    LIMIT ${MAX_ITEMS}
  `)) as unknown as Plan['restore'];
  // Files that existed then and are (or are about to be) back: everything deleted after `at`
  // under this folder belongs to a trash entry restored above.
  const revert = (await exec.execute(sql`
    ${sub}
    SELECT DISTINCT ON (v.node_id) v.node_id AS "nodeId", v.id AS "versionId", n.name
    FROM file_versions v JOIN nodes n ON n.id = v.node_id JOIN sub ON sub.id = n.id
    WHERE n.created_at <= ${when}::timestamptz
      AND (n.deleted_at IS NULL OR n.deleted_at > ${when}::timestamptz)
      AND v.modified_at <= ${when}::timestamptz AND v.created_at > ${when}::timestamptz
    ORDER BY v.node_id, v.modified_at DESC, v.id
    LIMIT ${MAX_ITEMS}
  `)) as unknown as Plan['revert'];
  const [added] = (await exec.execute(sql`
    ${sub}
    SELECT count(*)::int AS count FROM nodes n JOIN sub ON sub.id = n.id
    WHERE n.type = 'file' AND n.deleted_at IS NULL AND n.created_at > ${when}::timestamptz
  `)) as unknown as { count: number }[];
  return { restore, revert, added: added?.count ?? 0 };
}

/** How far back a folder can go: as far as the trash keeps what was deleted. */
export async function checkRewindTime(ctx: AppContext, at: Date) {
  const { trashRetentionDays } = await ctx.settings.get();
  if (at.getTime() >= Date.now()) {
    throw badRequest('Pick a moment in the past');
  }
  if (at.getTime() < Date.now() - trashRetentionDays * DAY_MS) {
    throw badRequest(
      `A folder can go back at most ${trashRetentionDays} days, as long as the trash keeps things`,
    );
  }
}

export async function previewRewind(
  ctx: AppContext,
  folderId: string,
  at: Date,
): Promise<RewindPreview> {
  const p = await plan(ctx.db, folderId, at);
  const names = (list: { name: string }[]) => list.slice(0, 5).map((x) => x.name);
  return {
    restore: { count: p.restore.length, names: names(p.restore) },
    revert: { count: p.revert.length, names: names(p.revert) },
    added: p.added,
  };
}

/**
 * Puts a folder back as it was at `at`: what was deleted since comes out of the trash, and files
 * saved over since get back what they held. Each step can be undone (restored items can be
 * deleted again; what files held until now becomes a version), so it runs one item at a time
 * rather than in one long transaction that would hold the quota lock.
 */
export async function rewindFolder(
  ctx: AppContext,
  owner: { id: string; rootNodeId: string | null },
  folderId: string,
  at: Date,
): Promise<RewindResult> {
  const p = await plan(ctx.db, folderId, at);
  let restored = 0;
  for (const r of p.restore) {
    try {
      await ctx.db.transaction((tx) => restoreSubtree(tx, owner, r.id));
      restored++;
    } catch (err) {
      // Emptied from the trash, or put back by hand, in the meantime.
      if (!(err instanceof AppError) || err.status !== 404) throw err;
    }
  }
  let reverted = 0;
  for (const v of p.revert) {
    const result = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
      const [file] = await tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, v.nodeId), isNull(nodes.deletedAt)))
        .for('update');
      if (!file) return null;
      try {
        return await restoreVersion(tx, file, v.versionId, owner.id);
      } catch (err) {
        // The version expired or was deleted in the meantime.
        if (err instanceof AppError && err.status === 404) return null;
        throw err;
      }
    });
    if (!result) continue;
    await deleteBlobFiles(ctx, result.orphans);
    await queueUnfinishedWork(ctx, result.blob);
    reverted++;
  }
  return { restored, reverted, added: p.added };
}
