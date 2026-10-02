import {
  CreateLinkBody,
  DEFAULT_REQUEST_LIMIT_BYTES,
  ErrorCode,
  IdParams,
  type LinkKind,
  Ok,
  PublicFolder,
  PublicFolderQuery,
  PublicLinkInfo,
  type PublicNode,
  PublicNodeParams,
  REQUEST_DEFAULT_DAYS,
  REQUEST_MAX_DAYS,
  type Share,
  SharedByMeItem,
  ShareLink,
  ThumbQuery,
  TokenParams,
  UnlockLinkBody,
} from '@familycloud/shared/all';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import type { AppContext } from '../../context';
import {
  blobs,
  nodes,
  type ShareLinkRow,
  shareLinks,
  shares,
  uploadSessions,
  users,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { toFileNode } from '../../lib/dto';
import { AppError, notFound } from '../../lib/errors';
import { isInlineSafe } from '../../lib/http';
import { hashPassword, verifyPassword } from '../../lib/passwords';
import { toIso, toIsoOrNull } from '../../lib/time';
import { requireUser } from '../../plugins/auth';
import { strictLimit } from '../../plugins/security';
import { type NodeWithBlob, requireAccess } from '../files/access';
import {
  sendBlob,
  sendOfficePreview,
  sendThumbnail,
  sendVideoStream,
  sendZip,
} from '../files/serve';
import { listChildren } from '../files/tree';
import { releaseUpload } from '../uploads/service';

const UNLOCK_TTL = 12 * 60 * 60;
const COOKIE_PATH = '/api/v1/public/links/';
/**
 * Password tries per link in a window, from any number of IPs: the per-IP limit alone lets a
 * botnet guess a short link password quickly once it has the link.
 */
const UNLOCK_MAX_TRIES = 20;
const UNLOCK_WINDOW_MS = 15 * 60_000;

function linkUrl(ctx: AppContext, token: string) {
  return `${ctx.config.publicUrl}/s/${token}`;
}

function toLinkDto(ctx: AppContext, l: ShareLinkRow) {
  // A token encrypted under an earlier SECRET_KEY can't be shown again, but the link must stay
  // listed so its owner can still revoke it.
  let url: string | null = null;
  try {
    url = linkUrl(ctx, ctx.keys.decrypt('link', l.tokenEnc));
  } catch {}
  return {
    id: l.id,
    nodeId: l.nodeId,
    kind: l.kind,
    title: l.title,
    url,
    hasPassword: l.passwordHash !== null,
    allowDownload: l.allowDownload,
    downloadCount: l.downloadCount,
    maxDownloads: l.maxDownloads,
    uploadCount: l.uploadCount,
    uploadBytes: l.uploadBytes,
    maxUploadBytes: l.maxUploadBytes,
    expiresAt: toIsoOrNull(l.expiresAt),
    createdAt: toIso(l.createdAt),
    lastAccessedAt: toIsoOrNull(l.lastAccessedAt),
  };
}

function toPublicNode(n: NodeWithBlob): PublicNode {
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    size: n.size,
    mimeType: n.mimeType,
    thumb: n.type === 'folder' ? 'none' : (n.thumb ?? 'none'),
    updatedAt: toIso(n.updatedAt),
  };
}

const unlockCookie = (linkId: string) => `fc_link_${linkId.replace(/-/g, '').slice(0, 16)}`;

async function loadNode(ctx: AppContext, nodeId: string): Promise<NodeWithBlob | null> {
  const [row] = await ctx.db
    .select({ node: nodes, thumb: blobs.thumbStatus, volumeId: blobs.volumeId })
    .from(nodes)
    .leftJoin(blobs, eq(blobs.id, nodes.blobId))
    .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)));
  return row ? { ...row.node, thumb: row.thumb, volumeId: row.volumeId } : null;
}

