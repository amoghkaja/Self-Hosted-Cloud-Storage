import { eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { uploadSessions, users } from '../../db/schema';
import { deleteBlobFiles, deleteUnusedBlobs, QUOTA_LOCK } from '../files/tree';
import { releaseUpload } from '../uploads/service';

/**
 * Deletes an account and everything in it: files (live, trashed and older versions), shares
 * and links on them, their album folders, devices and sign-ins. Files they added to other
 * people's folders belong to those people and stay. Stored bytes go only when nothing else
 * points at them (an instant upload or a copy by someone else keeps them).
 */
export async function deleteAccount(
  ctx: AppContext,
  userId: string,
): Promise<{ files: number; bytes: number }> {
  // Their uploads still running into someone else's folder hold that person's space: give it back.
  const open = await ctx.db
    .select({ id: uploadSessions.id })
    .from(uploadSessions)
    .where(
      sql`${uploadSessions.userId} = ${userId} AND ${inArray(uploadSessions.status, ['uploading', 'finalizing'])}`,
    );
  for (const s of open) await releaseUpload(ctx, s.id, 'aborted');

  const removed = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
    const stored = (await tx.execute(sql`
      SELECT n.blob_id AS "blobId", n.size FROM nodes n
      WHERE n.owner_id = ${userId} AND n.blob_id IS NOT NULL
      UNION ALL
      SELECT v.blob_id, v.size FROM file_versions v JOIN nodes n ON n.id = v.node_id
      WHERE n.owner_id = ${userId}
    `)) as unknown as { blobId: string; size: number }[];
    // Everything that belongs to the account cascades from its row (see the schema's foreign keys).
    await tx.delete(users).where(eq(users.id, userId));
    const orphans = await deleteUnusedBlobs(
      tx,
      stored.map((r) => r.blobId),
    );
    return {
      orphans,
      files: stored.length,
      bytes: stored.reduce((s, r) => s + Number(r.size), 0),
    };
  });
  await deleteBlobFiles(ctx, removed.orphans);
  return { files: removed.files, bytes: removed.bytes };
}
