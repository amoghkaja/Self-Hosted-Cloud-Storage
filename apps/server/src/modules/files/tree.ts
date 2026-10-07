import { unlink } from 'node:fs/promises';
import {
  type ChildrenQuery,
  ErrorCode,
  Id,
  type NodePage,
  withCopySuffix,
} from '@familycloud/shared/all';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { blobs, type NodeRow, nodes, users } from '../../db/schema';
import { toFileNode } from '../../lib/dto';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../lib/errors';
import { derivedPaths } from '../../storage/thumbs';
import { lockWriteAccess } from './access';

/** Advisory lock guarding usage counters: exclusive for sum checks/reconcile, shared otherwise. */
export const QUOTA_LOCK = 727_002;

// ── listing ─────────────────────────────────────────────────────────────────

/**
 * Name order for listings: case-insensitive with numbers compared by value, like Finder and
 * Explorer ("IMG_2" before "IMG_10"). Matches nodes_children_idx; the collation is created by
 * migration 0003.
 */
export const nameSortKey = sql`(lower(${nodes.name}) COLLATE "natural")`;

type Cursor = [type: 'folder' | 'file', key: string | number, id: string];

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

/** Whether a cursor's key is one `sort` produces: anything else would fail in Postgres (500). */
function keyFits(sort: ChildrenQuery['sort'], k: unknown): boolean {
  if (sort === 'size') return Number.isSafeInteger(k);
  if (typeof k !== 'string') return false;
  if (sort === 'updated') return !Number.isNaN(Date.parse(k)) && new Date(k).toISOString() === k;
  return !k.includes('\u0000');
}

function decodeCursor(raw: string, sort: ChildrenQuery['sort']): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(c) &&
      c.length === 3 &&
      (c[0] === 'folder' || c[0] === 'file') &&
      keyFits(sort, c[1]) &&
      Id.safeParse(c[2]).success
    ) {
      return c as Cursor;
    }
  } catch {}
  throw badRequest('Invalid cursor');
}

/**
 * Keyset-paginated folder listing: folders first, then the chosen sort key, then id as a
 * tie-breaker. Stable under concurrent inserts and O(limit) regardless of folder size.
 */
export async function listChildren(
  exec: Executor,
  folderId: string,
  q: ChildrenQuery,
): Promise<NodePage> {
  const key: SQL =
    q.sort === 'name'
      ? nameSortKey
      : q.sort === 'updated'
        ? sql`date_trunc('milliseconds', ${nodes.updatedAt})`
        : sql`${nodes.size}`;
  const cmp = sql.raw(q.dir === 'asc' ? '>' : '<');
  const dir = sql.raw(q.dir === 'asc' ? 'asc' : 'desc');

  const conditions: SQL[] = [eq(nodes.parentId, folderId), isNull(nodes.deletedAt)];
  if (q.cursor) {
    const [t, k, id] = decodeCursor(q.cursor, q.sort);
    const kv =
      q.sort === 'updated'
        ? sql`${String(k)}::timestamptz`
        : q.sort === 'size'
          ? sql`${Number(k)}::bigint`
          : sql`${String(k)}`;
    conditions.push(sql`(
      ${nodes.type} > ${t}::node_type
      OR (${nodes.type} = ${t}::node_type AND (${key} ${cmp} ${kv} OR (${key} = ${kv} AND ${nodes.id} ${cmp} ${id})))
    )`);
  }

  const rows = await exec
    .select({
      node: nodes,
      thumb: blobs.thumbStatus,
      scan: blobs.scanStatus,
      nameKey: sql<string>`lower(${nodes.name})`,
    })
    .from(nodes)
    .leftJoin(blobs, eq(blobs.id, nodes.blobId))
    .where(and(...conditions))
    .orderBy(sql`${nodes.type} asc`, sql`${key} ${dir}`, sql`${nodes.id} ${dir}`)
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (rows.length > q.limit && last) {
    const n = last.node;
    // The name key comes from Postgres: JS toLowerCase() differs from lower() for some letters,
    // which would skip or repeat rows at a page boundary.
    const k =
      q.sort === 'name' ? last.nameKey : q.sort === 'updated' ? n.updatedAt.toISOString() : n.size;
    nextCursor = encodeCursor([n.type, k, n.id]);
  }
  return {
    items: page.map((r) => toFileNode({ ...r.node, thumb: r.thumb, scan: r.scan })),
    nextCursor,
  };
}

// ── naming ──────────────────────────────────────────────────────────────────