/** Resolves a public token. Unknown, revoked and trashed targets all look identical (404). */
export async function resolveLink(ctx: AppContext, req: FastifyRequest, token: string) {
  const [row] = await ctx.db
    .select({ link: shareLinks, sharedBy: users.displayName })
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .innerJoin(users, eq(users.id, nodes.ownerId))
    .where(
      and(
        eq(shareLinks.tokenHash, sha256(token)),
        isNull(shareLinks.revokedAt),
        // A disabled account's links stop too (it may have been disabled for a reason).
        isNull(users.disabledAt),
      ),
    );
  if (!row) throw notFound('Link');
  if (row.link.expiresAt && row.link.expiresAt.getTime() < Date.now()) {
    throw new AppError(410, ErrorCode.LINK_EXPIRED, 'This link has expired');
  }
  if (row.link.maxDownloads !== null && row.link.downloadCount >= row.link.maxDownloads) {
    throw new AppError(410, ErrorCode.LINK_EXPIRED, 'This link has reached its download limit');
  }
  const root = await loadNode(ctx, row.link.nodeId);
  if (!root) throw notFound('Link');
  let unlocked = row.link.passwordHash === null;
  if (!unlocked) {
    const cookie = req.cookies[unlockCookie(row.link.id)];
    const claims = cookie ? ctx.keys.verify<{ lid: string }>('link-unlock', cookie) : null;
    unlocked = claims?.lid === row.link.id;
  }
  if (!row.link.lastAccessedAt || Date.now() - row.link.lastAccessedAt.getTime() > 5 * 60_000) {
    await ctx.db
      .update(shareLinks)
      .set({ lastAccessedAt: new Date() })
      .where(eq(shareLinks.id, row.link.id));
  }
  return { link: row.link, sharedBy: row.sharedBy, root, unlocked };
}

/**
 * A link of `kind`, unlocked. A file request never shows what's in its folder, so every "view"
 * route asks for kind 'view' and treats a request's token as unknown.
 */
export async function resolveUnlocked(
  ctx: AppContext,
  req: FastifyRequest,
  token: string,
  kind: LinkKind,
) {
  const r = await resolveLink(ctx, req, token);
  if (r.link.kind !== kind) throw notFound('Link');
  if (!r.unlocked) throw new AppError(401, ErrorCode.LINK_LOCKED, 'This link needs a password');
  return r;
}

/**
 * Counts a download through a link, refusing it once the link's download limit is used up
 * (checked and counted in one statement, so parallel downloads can't overshoot). A download
 * resumed part-way, or a HEAD, continues one already counted.
 */
async function countDownload(ctx: AppContext, req: FastifyRequest, linkId: string) {
  if (req.method === 'HEAD') return;
  const range = req.headers.range;
  if (range && !/^bytes=0-/.test(range.trim())) return;
  const [counted] = await ctx.db
    .update(shareLinks)
    .set({ downloadCount: sql`${shareLinks.downloadCount} + 1` })
    .where(
      and(
        eq(shareLinks.id, linkId),
        sql`(${shareLinks.maxDownloads} IS NULL OR ${shareLinks.downloadCount} < ${shareLinks.maxDownloads})`,
      ),
    )
    .returning({ id: shareLinks.id });
  if (!counted) {
    throw new AppError(410, ErrorCode.LINK_EXPIRED, 'This link has reached its download limit');
  }
}

