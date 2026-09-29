import {
  ChildrenQuery,
  ContentQuery,
  CreateFolderBody,
  ErrorCode,
  FileNode,
  IdParams,
  NodeDetail,
  NodePage,
  Ok,
  RestoreResult,
  SearchQuery,
  ThumbQuery,
  TrashList,
  UpdateNodeBody,
  ZipQuery,
} from '@familycloud/shared/all';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { albumFolders, albums, blobs, nodes, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { toFileNode } from '../../lib/dto';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { toIso } from '../../lib/time';
import { requireUser } from '../../plugins/auth';
import { loadAccess, requireAccess, requireFolder, satisfies } from './access';
import { sendBlob, sendThumbnail, sendVideoStream, sendZip, type ZipRoot } from './serve';
import {
  insertNode,
  isAncestor,
  listChildren,
  moveNode,
  purgeTrashRoots,
  restoreSubtree,
  trashSubtree,
} from './tree';

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

  app.post(
    '/folders',
    { schema: { body: CreateFolderBody, response: { 200: FileNode } } },
    async (req) => {
      const { user } = requireUser(req);
      const parent = await requireFolder(db, user.id, req.body.parentId, 'edit');
      const row = await insertNode(
        db,
        {
          ownerId: parent.node.ownerId,
          parentId: parent.node.id,
          type: 'folder',
          name: req.body.name,
          createdBy: user.id,
        },
        req.body.reuseExisting ? 'reuse' : 'fail',
      );
      return toFileNode(row);
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
      const row = await moveNode(db, a.node, patch);
      return toFileNode({ ...row, thumb: a.node.thumb });
    },
  );

  app.delete('/nodes/:id', { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    const { user } = requireUser(req);
    const a = await requireAccess(db, user.id, req.params.id, 'view');
    if (a.isRoot) throw forbidden('Your top-level folder cannot be deleted');
    if (!satisfies(a.parentAccess, 'edit')) throw forbidden();
    await trashSubtree(db, a.node.id);
    return { ok: true as const };
  });

  app.get(
    '/search',
    {
      schema: {
        querystring: SearchQuery,
        response: { 200: z.object({ items: z.array(FileNode) }) },
      },
    },
    async (req) => {
      const { user } = requireUser(req);
      const q = req.query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = await db
        .select({ node: nodes, thumb: blobs.thumbStatus })
        .from(nodes)
        .leftJoin(blobs, eq(blobs.id, nodes.blobId))
        .where(
          and(
            eq(nodes.ownerId, user.id),
            isNull(nodes.deletedAt),
            sql`${nodes.parentId} IS NOT NULL`,
            sql`${nodes.name} ILIKE ${`%${q}%`}`,
          ),
        )
        .orderBy(sql`similarity(${nodes.name}, ${req.query.q}) desc`, desc(nodes.updatedAt))
        .limit(req.query.limit);
      return { items: rows.map((r) => toFileNode({ ...r.node, thumb: r.thumb })) };
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

  app.get(
    '/nodes/:id/thumbnail',
    { schema: { params: IdParams, querystring: ThumbQuery } },
    async (req, reply) => {
      const { user } = requireUser(req);
      const a = await requireAccess(db, user.id, req.params.id, 'view');
      if (!a.node.blobId || a.node.thumb !== 'ready') throw notFound('Thumbnail');
      return sendThumbnail(ctx, req, reply, a.node.blobId, req.query.size);
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
        .select({ node: nodes, thumb: blobs.thumbStatus })
        .from(nodes)
        .leftJoin(blobs, eq(blobs.id, nodes.blobId))
        .where(and(inArray(nodes.id, req.body.ids), isNull(nodes.deletedAt)));
      const visible = [];
      for (const r of rows) {
        if (r.node.ownerId === user.id || (await loadAccess(db, user.id, r.node.id))) {
          visible.push(toFileNode({ ...r.node, thumb: r.thumb }));
        }
      }
      return { items: visible };
    },
  );
};
