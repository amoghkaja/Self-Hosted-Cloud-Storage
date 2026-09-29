import { ErrorCode } from '@familycloud/shared/all';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AppContext } from '../../context';
import { blobs, type NodeRow, nodes, users } from '../../db/schema';
import { AppError, conflict } from '../../lib/errors';
import { reserveSpace } from '../uploads/service';
import { withRoomFromVersions } from '../versions/service';
import { lockWriteAccess } from './access';
import { listTree } from './serve';
import { insertNode } from './tree';

export const MAX_COPY_ENTRIES = 10_000;

export interface CopyInput {
  userId: string;
  source: Pick<NodeRow, 'id' | 'type' | 'name' | 'blobId' | 'size' | 'mimeType'>;
  dest: { id: string; ownerId: string };
  name: string;
  /** A name already taken in the destination: fail (WebDAV) or pick "name (1)". */
  onConflict: 'fail' | 'rename';
  /** Copy only the folder itself, not what's in it (WebDAV Depth: 0). */
  shallow?: boolean;
  /** The source folder's contents, when the caller already listed them (listTree). */
  tree?: Awaited<ReturnType<typeof listTree>>;
}

/**
 * Copies a file or a folder tree. The copies point at the same stored bytes (as an instant
 * upload does), so copying is immediate and uses no extra disk; each copy counts toward the
 * destination owner's storage like any other file of theirs, and the bytes are only deleted
 * once nothing points at them. Checks and the write happen in one transaction.
 */
export async function copyNode(ctx: AppContext, input: CopyInput): Promise<NodeRow> {
  const tree =
    input.source.type === 'folder' && !input.shallow
      ? (input.tree ?? (await listTree(ctx.db, input.source.id, MAX_COPY_ENTRIES + 1)))
      : [];
  if (tree.length > MAX_COPY_ENTRIES) {
    throw new AppError(
      413,
      ErrorCode.VALIDATION,
      `Too many items to copy at once (at most ${MAX_COPY_ENTRIES.toLocaleString('en')})`,
    );
  }
  const files =
    input.source.type === 'file'
      ? [{ blobId: input.source.blobId, size: input.source.size }]
      : tree
          .filter((e) => e.type === 'file')
          .map((e) => ({ blobId: e.blobId, size: Number(e.size) }));
  const blobIds = [...new Set(files.map((f) => f.blobId).filter((b): b is string => !!b))];
  const total = files.reduce((s, f) => s + f.size, 0);
  const settings = await ctx.settings.get();

  return withRoomFromVersions(ctx, { owner: input.dest.ownerId, actor: input.userId }, total, () =>
    ctx.db.transaction(async (tx) => {
      // The exclusive quota lock also keeps "empty trash" and version clean-ups (which take it
      // shared) from deleting the bytes we're about to point at until this commits.
      await reserveSpace(tx, settings, {
        chargeUserId: input.dest.ownerId,
        uploaderId: input.userId,
        size: total,
      });
      const target = await lockWriteAccess(tx, input.userId, input.dest.id);
      const present = new Set<string>();
      for (let i = 0; i < blobIds.length; i += 5000) {
        const rows = await tx
          .select({ id: blobs.id })
          .from(blobs)
          .where(inArray(blobs.id, blobIds.slice(i, i + 5000)));
        for (const r of rows) present.add(r.id);
      }
      if (files.some((f) => !f.blobId || !present.has(f.blobId))) {
        throw conflict('Some of these files were deleted meanwhile. Try again.');
      }

      const isFile = input.source.type === 'file';
      const root = await insertNode(
        tx,
        {
          ownerId: target.ownerId,
          parentId: target.id,
          type: input.source.type,
          name: input.name,
          blobId: isFile ? input.source.blobId : null,
          size: isFile ? input.source.size : 0,
          mimeType: isFile ? input.source.mimeType : null,
          createdBy: input.userId,
        },
        input.onConflict,
      );
      // Everything below goes into brand-new folders, so names can't clash: insert in bulk.
      // listTree returns parents before their children (paths sort that way).
      const folderIds = new Map<string, string>([['', root.id]]);
      const rows: (typeof nodes.$inferInsert)[] = [];
      for (const e of tree) {
        const slash = e.path.lastIndexOf('/');
        const parentId = folderIds.get(slash < 0 ? '' : e.path.slice(0, slash));
        if (!parentId) continue;
        const id = uuidv7();
        if (e.type === 'folder') folderIds.set(e.path, id);
        rows.push({
          id,
          ownerId: target.ownerId,
          parentId,
          type: e.type,
          name: slash < 0 ? e.path : e.path.slice(slash + 1),
          blobId: e.type === 'file' ? e.blobId : null,
          size: e.type === 'file' ? Number(e.size) : 0,
          mimeType: e.type === 'file' ? e.mimeType : null,
          createdBy: input.userId,
        });
      }
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.insert(nodes).values(rows.slice(i, i + 1000));
      }
      await tx
        .update(users)
        .set({
          usedBytes: sql`${users.usedBytes} + ${total}`,
          reservedBytes: sql`greatest(${users.reservedBytes} - ${total}, 0)`,
        })
        .where(eq(users.id, target.ownerId));
      await tx.update(nodes).set({ updatedAt: new Date() }).where(eq(nodes.id, target.id));
      return root;
    }),
  );
}
