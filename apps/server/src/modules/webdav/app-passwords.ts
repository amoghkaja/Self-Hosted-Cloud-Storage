import {
  AppPassword,
  CreateAppPasswordBody,
  CreateAppPasswordResponse,
  ErrorCode,
  IdParams,
  Ok,
} from '@familycloud/shared/all';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appPasswords } from '../../db/schema';
import { audit } from '../../lib/audit';
import { AppError, notFound } from '../../lib/errors';
import { toIso, toIsoOrNull } from '../../lib/time';
import { requireUser } from '../../plugins/auth';
import { strictLimit } from '../../plugins/security';
import { confirmPassword } from '../auth/service';
import { generateAppPassword, hashAppPassword } from './auth';

const MAX_PER_USER = 25;

/** Manage per-device passwords for the network drive (signed-in web session required). */
export const appPasswordRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  app.get(
    '/auth/app-passwords',
    { schema: { response: { 200: z.object({ items: z.array(AppPassword) }) } } },
    async (req) => {
      const { user } = requireUser(req);
      const rows = await db
        .select()
        .from(appPasswords)
        .where(eq(appPasswords.userId, user.id))
        .orderBy(desc(appPasswords.createdAt));
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          createdAt: toIso(r.createdAt),
          lastUsedAt: toIsoOrNull(r.lastUsedAt),
        })),
      };
    },
  );

  app.post(
    '/auth/app-passwords',
    {
      config: strictLimit(20),
      schema: { body: CreateAppPasswordBody, response: { 200: CreateAppPasswordResponse } },
    },
    async (req) => {
      const { user } = requireUser(req);
      await confirmPassword(db, user.id, req.body.password, req.clientIp);
      const password = generateAppPassword();
      // Count and insert under a per-user lock so parallel requests can't exceed the limit.
      const row = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`app-passwords:${user.id}`}))`,
        );
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(appPasswords)
          .where(eq(appPasswords.userId, user.id));
        if ((count?.n ?? 0) >= MAX_PER_USER) {
          throw new AppError(
            409,
            ErrorCode.CONFLICT,
            `You can have up to ${MAX_PER_USER} devices. Remove an old one first.`,
          );
        }
        const [inserted] = await tx
          .insert(appPasswords)
          .values({ userId: user.id, name: req.body.name, tokenHash: hashAppPassword(password) })
          .returning();
        return inserted!;
      });
      await audit(db, {
        actorId: user.id,
        action: 'app_password.created',
        targetType: 'app_password',
        targetId: row.id,
        ip: req.clientIp,
        meta: { name: row.name },
      });
      return {
        appPassword: {
          id: row.id,
          name: row.name,
          createdAt: toIso(row.createdAt),
          lastUsedAt: null,
        },
        password,
        davUrl: `${ctx.config.publicUrl}/dav/`,
        username: user.email,
      };
    },
  );

  app.delete(
    '/auth/app-passwords/:id',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      const rows = await db
        .delete(appPasswords)
        .where(and(eq(appPasswords.id, req.params.id), eq(appPasswords.userId, user.id)))
        .returning({ id: appPasswords.id });
      if (!rows[0]) throw notFound('Device');
      ctx.davAuth.forgetUser(user.id);
      await audit(db, {
        actorId: user.id,
        action: 'app_password.revoked',
        targetType: 'app_password',
        targetId: req.params.id,
        ip: req.clientIp,
      });
      return { ok: true as const };
    },
  );
};