/** First free name among "name", "name (1)", "name (2)"… in a folder (case-insensitive). */
export async function findFreeName(
  exec: Executor,
  parentId: string,
  name: string,
  label?: string,
): Promise<string> {
  const candidates = [
    name,
    ...Array.from({ length: 50 }, (_, i) => withCopySuffix(name, i + 1, label)),
  ];
  // Compared with Postgres's lower(), like the unique index: JS toLowerCase() differs for some
  // letters ("ΔΙΑΚΟΠΕΣ" ends in ς, "İ" gains a dot), which would pick a name that's taken.
  const [free] = (await exec.execute(sql`
    SELECT c.name FROM (VALUES ${sql.join(
      candidates.map((c, i) => sql`(${c}::text, ${i}::int)`),
      sql`, `,
    )}) AS c(name, i)
    WHERE NOT EXISTS (
      SELECT 1 FROM nodes n
      WHERE n.parent_id = ${parentId} AND n.deleted_at IS NULL AND lower(n.name) = lower(c.name)
    )
    ORDER BY c.i
    LIMIT 1
  `)) as unknown as { name: string }[];
  if (!free) throw conflict(`Too many items named "${name}"`, ErrorCode.NAME_CONFLICT);
  return free.name;
}

/**
 * Inserts a node, resolving name clashes per `mode`:
 * - rename: pick "name (n)" (uploads)
 * - reuse: return the existing folder of that name (folder uploads)
 * - fail: 409 NAME_CONFLICT (new folder)
 */
export async function insertNode(
  exec: Executor,
  values: typeof nodes.$inferInsert & { parentId: string },
  mode: 'rename' | 'reuse' | 'fail',
): Promise<NodeRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const name =
      mode === 'rename' ? await findFreeName(exec, values.parentId, values.name) : values.name;
    const [row] = await exec
      .insert(nodes)
      .values({ ...values, name })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    if (mode === 'reuse') {
      const [existing] = await exec
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.parentId, values.parentId),
            isNull(nodes.deletedAt),
            sql`lower(${nodes.name}) = lower(${values.name})`,
          ),
        );
      if (existing?.type === values.type) return existing;
    }
    if (mode !== 'rename') {
      throw conflict(`An item named "${values.name}" already exists here`, ErrorCode.NAME_CONFLICT);
    }
  }
  throw conflict('Could not find a free name, please try again', ErrorCode.NAME_CONFLICT);
}

// ── rename / move ───────────────────────────────────────────────────────────

export async function isAncestor(
  exec: Executor,
  ancestorId: string,
  nodeId: string,
): Promise<boolean> {
  const rows = (await exec.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = ${nodeId}
      UNION ALL
      SELECT n.id, n.parent_id, u.depth + 1 FROM nodes n JOIN up u ON n.id = u.parent_id WHERE u.depth < 512
    )
    SELECT 1 FROM up WHERE id = ${ancestorId} LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Renames and/or moves a live node; with `inFolder`, only while it is still in that folder. */
export async function updateNode(
  exec: Executor,
  nodeId: string,
  patch: { name?: string; parentId?: string },
  inFolder?: string,
): Promise<NodeRow> {
  try {
    const [row] = await exec
      .update(nodes)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(nodes.id, nodeId),
          isNull(nodes.deletedAt),
          inFolder ? eq(nodes.parentId, inFolder) : undefined,
        ),
      )
      .returning();
    if (!row) throw notFound();
    return row;
  } catch (err) {
    if (isUniqueViolation(err, 'nodes_parent_name_key')) {
      throw conflict('An item with that name already exists there', ErrorCode.NAME_CONFLICT);
    }
    throw err;
  }
}

/**
 * Renames and/or moves a node. Moves are serialized per tree owner and re-check the target
 * under that lock: two concurrent moves (A into B, B into A) could otherwise both pass the
 * cycle check and detach both folders from the tree. The target is share-locked so a
 * concurrent trash of it waits and then takes the moved node along. `replaceId` (WebDAV MOVE
 * with Overwrite) is trashed in the same transaction, so a failed move leaves it in place.
 * When someone else's item is changed through a share (`actorId`), their edit access to the
 * folders involved is re-checked under lock, so a share revoked meanwhile stops the change.
 */
