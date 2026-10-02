import {
  type Album,
  AlbumDetail,
  AlbumFolder,
  AlbumList,
  AlbumPhotoPage,
  AlbumPhotosQuery,
  AlbumsQuery,
  ContentQuery,
  CreateAlbumBody,
  ErrorCode,
  IdParams,
  Ok,
  ThumbQuery,
  type ThumbStatus,
  UpdateAlbumBody,
} from '@familycloud/shared/all';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Executor } from '../../db/client';
import {
  type AlbumRow,
  albumFolders,
  albumPeople,
  albums,
  blobs,
  nodes,
  users,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import type { AuthContext } from '../../lib/sessions';
import { toIso } from '../../lib/time';
import { requireUser } from '../../plugins/auth';
import { sendBlob, sendThumbnail, sendVideoStream, sendZip, type ZipRoot } from '../files/serve';
import { insertNode } from '../files/tree';

/** Photos and videos only: anything else dropped into a trip folder stays out of the album. */
const MEDIA = sql`(${nodes.mimeType} LIKE 'image/%' OR ${nodes.mimeType} LIKE 'video/%')`;

type SQL = ReturnType<typeof sql>;

/** Live photos in any contributor folder of the album. */
const inAlbum = (albumId: string | SQL) => sql`${nodes.parentId} IN (
  SELECT folder_id FROM album_folders WHERE album_id = ${albumId}
) AND ${nodes.deletedAt} IS NULL AND ${nodes.type} = 'file' AND ${MEDIA}`;

async function albumDtos(exec: Executor, rows: AlbumRow[]): Promise<Album[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [people, stats, creators] = await Promise.all([
    exec
      .select({ albumId: albumPeople.albumId, id: users.id, displayName: users.displayName })
      .from(albumPeople)
      .innerJoin(users, eq(users.id, albumPeople.userId))
      .where(inArray(albumPeople.albumId, ids))
      .orderBy(users.displayName),
    // Per album: the photo count and the cover (the chosen one if it's still there, else the
    // earliest photo), in one pass.
    exec.execute<{
      album_id: string;
      count: number;
      cover_id: string | null;
      thumb: string | null;
    }>(
      sql`
        SELECT a.id AS album_id, coalesce(s.count, 0)::int AS count,
               c.id AS cover_id, c.thumb
        FROM albums a
        LEFT JOIN LATERAL (
          SELECT count(*) AS count FROM nodes
          WHERE ${inAlbum(sql`a.id`)}
        ) s ON true
        LEFT JOIN LATERAL (
          SELECT n.id, b.thumb_status AS thumb FROM nodes n
          JOIN blobs b ON b.id = n.blob_id
          WHERE n.parent_id IN (SELECT folder_id FROM album_folders WHERE album_id = a.id)
            AND n.deleted_at IS NULL AND n.type = 'file'
            AND (n.mime_type LIKE 'image/%' OR n.mime_type LIKE 'video/%')
          ORDER BY (n.id = a.cover_node_id) DESC, (b.thumb_status = 'ready') DESC, n.created_at, n.id
          LIMIT 1
        ) c ON true
        WHERE a.id IN (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})
      `,
    ),
    exec
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(
        inArray(
          users.id,
          rows.map((r) => r.createdBy).filter((x): x is string => !!x),
        ),
      ),
  ]);
  const statRows = Array.isArray(stats) ? stats : (stats as { rows: typeof stats }).rows;
  const byAlbum = new Map(
    (
      statRows as {
        album_id: string;
        count: number;
        cover_id: string | null;
        thumb: string | null;
      }[]
    ).map((s) => [s.album_id, s]),
  );
  return rows.map((r) => {
    const s = byAlbum.get(r.id);
    return {
      id: r.id,
      title: r.title,
      startDate: r.startDate,
      endDate: r.endDate,
      note: r.note,
      createdBy: creators.find((c) => c.id === r.createdBy) ?? null,
      people: people
        .filter((p) => p.albumId === r.id)
        .map(({ id, displayName }) => ({ id, displayName })),
      photoCount: s?.count ?? 0,
      cover: s?.cover_id ? { nodeId: s.cover_id, thumb: (s.thumb ?? 'none') as ThumbStatus } : null,
      updatedAt: toIso(r.updatedAt),
    };
  });
}

export const photoRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  async function loadAlbum(id: string) {
    const [row] = await db.select().from(albums).where(eq(albums.id, id));
    if (!row) throw notFound('Album');
    return row;
  }

  async function isOnTrip(albumId: string, userId: string) {
    const [row] = await db
      .select({ userId: albumPeople.userId })
      .from(albumPeople)
      .where(and(eq(albumPeople.albumId, albumId), eq(albumPeople.userId, userId)));
    return !!row;
  }

  const canEdit = (a: AlbumRow, auth: AuthContext) =>
    a.createdBy === auth.user.id || auth.user.role === 'admin';

  async function detail(a: AlbumRow, auth: AuthContext) {
    const [dto] = await albumDtos(db, [a]);
    return {
      ...dto!,
      canContribute: a.createdBy === auth.user.id || (await isOnTrip(a.id, auth.user.id)),
      canEdit: canEdit(a, auth),
    };
  }

  /** Only real family members may be tagged. */
  async function checkPeople(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return unique;
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, unique), isNull(users.disabledAt)));
    if (found.length !== unique.length)
      throw badRequest('Someone in the list is not in the family');
    return unique;
  }

  /** A photo of this album (any contributor's), or 404. */
  async function albumPhoto(albumId: string, nodeId: string) {
    const [row] = await db
      .select({
        node: nodes,
        thumb: blobs.thumbStatus,
        scan: blobs.scanStatus,
        volumeId: blobs.volumeId,
      })
      .from(nodes)
      .innerJoin(blobs, eq(blobs.id, nodes.blobId))
      .where(and(eq(nodes.id, nodeId), inAlbum(albumId)));
    if (!row) throw notFound('Photo');
    return row;
  }

  // ── albums ────────────────────────────────────────────────────────────────

  app.get(
    '/albums',
    { schema: { querystring: AlbumsQuery, response: { 200: AlbumList } } },
    async (req) => {
      requireUser(req);
      const rows = await db
        .select()
        .from(albums)
        .where(
          req.query.person
            ? sql`${albums.id} IN (SELECT album_id FROM album_people WHERE user_id = ${req.query.person})`
            : undefined,
        )
        .orderBy(sql`${albums.startDate} DESC`, sql`${albums.createdAt} DESC`);
      return { items: await albumDtos(db, rows) };
    },
  );

  app.post(
    '/albums',
    { schema: { body: CreateAlbumBody, response: { 200: AlbumDetail } } },
    async (req) => {
      const auth = requireUser(req);
      const people = await checkPeople(req.body.peopleIds);
      const row = await db.transaction(async (tx) => {
        const [a] = await tx
          .insert(albums)
          .values({
            title: req.body.title,
            startDate: req.body.startDate,
            endDate: req.body.endDate ?? null,
            note: req.body.note || null,
            createdBy: auth.user.id,
          })
          .returning();
        if (people.length) {
          await tx.insert(albumPeople).values(people.map((userId) => ({ albumId: a!.id, userId })));
        }
        return a!;
      });
      await audit(db, {
        actorId: auth.user.id,
        action: 'photos.album_created',
        targetType: 'album',
        targetId: row.id,
        ip: req.clientIp,
      });
      return detail(row, auth);
    },
  );

  app.get(
    '/albums/:id',
    { schema: { params: IdParams, response: { 200: AlbumDetail } } },
    async (req) => {
      const auth = requireUser(req);
      return detail(await loadAlbum(req.params.id), auth);
    },
  );

  app.patch(
    '/albums/:id',
    { schema: { params: IdParams, body: UpdateAlbumBody, response: { 200: AlbumDetail } } },
    async (req) => {
      const auth = requireUser(req);
      const a = await loadAlbum(req.params.id);
      if (!canEdit(a, auth))
        throw forbidden('Only the person who started this album can change it');
      const b = req.body;
      const startDate = b.startDate ?? a.startDate;
      const endDate = b.endDate === undefined ? a.endDate : b.endDate;
      if (endDate && endDate < startDate) {
        throw badRequest('The trip can’t end before it starts');
      }
      if (b.coverNodeId) await albumPhoto(a.id, b.coverNodeId);
      const people = b.peopleIds ? await checkPeople(b.peopleIds) : null;
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(albums)
          .set({
            title: b.title ?? a.title,
            startDate,
            endDate,
            note: b.note === undefined ? a.note : b.note || null,
            coverNodeId: b.coverNodeId === undefined ? a.coverNodeId : b.coverNodeId,
            updatedAt: new Date(),
          })
          .where(eq(albums.id, a.id))
          .returning();
        if (people) {
          await tx.delete(albumPeople).where(eq(albumPeople.albumId, a.id));
          if (people.length) {
            await tx
              .insert(albumPeople)
              .values(people.map((userId) => ({ albumId: a.id, userId })));
          }
        }
        return updated!;
      });
      await audit(db, {
        actorId: auth.user.id,
        action: 'photos.album_updated',
        targetType: 'album',
        targetId: a.id,
        ip: req.clientIp,
        meta: { ...b, ...(people ? { peopleIds: people } : {}) },
      });
      return detail(row, auth);
    },
  );

  app.delete(
    '/albums/:id',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const auth = requireUser(req);
      const a = await loadAlbum(req.params.id);
      if (!canEdit(a, auth))
        throw forbidden('Only the person who started this album can delete it');
      // The photos stay where they are, in each person's Trips folder; only the album goes.
      await db.delete(albums).where(eq(albums.id, a.id));
      await audit(db, {
        actorId: auth.user.id,
        action: 'photos.album_deleted',
        targetType: 'album',
        targetId: a.id,
        ip: req.clientIp,
        meta: { title: a.title },
      });
      return { ok: true as const };
    },
  );

  /**
   * The caller's folder for this album ("Trips/<album>" in their own space), created on first use
   * and re-created if they deleted it. Uploads go there through the normal upload API.
   */
  app.post(
    '/albums/:id/folder',
    { schema: { params: IdParams, response: { 200: AlbumFolder } } },
    async (req) => {
      const auth = requireUser(req);
      const a = await loadAlbum(req.params.id);
      if (a.createdBy !== auth.user.id && !(await isOnTrip(a.id, auth.user.id))) {
        throw forbidden('Only people on this trip can add photos');
      }
      const [user] = await db.select().from(users).where(eq(users.id, auth.user.id));
      const rootId = user?.rootNodeId;
      if (!rootId) throw new AppError(500, ErrorCode.INTERNAL, 'Your home folder is missing');
      const folderId = await db.transaction(async (tx) => {
        // Serialise per person, so two phones starting uploads at once make one folder.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`album-folder:${auth.user.id}`}))`,
        );
        const [existing] = await tx
          .select({ folderId: albumFolders.folderId })
          .from(albumFolders)
          .innerJoin(nodes, eq(nodes.id, albumFolders.folderId))
          .where(
            and(
              eq(albumFolders.albumId, a.id),
              eq(albumFolders.userId, auth.user.id),
              isNull(nodes.deletedAt),
            ),
          );
        if (existing) return existing.folderId;
        const trips = await insertNode(
          tx,
          {
            ownerId: auth.user.id,
            parentId: rootId,
            type: 'folder',
            name: 'Trips',
            createdBy: auth.user.id,
          },
          'reuse',
        );
        const folder = await insertNode(
          tx,
          {
            ownerId: auth.user.id,
            parentId: trips.id,
            type: 'folder',
            name: `${a.startDate.slice(0, 7)} ${a.title}`,
            createdBy: auth.user.id,
          },
          'rename',
        );
        await tx
          .insert(albumFolders)
          .values({ albumId: a.id, userId: auth.user.id, folderId: folder.id })
          .onConflictDoUpdate({
            target: [albumFolders.albumId, albumFolders.userId],
            set: { folderId: folder.id },
          });
        return folder.id;
      });
      return { folderId };
    },
  );

  // ── photos ────────────────────────────────────────────────────────────────

  app.get(
    '/albums/:id/photos',
    {
      schema: {
        params: IdParams,
        querystring: AlbumPhotosQuery,
        response: { 200: AlbumPhotoPage },
      },
    },
    async (req) => {
      requireUser(req);
      const a = await loadAlbum(req.params.id);
      let after: SQL | undefined;
      if (req.query.cursor) {
        const [at, id] = decodeCursor(req.query.cursor);
        after = sql`(${nodes.createdAt}, ${nodes.id}) > (${at}::timestamptz, ${id}::uuid)`;
      }
      const rows = await db
        .select({
          node: nodes,
          thumb: blobs.thumbStatus,
          scan: blobs.scanStatus,
          owner: { id: users.id, displayName: users.displayName },
        })
        .from(nodes)
        .innerJoin(blobs, eq(blobs.id, nodes.blobId))
        .innerJoin(users, eq(users.id, nodes.ownerId))
        .where(and(inAlbum(a.id), after))
        .orderBy(nodes.createdAt, nodes.id)
        .limit(req.query.limit + 1);
      const page = rows.slice(0, req.query.limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          id: r.node.id,
          name: r.node.name,
          size: r.node.size,
          mimeType: r.node.mimeType,
          thumb: r.thumb,
          addedBy: r.owner,
          createdAt: toIso(r.node.createdAt),
        })),
        nextCursor:
          rows.length > req.query.limit && last
            ? encodeCursor([last.node.createdAt.toISOString(), last.node.id])
            : null,
      };
    },
  );

  const PhotoParams = z.object({ id: z.uuid(), nodeId: z.uuid() });

  app.get(
    '/albums/:id/photos/:nodeId/content',
    { schema: { params: PhotoParams, querystring: ContentQuery } },
    async (req, reply) => {
      requireUser(req);
      const p = await albumPhoto(req.params.id, req.params.nodeId);
      return sendBlob(
        ctx,
        req,
        reply,
        {
          blobId: p.node.blobId!,
          volumeId: p.volumeId,
          size: p.node.size,
          name: p.node.name,
          mimeType: p.node.mimeType,
        },
        { inline: req.query.inline === '1' },
      );
    },
  );

  app.get(
    '/albums/:id/photos/:nodeId/stream',
    { schema: { params: PhotoParams } },
    async (req, reply) => {
      requireUser(req);
      const p = await albumPhoto(req.params.id, req.params.nodeId);
      return sendVideoStream(ctx, req, reply, {
        blobId: p.node.blobId!,
        volumeId: p.volumeId,
        size: p.node.size,
        name: p.node.name,
        mimeType: p.node.mimeType,
      });
    },
  );

  app.get(
    '/albums/:id/photos/:nodeId/thumbnail',
    { schema: { params: PhotoParams, querystring: ThumbQuery } },
    async (req, reply) => {
      requireUser(req);
      const p = await albumPhoto(req.params.id, req.params.nodeId);
      if (p.thumb !== 'ready') throw notFound('Thumbnail');
      return sendThumbnail(ctx, req, reply, p.node.blobId!, req.query.size);
    },
  );

  app.get('/albums/:id/zip', { schema: { params: IdParams } }, async (req, reply) => {
    requireUser(req);
    const a = await loadAlbum(req.params.id);
    const rows = await db
      .select({ node: nodes, volumeId: blobs.volumeId })
      .from(nodes)
      .innerJoin(blobs, eq(blobs.id, nodes.blobId))
      .where(inAlbum(a.id))
      .orderBy(nodes.createdAt, nodes.id);
    if (rows.length === 0) throw notFound('Photos');
    const roots: ZipRoot[] = rows.map((r) => ({
      id: r.node.id,
      type: 'file',
      name: r.node.name,
      size: r.node.size,
      updatedAt: r.node.updatedAt,
      blobId: r.node.blobId,
      volumeId: r.volumeId,
    }));
    return sendZip(ctx, req, reply, roots, `${a.title}.zip`);
  });
};

function encodeCursor(c: [string, string]) {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string): [string, string] {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(c) &&
      c.length === 2 &&
      typeof c[0] === 'string' &&
      !Number.isNaN(Date.parse(c[0])) &&
      typeof c[1] === 'string' &&
      /^[0-9a-f-]{36}$/i.test(c[1])
    ) {
      return c as [string, string];
    }
  } catch {}
  throw badRequest('Invalid cursor');
}