/** Finds `nodeId` inside the link's subtree and returns breadcrumbs relative to the link root. */
async function nodeWithinLink(ctx: AppContext, rootId: string, nodeId: string) {
  if (nodeId === rootId) {
    const n = await loadNode(ctx, nodeId);
    return n ? { node: n, breadcrumbs: [{ id: n.id, name: n.name }] } : null;
  }
  const chain = (await ctx.db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, name, deleted_at, 0 AS depth FROM nodes WHERE id = ${nodeId}
      UNION ALL
      SELECT n.id, n.parent_id, n.name, n.deleted_at, u.depth + 1
      FROM nodes n JOIN up u ON n.id = u.parent_id
      WHERE u.id <> ${rootId} AND u.depth < 512
    )
    SELECT id, name, deleted_at IS NOT NULL AS deleted FROM up ORDER BY depth DESC
  `)) as unknown as { id: string; name: string; deleted: boolean }[];
  if (chain[0]?.id !== rootId || chain.some((c) => c.deleted)) return null;
  const node = await loadNode(ctx, nodeId);
  return node ? { node, breadcrumbs: chain.map((c) => ({ id: c.id, name: c.name })) } : null;
}

export const linkRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;
  // Fixed window per link (the TTL isn't extended by later tries).
  const unlockTries = new LRUCache<string, number>({
    max: 10_000,
    ttl: UNLOCK_WINDOW_MS,
    noUpdateTTL: true,
  });

  // ── owner management ──────────────────────────────────────────────────────

  app.get(
    '/nodes/:id/links',
    { schema: { params: IdParams, response: { 200: z.object({ items: z.array(ShareLink) }) } } },
    async (req) => {
      const { user } = requireUser(req);
      await requireAccess(db, user.id, req.params.id, 'owner');
      const rows = await db
        .select()
        .from(shareLinks)
        .where(
          and(
            eq(shareLinks.nodeId, req.params.id),
            isNull(shareLinks.revokedAt),
            or(isNull(shareLinks.expiresAt), sql`${shareLinks.expiresAt} > now()`),
          ),
        )
        .orderBy(desc(shareLinks.createdAt));
      return { items: rows.map((l) => toLinkDto(ctx, l)) };
    },
  );

  app.post(
    '/nodes/:id/links',
    { schema: { params: IdParams, body: CreateLinkBody, response: { 200: ShareLink } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await requireAccess(db, user.id, req.params.id, 'owner');
      if (a.isRoot) throw new AppError(400, ErrorCode.VALIDATION, 'Pick a folder or file to share');
      if (req.body.expiresAt && new Date(req.body.expiresAt).getTime() <= Date.now()) {
        throw new AppError(400, ErrorCode.VALIDATION, 'Expiry must be in the future');
      }
      const request = req.body.kind === 'upload';
      if (request && a.node.type !== 'folder') {
        throw new AppError(400, ErrorCode.VALIDATION, 'Files can only be requested into a folder');
      }
      // A request left open forever is an open door: it always has an end date.
      const DAY = 86_400_000;
      let expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      if (request) {
        expiresAt ??= new Date(Date.now() + REQUEST_DEFAULT_DAYS * DAY);
        if (expiresAt.getTime() > Date.now() + REQUEST_MAX_DAYS * DAY + 60_000) {
          throw new AppError(
            400,
            ErrorCode.VALIDATION,
            `A file request can stay open for at most ${REQUEST_MAX_DAYS} days`,
          );
        }
      }
      const token = randomToken(24);
      const [row] = await db
        .insert(shareLinks)
        .values({
          nodeId: a.node.id,
          kind: req.body.kind,
          title: request ? (req.body.title ?? null) : null,
          tokenHash: sha256(token),
          tokenEnc: ctx.keys.encrypt('link', token),
          passwordHash: req.body.password ? await hashPassword(req.body.password) : null,
          // A request never lets anyone see or download what's in the folder.
          allowDownload: request ? false : req.body.allowDownload,
          maxDownloads: request ? null : (req.body.maxDownloads ?? null),
          // A request can't fill the disks for everyone even if its link gets around.
          maxUploadBytes: request
            ? req.body.maxUploadBytes === undefined
              ? DEFAULT_REQUEST_LIMIT_BYTES
              : req.body.maxUploadBytes
            : null,
          expiresAt,
          createdBy: user.id,
        })
        .returning();
      await audit(db, {
        actorId: user.id,
        action: 'link.created',
        targetType: 'node',
        targetId: a.node.id,
        ip: req.clientIp,
        meta: {
          linkId: row!.id,
          kind: req.body.kind,
          password: !!req.body.password,
          expiresAt: expiresAt?.toISOString() ?? null,
          maxDownloads: row!.maxDownloads,
        },
      });
      return toLinkDto(ctx, row!);
    },
  );

  app.delete('/links/:id', { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    const { user } = requireUser(req);
    const [row] = await db
      .select({ link: shareLinks, ownerId: nodes.ownerId })
      .from(shareLinks)
      .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
      .where(eq(shareLinks.id, req.params.id));
    if (!row || row.ownerId !== user.id) throw notFound('Link');
    await db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(eq(shareLinks.id, row.link.id));
    // Uploads still coming in through a file request stop now and give back the space they held.
    const open = await db
      .select({ id: uploadSessions.id })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.linkId, row.link.id),
          inArray(uploadSessions.status, ['uploading', 'finalizing']),
        ),
      );
    for (const s of open) await releaseUpload(ctx, s.id, 'aborted');
    await audit(db, {
      actorId: user.id,
      action: 'link.revoked',
      targetType: 'node',
      targetId: row.link.nodeId,
      ip: req.clientIp,
    });
    return { ok: true as const };
  });

  // Everything in the user's space that family or a link can currently reach: live links only
  // (revoked and expired ones are gone), newest first.
  app.get(
    '/shared-by-me',
    { schema: { response: { 200: z.object({ items: z.array(SharedByMeItem) }) } } },
    async (req) => {
      const { user } = requireUser(req);
      const mine = and(eq(nodes.ownerId, user.id), isNull(nodes.deletedAt));
      const [linkRows, shareRows] = await Promise.all([
        db
          .select({ link: shareLinks })
          .from(shareLinks)
          .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
          .where(
            and(
              mine,
              isNull(shareLinks.revokedAt),
              or(isNull(shareLinks.expiresAt), sql`${shareLinks.expiresAt} > now()`),
            ),
          )
          .orderBy(desc(shareLinks.createdAt)),
        db
          .select({
            share: shares,
            grantee: { id: users.id, displayName: users.displayName, email: users.email },
          })
          .from(shares)
          .innerJoin(nodes, eq(nodes.id, shares.nodeId))
          .innerJoin(users, eq(users.id, shares.granteeId))
          .where(mine)
          .orderBy(desc(shares.createdAt)),
      ]);
      const items = new Map<string, { people: Share[]; links: ShareLink[]; latest: number }>();
      const entry = (nodeId: string, at: Date) => {
        let e = items.get(nodeId);
        if (!e) {
          e = { people: [], links: [], latest: 0 };
          items.set(nodeId, e);
        }
        e.latest = Math.max(e.latest, at.getTime());
        return e;
      };
      for (const { link } of linkRows) {
        entry(link.nodeId, link.createdAt).links.push(toLinkDto(ctx, link));
      }
      for (const { share, grantee } of shareRows) {
        entry(share.nodeId, share.createdAt).people.push({
          id: share.id,
          nodeId: share.nodeId,
          grantee,
          permission: share.permission,
          createdAt: toIso(share.createdAt),
        });
      }
      if (items.size === 0) return { items: [] };
      const nodeRows = await db
        .select({ node: nodes, thumb: blobs.thumbStatus })
        .from(nodes)
        .leftJoin(blobs, eq(blobs.id, nodes.blobId))
        .where(inArray(nodes.id, [...items.keys()]));
      return {
        items: nodeRows
          .map((r) => ({
            node: toFileNode({ ...r.node, thumb: r.thumb }),
            ...items.get(r.node.id)!,
          }))
          .sort((a, b) => b.latest - a.latest)
          .map(({ latest: _, ...item }) => item),
      };
    },
  );

  // ── public (no account) ───────────────────────────────────────────────────

  app.get(
    '/public/links/:token',
    {
      config: strictLimit(120),
      schema: { params: TokenParams, response: { 200: PublicLinkInfo } },
    },
    async (req) => {
      const r = await resolveLink(ctx, req, req.params.token);
      const request = r.link.kind === 'upload';
      return {
        kind: r.link.kind,
        // Like the item's name on a view link, a request's title can be private.
        title: r.unlocked ? r.link.title : null,
        locked: !r.unlocked,
        allowDownload: r.link.allowDownload,
        expiresAt: toIsoOrNull(r.link.expiresAt),
        sharedBy: r.sharedBy,
        // A file request doesn't even say what its folder is called.
        node: r.unlocked && !request ? toPublicNode(r.root) : null,
      };
    },
  );

  app.post(
    '/public/links/:token/unlock',
    {
      config: strictLimit(10),
      schema: { params: TokenParams, body: UnlockLinkBody, response: { 200: Ok } },
    },
    async (req, reply) => {
      const r = await resolveLink(ctx, req, req.params.token);
      // Counted before the (slow) check, so parallel guesses can't all slip under the limit.
      const tries = (unlockTries.get(r.link.id) ?? 0) + 1;
      if (tries > UNLOCK_MAX_TRIES) {
        throw new AppError(
          429,
          ErrorCode.RATE_LIMITED,
          'Too many wrong passwords for this link. Try again in 15 minutes.',
        );
      }
      unlockTries.set(r.link.id, tries);
      if (r.link.passwordHash && !(await verifyPassword(r.link.passwordHash, req.body.password))) {
        await audit(db, {
          actorId: null,
          action: 'link.unlock_failed',
          targetType: 'link',
          targetId: r.link.id,
          ip: req.clientIp,
        });
        throw new AppError(401, ErrorCode.LINK_LOCKED, 'Incorrect password');
      }
      unlockTries.delete(r.link.id);
      reply.setCookie(
        unlockCookie(r.link.id),
        ctx.keys.sign('link-unlock', { lid: r.link.id }, UNLOCK_TTL),
        {
          httpOnly: true,
          secure: ctx.config.cookieSecure,
          sameSite: 'lax',
          path: COOKIE_PATH,
          maxAge: UNLOCK_TTL,
        },
      );
      return { ok: true as const };
    },
  );

  app.get(
    '/public/links/:token/folder',
    {
      config: strictLimit(240),
      schema: {
        params: TokenParams,
        querystring: PublicFolderQuery,
        response: { 200: PublicFolder },
      },
    },
    async (req) => {
      const r = await resolveUnlocked(ctx, req, req.params.token, 'view');
      const target = await nodeWithinLink(ctx, r.root.id, req.query.folderId ?? r.root.id);
      if (target?.node.type !== 'folder') throw notFound('Folder');
      const page = await listChildren(db, target.node.id, {
        cursor: req.query.cursor,
        limit: req.query.limit,
        sort: 'name',
        dir: 'asc',
      });
      return {
        folder: toPublicNode(target.node),
        breadcrumbs: target.breadcrumbs,
        items: page.items.map(({ id, type, name, size, mimeType, thumb, updatedAt }) => ({
          id,
          type,
          name,
          size,
          mimeType,
          thumb,
          updatedAt,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  async function publicFile(req: FastifyRequest, token: string, nodeId: string) {
    const r = await resolveUnlocked(ctx, req, token, 'view');
    const target = await nodeWithinLink(ctx, r.root.id, nodeId);
    if (!target) throw notFound('File');
    return { ...r, node: target.node };
  }

  app.get(
    '/public/links/:token/content/:nodeId',
    {
      config: strictLimit(600),
      schema: {
        params: PublicNodeParams,
        querystring: z.object({ inline: z.enum(['0', '1']).default('0') }),
      },
    },
    async (req, reply) => {
      const r = await publicFile(req, req.params.token, req.params.nodeId);
      const n = r.node;
      // `inline=1` for a type that can't be previewed is served as an attachment, i.e. a download.
      const inline = req.query.inline === '1' && isInlineSafe(n.mimeType);
      if (!inline && !r.link.allowDownload) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Downloads are turned off for this link');
      }
      if (n.type !== 'file' || !n.blobId || !n.volumeId) throw notFound('File');
      if (!inline) await countDownload(ctx, req, r.link.id);
      return sendBlob(
        ctx,
        req,
        reply,
        {
          blobId: n.blobId,
          volumeId: n.volumeId,
          size: n.size,
          name: n.name,
          mimeType: n.mimeType,
        },
        { inline },
      );
    },
  );

  // Watching a video is viewing, so it works on view-only links too.
  app.get(
    '/public/links/:token/stream/:nodeId',
    { config: strictLimit(600), schema: { params: PublicNodeParams } },
    async (req, reply) => {
      const { node: n } = await publicFile(req, req.params.token, req.params.nodeId);
      if (n.type !== 'file' || !n.blobId || !n.volumeId || !n.mimeType?.startsWith('video/')) {
        throw notFound('Video');
      }
      return sendVideoStream(ctx, req, reply, {
        blobId: n.blobId,
        volumeId: n.volumeId,
        size: n.size,
        name: n.name,
        mimeType: n.mimeType,
      });
    },
  );

  // Reading a document is viewing too.
  app.get(
    '/public/links/:token/preview/:nodeId',
    { config: strictLimit(600), schema: { params: PublicNodeParams } },
    async (req, reply) => {
      const { node: n } = await publicFile(req, req.params.token, req.params.nodeId);
      if (n.type !== 'file' || !n.blobId || !n.volumeId) throw notFound('File');
      return sendOfficePreview(ctx, req, reply, {
        blobId: n.blobId,
        volumeId: n.volumeId,
        size: n.size,
        name: n.name,
        mimeType: n.mimeType,
      });
    },
  );

  app.get(
    '/public/links/:token/thumbnail/:nodeId',
    { config: strictLimit(1200), schema: { params: PublicNodeParams, querystring: ThumbQuery } },
    async (req, reply) => {
      const r = await publicFile(req, req.params.token, req.params.nodeId);
      if (!r.node.blobId || r.node.thumb !== 'ready') throw notFound('Thumbnail');
      return sendThumbnail(ctx, req, reply, r.node.blobId, req.query.size);
    },
  );

  app.get(
    '/public/links/:token/zip/:nodeId',
    { config: strictLimit(30), schema: { params: PublicNodeParams } },
    async (req, reply) => {
      const r = await publicFile(req, req.params.token, req.params.nodeId);
      if (!r.link.allowDownload) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Downloads are turned off for this link');
      }
      const n = r.node;
      await countDownload(ctx, req, r.link.id);
      return sendZip(
        ctx,
        req,
        reply,
        [
          {
            id: n.id,
            type: n.type,
            name: n.name,
            size: n.size,
            updatedAt: n.updatedAt,
            blobId: n.blobId,
            volumeId: n.volumeId,
          },
        ],
        `${n.name}.zip`,
      );
    },
  );
};