export async function moveNode(
  exec: Executor,
  node: { id: string; ownerId: string; parentId: string | null },
  patch: { name?: string; parentId?: string },
  opts: { replaceId?: string; actorId?: string } = {},
): Promise<NodeRow> {
  const grantee = opts.actorId && opts.actorId !== node.ownerId ? opts.actorId : null;
  return exec.transaction(async (tx) => {
    if (patch.parentId !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`move:${node.ownerId}`}))`);
      // The folder it leaves is locked too: a trash of that folder then waits and leaves the
      // item out, instead of trashing it in its new place. In id order, as trashSubtree locks
      // folders, and at the strength lockWriteAccess takes below, so it never needs upgrading.
      const folders = await tx
        .select({
          id: nodes.id,
          ownerId: nodes.ownerId,
          type: nodes.type,
          deletedAt: nodes.deletedAt,
        })
        .from(nodes)
        .where(
          inArray(nodes.id, node.parentId ? [patch.parentId, node.parentId] : [patch.parentId]),
        )
        .orderBy(nodes.id)
        .for(grantee ? 'no key update' : 'share');
      const target = folders.find((f) => f.id === patch.parentId);
      if (!target || target.deletedAt || target.type !== 'folder') throw notFound('Folder');
      if (target.ownerId !== node.ownerId) {
        throw new AppError(
          400,
          ErrorCode.INVALID_MOVE,
          "Items can only be moved within the same person's files",
        );
      }
      if (target.id === node.id || (await isAncestor(tx, node.id, target.id))) {
        throw new AppError(400, ErrorCode.INVALID_MOVE, 'A folder cannot be moved into itself');
      }
      if (grantee) await lockWriteAccess(tx, grantee, target.id);
    }
    if (grantee && node.parentId) await lockWriteAccess(tx, grantee, node.parentId);
    if (opts.replaceId) await trashSubtree(tx, opts.replaceId);
    // The folder just re-checked must still be the item's: if the owner moved it meanwhile
    // (perhaps somewhere private), the grantee's change must not follow it there.
    return updateNode(tx, node.id, patch, grantee ? (node.parentId ?? undefined) : undefined);
  });
}

// ── trash ───────────────────────────────────────────────────────────────────

/**
 * Moves a node and its live descendants to the trash as one restorable unit, and revokes every
 * public link into it for good: deleting something must end its links at once, and restoring it
 * doesn't bring them back (share again if that's wanted).
 * The subtree's folders are locked first: an upload committing into one of them holds that
 * folder (lockWriteAccess), so it finishes before the trash, and the UPDATE (a new statement,
 * with a fresh snapshot) then takes its file along instead of leaving it live in a trashed
 * folder.
 */
export async function trashSubtree(
  exec: Executor,
  nodeId: string,
  opts: { actorId?: string } = {},
): Promise<void> {
  const subtree = sql`
    WITH RECURSIVE sub AS (
      SELECT id FROM nodes WHERE id = ${nodeId} AND deleted_at IS NULL
      UNION ALL
      SELECT n.id FROM nodes n JOIN sub s ON n.parent_id = s.id WHERE n.deleted_at IS NULL
    )
    SELECT id FROM sub
  `;
  await exec.transaction(async (tx) => {
    if (opts.actorId) {
      // Through a share: the edit access to the item's folder must still hold (see moveNode).
      const [item] = await tx
        .select({ ownerId: nodes.ownerId, parentId: nodes.parentId })
        .from(nodes)
        .where(eq(nodes.id, nodeId));
      if (item?.parentId && item.ownerId !== opts.actorId) {
        await lockWriteAccess(tx, opts.actorId, item.parentId);
      }
    }
    await tx.execute(sql`
      SELECT id FROM nodes WHERE type = 'folder' AND id IN (${subtree})
      ORDER BY id FOR NO KEY UPDATE
    `);
    await tx.execute(sql`
      UPDATE share_links SET revoked_at = now()
      WHERE revoked_at IS NULL AND node_id IN (${subtree})
    `);
    await tx.execute(sql`
      UPDATE nodes SET deleted_at = now(), trash_root_id = ${nodeId}
      WHERE id IN (${subtree}) AND deleted_at IS NULL
    `);
  });
}

/** Restores a trashed unit into its original folder, or the owner's root if that folder is gone. */
export async function restoreSubtree(
  exec: Executor,
  owner: { id: string; rootNodeId: string | null },
  rootId: string,
): Promise<NodeRow> {
  const [root] = await exec
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, rootId),
        eq(nodes.ownerId, owner.id),
        eq(nodes.trashRootId, rootId),
        sql`${nodes.deletedAt} IS NOT NULL`,
      ),
    )
    .for('update');
  if (!root) throw notFound('Trash item');
  let parentId = owner.rootNodeId!;
  if (root.parentId) {
    // Locked: a trash of that folder under way finishes first (so this goes to the root), or
    // waits and takes the restored item along. Never a live item in a trashed folder.
    const [parent] = await exec
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, root.parentId), isNull(nodes.deletedAt)))
      .for('share');
    if (parent) parentId = parent.id;
  }
  const name = await findFreeName(exec, parentId, root.name, 'restored');
  await exec.update(nodes).set({ parentId, name }).where(eq(nodes.id, rootId));
  await exec
    .update(nodes)
    .set({ deletedAt: null, trashRootId: null })
    .where(eq(nodes.trashRootId, rootId));
  const [restored] = await exec.select().from(nodes).where(eq(nodes.id, rootId));
  return restored!;
}

/**
 * Permanently deletes trashed units: rows (cascading to descendants, shares and links), blob
 * rows, usage counters, then the bytes on disk and cached thumbnails.
 */
export async function purgeTrashRoots(
  ctx: AppContext,
  rootIds: string[],
  ownerId?: string,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const rootId of rootIds) {
    const removed = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
      const [root] = await tx
        .select({ id: nodes.id, ownerId: nodes.ownerId })
        .from(nodes)
        .where(
          and(
            eq(nodes.id, rootId),
            eq(nodes.trashRootId, rootId),
            sql`${nodes.deletedAt} IS NOT NULL`,
            ownerId ? eq(nodes.ownerId, ownerId) : undefined,
          ),
        )
        .for('update');
      if (!root) return null;
      // The unit, stopping at items that were trashed on their own before this folder was:
      // those are separate trash entries.
      const unit = sql`
        WITH RECURSIVE sub AS (
          SELECT id, type, blob_id, size FROM nodes WHERE id = ${rootId}
          UNION ALL
          SELECT n.id, n.type, n.blob_id, n.size FROM nodes n JOIN sub s ON n.parent_id = s.id
          WHERE n.trash_root_id IS DISTINCT FROM n.id
        )
      `;
      // Keep those entries restorable instead of letting the cascade delete them with this
      // unit: they move to the owner's root, which is where restoring them leads anyway.
      await tx.execute(sql`
        ${unit}
        UPDATE nodes SET parent_id = (SELECT root_node_id FROM users WHERE id = ${root.ownerId})
        WHERE trash_root_id = id AND id <> ${rootId} AND parent_id IN (SELECT id FROM sub)
      `);
      const fileRows = (await tx.execute(sql`
        ${unit}
        SELECT blob_id AS "blobId", size FROM sub WHERE type = 'file' AND blob_id IS NOT NULL
        UNION ALL
        SELECT v.blob_id, v.size FROM file_versions v JOIN sub ON sub.id = v.node_id
      `)) as unknown as { blobId: string; size: number }[];
      // Deleting the unit's root cascades to everything below it and to their versions.
      await tx.delete(nodes).where(eq(nodes.id, rootId));
      const deleted: { id: string; volumeId: string }[] = [];
      const ids = fileRows.map((f) => f.blobId);
      for (let i = 0; i < ids.length; i += 5000) {
        deleted.push(
          ...(await tx
            .delete(blobs)
            .where(and(inArray(blobs.id, ids.slice(i, i + 5000)), blobUnused))
            .returning({ id: blobs.id, volumeId: blobs.volumeId })),
        );
      }
      const total = fileRows.reduce((sum, f) => sum + Number(f.size), 0);
      if (total > 0) {
        await tx
          .update(users)
          .set({ usedBytes: sql`greatest(${users.usedBytes} - ${total}, 0)` })
          .where(eq(users.id, root.ownerId));
      }
      return { deleted, total };
    });
    if (!removed) continue;
    files += removed.deleted.length;
    bytes += removed.total;
    await deleteBlobFiles(ctx, removed.deleted);
  }
  return { files, bytes };
}

/**
 * Stored bytes can back several files (instant uploads of a file someone already has) and older
 * versions of files, so they are only deleted once nothing points at them any more.
 */
export const blobUnused = sql`(NOT EXISTS (SELECT 1 FROM nodes WHERE nodes.blob_id = ${blobs.id})
  AND NOT EXISTS (SELECT 1 FROM file_versions WHERE file_versions.blob_id = ${blobs.id}))`;

export async function deleteBlobFiles(ctx: AppContext, list: { id: string; volumeId: string }[]) {
  for (const b of list) {
    const file = await ctx.volumes.blobFile(b).catch(() => null);
    const targets = [...(file ? [file] : []), ...derivedPaths(ctx.config.cacheDir, b.id)];
    await Promise.all(targets.map((t) => unlink(t).catch(() => {})));
  }
}
