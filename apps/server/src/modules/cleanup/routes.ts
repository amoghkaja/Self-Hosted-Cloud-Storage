import { type CleanupFile, CleanupReport, Freed } from '@familycloud/shared/all';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Executor } from '../../db/client';
import { type BlobRow, blobs, type NodeRow, nodes } from '../../db/schema';
import { audit } from '../../lib/audit';
import { toFileNode } from '../../lib/dto';
import { requireUser } from '../../plugins/auth';
import { deleteVersions } from '../versions/service';

const LIST = 50;
/** Copies listed per group of duplicates; the count says how many there are in all. */
const COPIES = 20;

type Row = {
  node: NodeRow;
  thumb: BlobRow['thumbStatus'] | null;
  scan: BlobRow['scanStatus'] | null;
};

/** "Trips / 2026-08 Goa" for each node, from just below the owner's root. */
async function folderNames(exec: Executor, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await exec.execute(sql`
    WITH RECURSIVE up AS (
      SELECT n.id AS start, n.parent_id AS pid, 0 AS depth, NULL::text AS name
      FROM nodes n WHERE n.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      UNION ALL
      SELECT up.start, p.parent_id, up.depth + 1, p.name
      FROM up JOIN nodes p ON p.id = up.pid
      WHERE up.depth < 512
    )
    SELECT start AS id,
           coalesce(string_agg(name, ' / ' ORDER BY depth DESC)
                    FILTER (WHERE name IS NOT NULL AND pid IS NOT NULL), '') AS folder
    FROM up GROUP BY start
  `)) as unknown as { id: string; folder: string }[];
  return new Map(rows.map((r) => [r.id, r.folder]));
}

/**
 * "Free up space": what takes up a person's storage and what they could let go of. Only their
 * own files: what others share with them counts toward the sharer's space, not theirs.
 */
export const cleanupRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  const ownFiles = (userId: string) =>
    and(
      eq(nodes.ownerId, userId),
      eq(nodes.type, 'file'),
      isNull(nodes.deletedAt),
      gt(nodes.size, 0),
    );
  const fileRow = { node: nodes, thumb: blobs.thumbStatus, scan: blobs.scanStatus };

  app.get('/cleanup', { schema: { response: { 200: CleanupReport } } }, async (req) => {
    const { user } = requireUser(req);
    const largest: Row[] = await db
      .select(fileRow)
      .from(nodes)
      .leftJoin(blobs, eq(blobs.id, nodes.blobId))
      .where(ownFiles(user.id))
      .orderBy(sql`${nodes.size} DESC`, nodes.id)
      .limit(LIST);

    // The same bytes, by checksum (or the same stored blob before it has been checksummed: copies
    // and instant uploads share one). The copies that cost the most come first.
    const groups = (await db.execute(sql`
      SELECT min(n.size)::bigint AS size, count(*)::int AS count,
             (array_agg(n.id ORDER BY n.created_at, n.id))[1:${sql.raw(String(COPIES))}] AS ids
      FROM nodes n JOIN blobs b ON b.id = n.blob_id
      WHERE n.owner_id = ${user.id} AND n.type = 'file' AND n.deleted_at IS NULL AND n.size > 0
      GROUP BY coalesce(b.sha256, b.id::text)
      HAVING count(*) > 1
      ORDER BY min(n.size) * (count(*) - 1) DESC
      LIMIT ${LIST}
    `)) as unknown as { size: number; count: number; ids: string[] }[];
    const copyIds = groups.flatMap((g) => g.ids);
    const copies: Row[] = copyIds.length
      ? await db
          .select(fileRow)
          .from(nodes)
          .leftJoin(blobs, eq(blobs.id, nodes.blobId))
          .where(inArray(nodes.id, copyIds))
      : [];

    const [versionTotals] = (await db.execute(sql`
      SELECT count(*)::int AS count, coalesce(sum(v.size), 0)::bigint AS bytes
      FROM file_versions v JOIN nodes n ON n.id = v.node_id
      WHERE n.owner_id = ${user.id}
    `)) as unknown as { count: number; bytes: number }[];
    const versioned = (await db.execute(sql`
      SELECT v.node_id AS id, count(*)::int AS count, sum(v.size)::bigint AS bytes
      FROM file_versions v JOIN nodes n ON n.id = v.node_id
      WHERE n.owner_id = ${user.id} AND n.deleted_at IS NULL
      GROUP BY v.node_id
      ORDER BY sum(v.size) DESC
      LIMIT ${LIST}
    `)) as unknown as { id: string; count: number; bytes: number }[];
    const versionedFiles: Row[] = versioned.length
      ? await db
          .select(fileRow)
          .from(nodes)
          .leftJoin(blobs, eq(blobs.id, nodes.blobId))
          .where(
            inArray(
              nodes.id,
              versioned.map((v) => v.id),
            ),
          )
      : [];

    const [trash] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE trash_root_id = id)::int AS count,
             coalesce(sum(size) FILTER (WHERE type = 'file'), 0)::bigint AS bytes
      FROM nodes WHERE owner_id = ${user.id} AND deleted_at IS NOT NULL
    `)) as unknown as { count: number; bytes: number }[];

    const folders = await folderNames(db, [
      ...new Set([...largest, ...copies, ...versionedFiles].map((r) => r.node.id)),
    ]);
    const dto = (r: Row): CleanupFile => ({
      ...toFileNode({ ...r.node, thumb: r.thumb, scan: r.scan }),
      folder: folders.get(r.node.id) ?? '',
    });
    const byId = (rows: Row[]) => new Map(rows.map((r) => [r.node.id, r]));
    const copyRows = byId(copies);
    const versionRows = byId(versionedFiles);

    return {
      largest: largest.map(dto),
      duplicates: groups.map((g) => ({
        size: Number(g.size),
        count: g.count,
        files: g.ids.flatMap((id) => {
          const r = copyRows.get(id);
          return r ? [dto(r)] : [];
        }),
      })),
      versions: {
        count: versionTotals?.count ?? 0,
        bytes: Number(versionTotals?.bytes ?? 0),
        files: versioned.flatMap((v) => {
          const r = versionRows.get(v.id);
          return r ? [{ file: dto(r), count: v.count, bytes: Number(v.bytes) }] : [];
        }),
      },
      trash: { count: trash?.count ?? 0, bytes: Number(trash?.bytes ?? 0) },
    };
  });

  /** Deletes every older version of the caller's own files for good. */
  app.delete('/cleanup/versions', { schema: { response: { 200: Freed } } }, async (req) => {
    const { user } = requireUser(req);
    const rows = (await db.execute(sql`
      SELECT v.id FROM file_versions v JOIN nodes n ON n.id = v.node_id
      WHERE n.owner_id = ${user.id}
    `)) as unknown as { id: string }[];
    const freed = await deleteVersions(
      ctx,
      rows.map((r) => r.id),
    );
    await audit(db, {
      actorId: user.id,
      action: 'file.all_versions_deleted',
      targetType: 'user',
      targetId: user.id,
      ip: req.clientIp,
      meta: freed,
    });
    return freed;
  });
};
