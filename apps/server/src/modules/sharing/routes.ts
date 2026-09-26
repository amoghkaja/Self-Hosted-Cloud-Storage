import {
  CreateShareBody,
  DirectoryUser,
  IdParams,
  Ok,
  Share,
  SharedWithMeItem,
  UpdateShareBody,
} from '@familycloud/shared';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { blobs, nodes, shares, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { toFileNode } from '../../lib/dto';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors';
import { toIso } from '../../lib/time';
import { requireUser } from '../../plugins/auth';
import { requireAccess } from '../files/access';

export const sharingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  app.get(
    '/users/directory',
    { schema: { response: { 200: z.object({ items: z.array(DirectoryUser) }) } } },
    async (req) => {
      const { user } = requireUser(req);
      const rows = await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(and(isNull(users.disabledAt), ne(users.id, user.id)))
        .orderBy(asc(users.displayName));
      return { items: rows };
    },
  );

  async function listShares(nodeId: string) {
    const rows = await db
      .select({
        share: shares,
        grantee: { id: users.id, displayName: users.displayName, email: users.email },
      })
      .from(shares)
      .innerJoin(users, eq(users.id, shares.granteeId))
      .where(eq(shares.nodeId, nodeId))
      .orderBy(asc(users.displayName));
    return rows.map((r) => ({
      id: r.share.id,
      nodeId: r.share.nodeId,
      grantee: r.grantee,
      permission: r.share.permission,
      createdAt: toIso(r.share.createdAt),
    }));
  }

  app.get(
    '/nodes/:id/shares',
    { schema: { params: IdParams, response: { 200: z.object({ items: z.array(Share) }) } } },
    async (req) => {
      const { user } = requireUser(req);
      await requireAccess(db, user.id, req.params.id, 'owner');
      return { items: await listShares(req.params.id) };
    },
  );

  app.post(
    '/nodes/:id/shares',
    { schema: { params: IdParams, body: CreateShareBody, response: { 200: Share } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await requireAccess(db, user.id, req.params.id, 'owner');
      if (a.isRoot)
        throw badRequest('Share a folder inside My Files instead of everything at once');
      if (req.body.userId === user.id) throw badRequest('You already own this');
      const [grantee] = await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(and(eq(users.id, req.body.userId), isNull(users.disabledAt)));
      if (!grantee) throw notFound('User');
      let row: typeof shares.$inferSelect | undefined;
      try {
        [row] = await db
          .insert(shares)
          .values({
            nodeId: a.node.id,
            granteeId: grantee.id,
            permission: req.body.permission,
            createdBy: user.id,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`Already shared with ${grantee.displayName}`);
        throw err;
      }
      await audit(db, {
        actorId: user.id,
        action: 'share.created',
        targetType: 'node',
        targetId: a.node.id,
        ip: req.clientIp,
        meta: { grantee: grantee.id, permission: req.body.permission },
      });
      return {
        id: row!.id,
        nodeId: row!.nodeId,
        grantee,
        permission: row!.permission,
        createdAt: toIso(row!.createdAt),
      };
    },
  );

  async function ownedShare(userId: string, shareId: string) {
    const [row] = await db
      .select({ share: shares, ownerId: nodes.ownerId })
      .from(shares)
      .innerJoin(nodes, eq(nodes.id, shares.nodeId))
      .where(eq(shares.id, shareId));
    // Grantees may remove themselves; only owners may change or remove anyone else.
    if (!row) throw notFound('Share');
    if (row.ownerId !== userId && row.share.granteeId !== userId) throw notFound('Share');
    return row;
  }

  app.patch(
    '/shares/:id',
    { schema: { params: IdParams, body: UpdateShareBody, response: { 200: Share } } },
    async (req) => {
      const { user } = requireUser(req);
      const row = await ownedShare(user.id, req.params.id);
      if (row.ownerId !== user.id) throw forbidden();
      await db
        .update(shares)
        .set({ permission: req.body.permission })
        .where(eq(shares.id, row.share.id));
      const updated = (await listShares(row.share.nodeId)).find((s) => s.id === row.share.id);
      return updated!;
    },
  );

  app.delete(
    '/shares/:id',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      const row = await ownedShare(user.id, req.params.id);
      await db.delete(shares).where(eq(shares.id, row.share.id));
      await audit(db, {
        actorId: user.id,
        action: 'share.removed',
        targetType: 'node',
        targetId: row.share.nodeId,
        ip: req.clientIp,
        meta: { grantee: row.share.granteeId },
      });
      return { ok: true as const };
    },
  );

  app.get(
    '/shared-with-me',
    { schema: { response: { 200: z.object({ items: z.array(SharedWithMeItem) }) } } },
    async (req) => {
      const { user } = requireUser(req);
      const rows = await db
        .select({
          share: shares,
          node: nodes,
          thumb: blobs.thumbStatus,
          owner: { id: users.id, displayName: users.displayName },
        })
        .from(shares)
        .innerJoin(nodes, eq(nodes.id, shares.nodeId))
        .innerJoin(users, eq(users.id, nodes.ownerId))
        .leftJoin(blobs, eq(blobs.id, nodes.blobId))
        .where(and(eq(shares.granteeId, user.id), isNull(nodes.deletedAt)))
        .orderBy(desc(shares.createdAt));
      return {
        items: rows.map((r) => ({
          shareId: r.share.id,
          permission: r.share.permission,
          node: toFileNode({ ...r.node, thumb: r.thumb }),
          owner: r.owner,
          sharedAt: toIso(r.share.createdAt),
        })),
      };
    },
  );
};
