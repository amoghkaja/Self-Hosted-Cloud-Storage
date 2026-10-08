import {
  ChildrenQuery,
  ContentQuery,
  CopyNodeBody,
  CreateFolderBody,
  ErrorCode,
  FileNode,
  IdParams,
  NameCheckBody,
  NameCheckResult,
  NodeDetail,
  NodePage,
  Ok,
  RecentQuery,
  RestoreResult,
  RewindBody,
  RewindPreview,
  RewindQuery,
  RewindResult,
  SearchHit,
  SearchQuery,
  ThumbQuery,
  TrashList,
  UpdateNodeBody,
  ZipQuery,
} from '@familycloud/shared/all';
import { and, desc, eq, inArray, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { albumFolders, albums, blobs, blobTexts, nodes, stars, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { toFileNode } from '../../lib/dto';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { HEADLINE, HEADLINE_CHARS, wordQuery } from '../../lib/search';
import { toIso } from '../../lib/time';
import { requireUser } from '../../plugins/auth';
import { loadAccess, requireAccess, requireFolder, satisfies } from './access';
import { copyNode } from './copy';
import { checkRewindTime, previewRewind, rewindFolder } from './rewind';
import {
  sendBlob,
  sendOfficePreview,
  sendThumbnail,
  sendVideoStream,
  sendZip,
  type ZipRoot,
} from './serve';
import {
  createFolder,
  findFreeName,
  isAncestor,
  listChildren,
  moveNode,
  purgeTrashRoots,
  restoreSubtree,
  trashSubtree,
} from './tree';

/** Ids of everything shared with a person: the shared items and all that's inside them. */
const sharedWith = (userId: string) => sql`(
  WITH RECURSIVE shared AS (
    SELECT n.id, n.type FROM shares s JOIN nodes n ON n.id = s.node_id
    WHERE s.grantee_id = ${userId} AND n.deleted_at IS NULL
    UNION
    SELECT c.id, c.type FROM nodes c JOIN shared p ON c.parent_id = p.id
    WHERE p.type = 'folder' AND c.deleted_at IS NULL
  )
  SELECT id FROM shared
)`;

export const fileRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  app.get(
    '/nodes/:id',
    { schema: { params: IdParams, response: { 200: NodeDetail } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await requireAccess(db, user.id, req.params.id, 'view');
      const [[owner], [album]] = await Promise.all([
        db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, a.node.ownerId)),
        db
          .select({ id: albums.id, title: albums.title })
          .from(albumFolders)
          .innerJoin(albums, eq(albums.id, albumFolders.albumId))
          .where(eq(albumFolders.folderId, a.node.id)),
      ]);
      return {
        node: toFileNode(a.node),
        access: a.access,
        owner: owner!,
        breadcrumbs: a.breadcrumbs,
        isRoot: a.isRoot,
        album: album ?? null,
      };
    },
  );

  app.get(
    '/nodes/:id/children',
    { schema: { params: IdParams, querystring: ChildrenQuery, response: { 200: NodePage } } },
    async (req) => {
      const { user } = requireUser(req);
      await requireFolder(db, user.id, req.params.id, 'view');
      return listChildren(db, req.params.id, req.query);
    },
  );

  // Which of these names a folder already has, so uploads can ask "replace or keep both?".
  app.post(
    '/nodes/:id/name-check',
    { schema: { params: IdParams, body: NameCheckBody, response: { 200: NameCheckResult } } },
    async (req) => {
      const { user } = requireUser(req);
      await requireFolder(db, user.id, req.params.id, 'view');
      // Lowercased by Postgres, as the folder's unique names are (see findFreeName).
      const wanted = sql.join(
        [...new Set(req.body.names)].map((n) => sql`lower(${n})`),
        sql`, `,
      );
      const rows = await db
        .select({ name: nodes.name, type: nodes.type })
        .from(nodes)
        .where(
          and(
            eq(nodes.parentId, req.params.id),
            isNull(nodes.deletedAt),
            sql`lower(${nodes.name}) IN (${wanted})`,
          ),
        );
      return {
        files: rows.filter((r) => r.type === 'file').map((r) => r.name),
        folders: rows.filter((r) => r.type === 'folder').map((r) => r.name),
        versionRetentionDays: (await ctx.settings.get()).versionRetentionDays,
      };
    },
  );

  app.post(
    '/folders',
    { schema: { body: CreateFolderBody, response: { 200: FileNode } } },
    async (req) => {
      const { user } = requireUser(req);
      const parent = await requireFolder(db, user.id, req.body.parentId, 'edit');
      const row = await createFolder(
        db,
        user.id,
        parent.node.id,
        req.body.name,
        req.body.reuseExisting ? 'reuse' : req.body.renameIfTaken ? 'rename' : 'fail',
      );
      return toFileNode(row);
    },
  );

  // "Make a copy" / "Copy to…": instant, the copy shares the stored bytes (see copyNode).
  app.post(
    '/nodes/:id/copy',
    { schema: { params: IdParams, body: CopyNodeBody, response: { 200: FileNode } } },
    async (req) => {
      const { user } = requireUser(req);
      const src = await requireAccess(db, user.id, req.params.id, 'view');
      if (src.isRoot) throw badRequest('Pick the folders or files to copy');
      const dest = await requireFolder(db, user.id, req.body.parentId, 'edit');
      if (
        src.node.type === 'folder' &&
        (dest.node.id === src.node.id || (await isAncestor(db, src.node.id, dest.node.id)))
      ) {
        throw new AppError(400, ErrorCode.INVALID_MOVE, 'A folder cannot be copied into itself');
      }
      const name =
        req.body.name ??
        (dest.node.id === src.node.parentId
          ? await findFreeName(db, dest.node.id, src.node.name, 'copy')
          : src.node.name);
      const row = await copyNode(ctx, {
        userId: user.id,
        source: src.node,
        dest: { id: dest.node.id, ownerId: dest.node.ownerId },
        name,
        onConflict: 'rename',
      });
      return toFileNode({ ...row, thumb: src.node.type === 'file' ? src.node.thumb : null });
    },
  );

  app.patch(
    '/nodes/:id',
    { schema: { params: IdParams, body: UpdateNodeBody, response: { 200: FileNode } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await requireAccess(db, user.id, req.params.id, 'view');
      if (a.isRoot) throw forbidden('Your top-level folder cannot be renamed or moved');
      // Changing where/how an item appears in a folder is an edit of that folder.
      if (!satisfies(a.parentAccess, 'edit')) throw forbidden();

      const patch: { name?: string; parentId?: string } = {};
      if (req.body.name !== undefined && req.body.name !== a.node.name) patch.name = req.body.name;
      if (req.body.parentId !== undefined && req.body.parentId !== a.node.parentId) {
        const target = await requireFolder(db, user.id, req.body.parentId, 'edit');
        if (target.node.ownerId !== a.node.ownerId) {
          throw new AppError(
            400,
            ErrorCode.INVALID_MOVE,
            "Items can only be moved within the same person's files",
          );
        }
        if (target.node.id === a.node.id || (await isAncestor(db, a.node.id, target.node.id))) {
          throw new AppError(400, ErrorCode.INVALID_MOVE, 'A folder cannot be moved into itself');
        }
        patch.parentId = target.node.id;
      }
      if (Object.keys(patch).length === 0) return toFileNode(a.node);
      const row = await moveNode(db, a.node, patch, { actorId: user.id });
      return toFileNode({ ...row, thumb: a.node.thumb });
    },
  );

  app.delete('/nodes/:id', { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    const { user } = requireUser(req);
    const a = await requireAccess(db, user.id, req.params.id, 'view');
    if (a.isRoot) throw forbidden('Your top-level folder cannot be deleted');
    if (!satisfies(a.parentAccess, 'edit')) throw forbidden();
    await trashSubtree(db, a.node.id, { actorId: user.id });
    return { ok: true as const };
  });

  // Your own files and everything family members share with you (not other people's private
  // files, and not the trash): by name, then by the words inside documents.
  app.get(
    '/search',
    {
      schema: {
        querystring: SearchQuery,
        response: { 200: z.object({ items: z.array(SearchHit) }) },
      },
    },
    async (req) => {
      const { user } = requireUser(req);
      const { limit } = req.query;
      const visible = and(
        isNull(nodes.deletedAt),
        sql`${nodes.parentId} IS NOT NULL`,
        or(eq(nodes.ownerId, user.id), sql`${nodes.id} IN ${sharedWith(user.id)}`),
      );
      const q = req.query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const named = await db
        .select({ node: nodes, thumb: blobs.thumbStatus, scan: blobs.scanStatus })
        .from(nodes)
        .leftJoin(blobs, eq(blobs.id, nodes.blobId))
        .where(and(visible, sql`${nodes.name} ILIKE ${`%${q}%`}`))
        .orderBy(sql`similarity(${nodes.name}, ${req.query.q}) desc`, desc(nodes.updatedAt))
        .limit(limit);
      const items: SearchHit[] = named.map((r) =>
        toFileNode({ ...r.node, thumb: r.thumb, scan: r.scan }),
      );

      const words = wordQuery(req.query.q);
      if (words && items.length < limit) {
        const tsq = sql`to_tsquery('simple', ${words})`;
        const found = await db
          .select({
            node: nodes,
            thumb: blobs.thumbStatus,
            scan: blobs.scanStatus,
            snippet: sql<string>`ts_headline('simple', left(${blobTexts.content}, ${HEADLINE_CHARS}), ${tsq}, ${HEADLINE})`,
          })
          .from(blobTexts)
          .innerJoin(nodes, eq(nodes.blobId, blobTexts.blobId))
          .innerJoin(blobs, eq(blobs.id, blobTexts.blobId))
          .where(
            and(
              visible,
              sql`${blobTexts.words} @@ ${tsq}`,
              // Nothing from a file that can't be opened: no peeking at it through its words.
              notInArray(blobs.scanStatus, ['infected', 'held']),
              named.length
                ? notInArray(
                    nodes.id,
                    named.map((r) => r.node.id),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(nodes.updatedAt))
          .limit(limit - items.length);
        for (const r of found) {
          items.push({
            ...toFileNode({ ...r.node, thumb: r.thumb, scan: r.scan }),
            snippet: r.snippet.replace(/\s+/g, ' ').trim(),
          });
        }
      }
      return { items };
    },
  );

  // Files added or changed lately: your own and those in folders shared with you.
  app.get(
    '/recent',
    {
      schema: {
        querystring: RecentQuery,
        response: { 200: z.object({ items: z.array(FileNode) }) },
      },
    },
    async (req) => {
      const { user } = requireUser(req);
      const { limit } = req.query;
      const newest = (where: SQL) =>
        db
          .select({ node: nodes, thumb: blobs.thumbStatus, scan: blobs.scanStatus })
          .from(nodes)
          .leftJoin(blobs, eq(blobs.id, nodes.blobId))
          .where(and(eq(nodes.type, 'file'), isNull(nodes.deletedAt), where))
          .orderBy(desc(nodes.updatedAt), desc(nodes.id))
          .limit(limit);
      const [own, shared] = await Promise.all([
        newest(eq(nodes.ownerId, user.id)),
        newest(sql`${nodes.id} IN ${sharedWith(user.id)}`),
      ]);
      const seen = new Set<string>();
      const items = [...own, ...shared]
        .sort((a, b) => b.node.updatedAt.getTime() - a.node.updatedAt.getTime())
        .filter((r) => !seen.has(r.node.id) && seen.add(r.node.id))
        .slice(0, limit);
      return { items: items.map((r) => toFileNode({ ...r.node, thumb: r.thumb, scan: r.scan })) };
    },
  );

  // ── starred ───────────────────────────────────────────────────────────────

  app.get(
    '/starred',
    { schema: { response: { 200: z.object({ items: z.array(FileNode) }) } } },
    async (req) => {
      const { user } = requireUser(req);
      const rows = await db
        .select({ node: nodes, thumb: blobs.thumbStatus, scan: blobs.scanStatus })
        .from(stars)
        .innerJoin(nodes, eq(nodes.id, stars.nodeId))
        .leftJoin(blobs, eq(blobs.id, nodes.blobId))
        .where(and(eq(stars.userId, user.id), isNull(nodes.deletedAt)))
        .orderBy(desc(stars.createdAt))
        .limit(500);
      // A star outlives a share: only list what the person can still open.
      const visible = [];
      for (const r of rows) {
        if (r.node.ownerId === user.id || (await loadAccess(db, user.id, r.node.id))) {
          visible.push(toFileNode({ ...r.node, thumb: r.thumb, scan: r.scan }));
        }
      }
      return { items: visible };
    },
  );

  app.put(
    '/nodes/:id/star',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      await requireAccess(db, user.id, req.params.id, 'view');
      await db
        .insert(stars)
        .values({ userId: user.id, nodeId: req.params.id })
        .onConflictDoNothing();
      return { ok: true as const };
    },
  );

  app.delete(
    '/nodes/:id/star',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      await db.delete(stars).where(and(eq(stars.userId, user.id), eq(stars.nodeId, req.params.id)));
      return { ok: true as const };
    },
  );

  // ── content ───────────────────────────────────────────────────────────────

  app.get(
    '/nodes/:id/content',
    { schema: { params: IdParams, querystring: ContentQuery } },
    async (req, reply) => {
      const { user } = requireUser(req);
      const a = await requireAccess(db, user.id, req.params.id, 'view');
      if (a.node.type !== 'file' || !a.node.blobId || !a.node.volumeId) throw notFound('File');
      return sendBlob(
        ctx,
        req,
        reply,
        {
          blobId: a.node.blobId,
          volumeId: a.node.volumeId,
          size: a.node.size,
          name: a.node.name,
          mimeType: a.node.mimeType,
        },
        { inline: req.query.inline === '1' },
      );
    },
  );

  app.get('/nodes/:id/stream', { schema: { params: IdParams } }, async (req, reply) => {
    const { user } = requireUser(req);
    const a = await requireAccess(db, user.id, req.params.id, 'view');
    if (a.node.type !== 'file' || !a.node.blobId || !a.node.volumeId) throw notFound('File');
    return sendVideoStream(ctx, req, reply, {
      blobId: a.node.blobId,
      volumeId: a.node.volumeId,
      size: a.node.size,
      name: a.node.name,
      mimeType: a.node.mimeType,
    });
  });

  app.get('/nodes/:id/preview', { schema: { params: IdParams } }, async (req, reply) => {
    const { user } = requireUser(req);
    const a = await requireAccess(db, user.id, req.params.id, 'view');
    if (a.node.type !== 'file' || !a.node.blobId || !a.node.volumeId) throw notFound('File');
    return sendOfficePreview(ctx, req, reply, {
      blobId: a.node.blobId,
      volumeId: a.node.volumeId,
      size: a.node.size,
      name: a.node.name,
      mimeType: a.node.mimeType,
    });
  });

  app.get(
    '/nodes/:id/thumbnail',
    { schema: { params: IdParams, querystring: ThumbQuery } },
    async (req, reply) => {
      const { user } = requireUser(req);
      const a = await requireAccess(db, user.id, req.params.id, 'view');
      if (!a.node.blobId || a.node.thumb !== 'ready') throw notFound('Thumbnail');
      return sendThumbnail(ctx, req, reply, a.node.blobId, req.query);
    },
  );

  app.get('/zip', { schema: { querystring: ZipQuery } }, async (req, reply) => {
    const { user } = requireUser(req);
    const roots: ZipRoot[] = [];
    for (const id of new Set(req.query.ids)) {
      const a = await requireAccess(db, user.id, id, 'view');
      roots.push({
        id: a.node.id,
        type: a.node.type,
        name: a.isRoot ? 'My Files' : a.node.name,
        size: a.node.size,
        updatedAt: a.node.updatedAt,
        blobId: a.node.blobId,
        volumeId: a.node.volumeId,
      });
    }
    const first = roots[0]!;
    const zipName = roots.length === 1 ? `${first.name}.zip` : 'Download.zip';
    return sendZip(ctx, req, reply, roots, zipName);
  });

  // ── rewind ────────────────────────────────────────────────────────────────

  // Only the owner: rewinding brings things back from their trash, which only they can see.
  app.get(
    '/nodes/:id/rewind',
    { schema: { params: IdParams, querystring: RewindQuery, response: { 200: RewindPreview } } },
    async (req) => {
      const { user } = requireUser(req);
      await requireFolder(db, user.id, req.params.id, 'owner');
      const at = new Date(req.query.at);
      await checkRewindTime(ctx, at);
      return previewRewind(ctx, req.params.id, at);
    },
  );

  app.post(
    '/nodes/:id/rewind',
    { schema: { params: IdParams, body: RewindBody, response: { 200: RewindResult } } },
    async (req) => {
      const { user } = requireUser(req);
      await requireFolder(db, user.id, req.params.id, 'owner');
      const at = new Date(req.body.at);
      await checkRewindTime(ctx, at);
      const result = await rewindFolder(ctx, user, req.params.id, at);
      await audit(db, {
        actorId: user.id,
        action: 'folder.rewound',
        targetType: 'node',
        targetId: req.params.id,
        ip: req.clientIp,
        meta: { at: req.body.at, ...result },
      });
      return result;
    },
  );

  // ── trash ─────────────────────────────────────────────────────────────────

  app.get('/trash', { schema: { response: { 200: TrashList } } }, async (req) => {
    const { user } = requireUser(req);
    const settings = await ctx.settings.get();
    const rows = (await db.execute(sql`
      SELECT n.id, n.type, n.name, n.mime_type AS "mimeType", n.deleted_at AS "deletedAt",
             b.thumb_status AS thumb, p.id AS "parentId", p.name AS "parentName",
             p.parent_id IS NULL AS "parentIsRoot",
             CASE WHEN n.type = 'file' THEN n.size
                  ELSE (SELECT coalesce(sum(d.size), 0)::bigint FROM nodes d
                        WHERE d.trash_root_id = n.id AND d.type = 'file') END AS size
      FROM nodes n
      LEFT JOIN blobs b ON b.id = n.blob_id
      LEFT JOIN nodes p ON p.id = n.parent_id
      WHERE n.owner_id = ${user.id} AND n.trash_root_id = n.id
      ORDER BY n.deleted_at DESC
      LIMIT 1000
    `)) as unknown as {
      id: string;
      type: 'folder' | 'file';
      name: string;
      mimeType: string | null;
      deletedAt: string;
      thumb: 'none' | 'pending' | 'ready' | 'failed' | 'unsupported' | null;
      parentId: string | null;
      parentName: string | null;
      parentIsRoot: boolean | null;
      size: number;
    }[];
    return {
      retentionDays: settings.trashRetentionDays,
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        size: Number(r.size),
        mimeType: r.mimeType,
        thumb: r.type === 'folder' ? ('none' as const) : (r.thumb ?? 'none'),
        deletedAt: toIso(r.deletedAt),
        originalParent: r.parentId
          ? { id: r.parentId, name: r.parentIsRoot ? 'My Files' : (r.parentName ?? '') }
          : null,
      })),
    };
  });

  app.post(
    '/trash/:id/restore',
    { schema: { params: IdParams, response: { 200: RestoreResult } } },
    async (req) => {
      const { user } = requireUser(req);
      const node = await db.transaction((tx) => restoreSubtree(tx, user, req.params.id));
      const a = await loadAccess(db, user.id, node.id);
      return { node: toFileNode(a?.node ?? node) };
    },
  );

  app.delete('/trash/:id', { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    const { user } = requireUser(req);
    const result = await purgeTrashRoots(ctx, [req.params.id], user.id);
    if (result.files === 0) {
      const [exists] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.id, req.params.id), eq(nodes.ownerId, user.id)));
      if (exists) throw badRequest('That item is not in the trash');
    }
    await audit(db, {
      actorId: user.id,
      action: 'trash.purge',
      targetType: 'node',
      targetId: req.params.id,
      ip: req.clientIp,
      meta: result,
    });
    return { ok: true as const };
  });

  app.delete('/trash', { schema: { response: { 200: Ok } } }, async (req) => {
    const { user } = requireUser(req);
    const roots = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.ownerId, user.id), sql`${nodes.trashRootId} = ${nodes.id}`));
    const result = await purgeTrashRoots(
      ctx,
      roots.map((r) => r.id),
      user.id,
    );
    await audit(db, {
      actorId: user.id,
      action: 'trash.empty',
      ip: req.clientIp,
      meta: result,
    });
    return { ok: true as const };
  });

  // Batch lookup used by the upload manager to refresh a set of nodes.
  app.post(
    '/nodes/lookup',
    {
      schema: {
        body: z.object({ ids: z.array(z.uuid()).min(1).max(200) }),
        response: { 200: z.object({ items: z.array(FileNode) }) },
      },
    },
    async (req) => {
      const { user } = requireUser(req);
      const rows = await db
        .select({ node: nodes, thumb: blobs.thumbStatus, scan: blobs.scanStatus })
        .from(nodes)
        .leftJoin(blobs, eq(blobs.id, nodes.blobId))
        .where(and(inArray(nodes.id, req.body.ids), isNull(nodes.deletedAt)));
      const visible = [];
      for (const r of rows) {
        if (r.node.ownerId === user.id || (await loadAccess(db, user.id, r.node.id))) {
          visible.push(toFileNode({ ...r.node, thumb: r.thumb, scan: r.scan }));
        }
      }
      return { items: visible };
    },
  );
};
