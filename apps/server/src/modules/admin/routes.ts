import {
  AddVolumeBody,
  AdminInvite,
  AdminOverview,
  AdminUser,
  AuditPage,
  AuditQuery,
  CreateInviteBody,
  CreateInviteResponse,
  ErrorCode,
  formatBytes,
  IdParams,
  Ok,
  Settings,
  UpdateSettingsBody,
  UpdateUserBody,
  UpdateVolumeBody,
  Volume,
  VolumeCandidate,
} from '@familycloud/shared/all';
import { and, asc, desc, eq, gt, isNull, lt, max, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../../context';
import {
  auditLog,
  invites,
  sessions,
  storageVolumes,
  users,
  type VolumeRow,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { toAdminUser } from '../../lib/dto';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../lib/errors';
import { DAY_MS, toIso } from '../../lib/time';
import { requireAdmin } from '../../plugins/auth';

/** Advisory lock taken while an admin is demoted or disabled (see the last-admin guard). */
const ADMIN_GUARD_LOCK = 727_004;

async function volumeDtos(
  ctx: AppContext,
): Promise<{ list: Volume[]; devs: Map<string, number | null> }> {
  const rows = await ctx.db.select().from(storageVolumes).orderBy(asc(storageVolumes.createdAt));
  const usage = await ctx.volumes.usage();
  const devs = new Map<string, number | null>();
  const list = await Promise.all(
    rows.map(async (v) => {
      const rt = await ctx.volumes.status(v);
      devs.set(v.id, rt.dev);
      return {
        id: v.id,
        name: v.name,
        path: v.path,
        status: v.status,
        online: rt.online,
        capacityLimitBytes: v.capacityLimitBytes,
        reserveBytes: v.reserveBytes,
        usedByAppBytes: usage.get(v.id)?.bytes ?? 0,
        blobCount: usage.get(v.id)?.count ?? 0,
        disk: rt.disk,
        statusMessage: v.statusMessage ?? rt.error,
        createdAt: toIso(v.createdAt),
      };
    }),
  );
  return { list, devs };
}

async function listAdminUsers(ctx: AppContext) {
  const rows = await ctx.db
    .select({ user: users, lastSeen: max(sessions.lastSeenAt) })
    .from(users)
    .leftJoin(sessions, eq(sessions.userId, users.id))
    .groupBy(users.id)
    .orderBy(asc(users.createdAt));
  return rows.map((r) => toAdminUser(r.user, r.lastSeen));
}

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  // Every route in this plugin is admin-only.
  app.addHook('preHandler', async (req) => {
    requireAdmin(req);
  });

  app.get('/admin/overview', { schema: { response: { 200: AdminOverview } } }, async () => {
    const [{ list: volumes, devs }, userList, settings] = await Promise.all([
      volumeDtos(ctx),
      listAdminUsers(ctx),
      ctx.settings.get(),
    ]);

    // Physical capacity: count each filesystem once, even if several volumes live on it.
    const seenDevs = new Set<number>();
    let physicalTotal = 0;
    let physicalFree = 0;
    const warnings: string[] = [];
    for (const v of volumes) {
      if (v.status === 'retired') continue;
      if (!v.online) {
        warnings.push(`Volume "${v.name}" is offline: ${v.statusMessage ?? 'unavailable'}`);
        continue;
      }
      const dev = devs.get(v.id);
      if (dev != null && seenDevs.has(dev)) {
        const twin = volumes.find((o) => o.id !== v.id && devs.get(o.id) === dev);
        warnings.push(
          `Volume "${v.name}" is on the same disk as "${twin?.name}", so it adds no extra space.`,
        );
        continue;
      }
      if (dev != null) seenDevs.add(dev);
      if (v.disk) {
        const cap = v.capacityLimitBytes ?? v.disk.totalBytes;
        physicalTotal += Math.min(cap, v.disk.totalBytes);
        physicalFree += Math.max(0, v.disk.freeBytes - v.reserveBytes);
        if (v.disk.freeBytes < v.disk.totalBytes * 0.1) {
          warnings.push(
            `Volume "${v.name}" is over 90% full (${formatBytes(v.disk.freeBytes)} free).`,
          );
        }
      }
    }

    const used = userList.reduce((s, u) => s + u.usedBytes, 0);
    const reserved = userList.reduce((s, u) => s + u.reservedBytes, 0);
    const active = userList.filter((u) => !u.disabled);
    const allocated = active.reduce((s, u) => s + (u.quotaBytes ?? 0), 0);
    const unlimited = active.filter((u) => u.quotaBytes === null).length;
    const capacity = used + physicalFree;
    if (settings.globalCapacityBytes !== null && settings.globalCapacityBytes > capacity) {
      warnings.push(
        `The family storage limit (${formatBytes(settings.globalCapacityBytes)}) is more than the disks can hold (${formatBytes(capacity)}).`,
      );
    }
    const ceiling = Math.min(settings.globalCapacityBytes ?? Number.POSITIVE_INFINITY, capacity);
    if (allocated > ceiling) {
      warnings.push(
        `Quotas add up to ${formatBytes(allocated)}, more than the ${formatBytes(ceiling)} available. That's fine as long as not everyone fills up.`,
      );
    }
    for (const u of active) {
      if (u.quotaBytes !== null && u.usedBytes > u.quotaBytes) {
        warnings.push(`${u.displayName} is over quota and cannot upload until they free up space.`);
      }
    }

    return {
      volumes,
      users: userList,
      settings,
      totals: {
        physicalTotalBytes: physicalTotal,
        physicalFreeBytes: physicalFree,
        usedBytes: used,
        reservedBytes: reserved,
        allocatedQuotaBytes: allocated,
        unlimitedUsers: unlimited,
      },
      warnings,
    };
  });

  // ── users ─────────────────────────────────────────────────────────────────

  app.get(
    '/admin/users',
    { schema: { response: { 200: z.object({ items: z.array(AdminUser) }) } } },
    async () => ({ items: await listAdminUsers(ctx) }),
  );

  app.patch(
    '/admin/users/:id',
    { schema: { params: IdParams, body: UpdateUserBody, response: { 200: AdminUser } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const b = req.body;
      const { target, row } = await db.transaction(async (tx) => {
        // Serializes demotions/disables: two admins removing each other at the same moment
        // would otherwise both see "another admin remains" and leave nobody in charge.
        await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`);
        const [target] = await tx.select().from(users).where(eq(users.id, req.params.id));
        if (!target) throw notFound('User');
        if (target.id === admin.id && (b.role === 'member' || b.disabled === true)) {
          throw badRequest('You cannot demote or disable your own account');
        }
        if ((b.role === 'member' || b.disabled === true) && target.role === 'admin') {
          const [other] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(users)
            .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, target.id)));
          if ((other?.n ?? 0) === 0)
            throw badRequest('There must always be at least one active admin');
        }
        const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
        if (b.displayName !== undefined) patch.displayName = b.displayName;
        if (b.role !== undefined) patch.role = b.role;
        if (b.quotaBytes !== undefined) patch.quotaBytes = b.quotaBytes;
        if (b.disabled !== undefined) patch.disabledAt = b.disabled ? new Date() : null;
        const [row] = await tx.update(users).set(patch).where(eq(users.id, target.id)).returning();
        return { target, row: row! };
      });
      if (b.disabled) await ctx.sessions.revokeAll(db, target.id);
      ctx.sessions.forgetUser(target.id);
      ctx.davAuth.forgetUser(target.id);
      await audit(db, {
        actorId: admin.id,
        action: 'admin.user_updated',
        targetType: 'user',
        targetId: target.id,
        ip: req.clientIp,
        meta: {
          ...b,
          ...(b.quotaBytes !== undefined ? { previousQuotaBytes: target.quotaBytes } : {}),
        },
      });
      const [lastSeen] = await db
        .select({ at: max(sessions.lastSeenAt) })
        .from(sessions)
        .where(eq(sessions.userId, target.id));
      return toAdminUser(row, lastSeen?.at ?? null);
    },
  );

  app.post(
    '/admin/users/:id/reset-totp',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const [row] = await db
        .update(users)
        .set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null })
        .where(eq(users.id, req.params.id))
        .returning({ id: users.id });
      if (!row) throw notFound('User');
      ctx.sessions.forgetUser(row.id);
      await audit(db, {
        actorId: admin.id,
        action: 'admin.totp_reset',
        targetType: 'user',
        targetId: row.id,
        ip: req.clientIp,
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/admin/users/:id/sign-out',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user: admin, sessionId } = requireAdmin(req);
      await ctx.sessions.revokeAll(
        db,
        req.params.id,
        req.params.id === admin.id ? sessionId : undefined,
      );
      await audit(db, {
        actorId: admin.id,
        action: 'admin.sessions_revoked',
        targetType: 'user',
        targetId: req.params.id,
        ip: req.clientIp,
      });
      return { ok: true as const };
    },
  );

  // ── invites ───────────────────────────────────────────────────────────────

  app.get(
    '/admin/invites',
    { schema: { response: { 200: z.object({ items: z.array(AdminInvite) }) } } },
    async () => {
      const rows = await db
        .select({ invite: invites, by: { id: users.id, displayName: users.displayName } })
        .from(invites)
        .leftJoin(users, eq(users.id, invites.createdBy))
        .where(and(isNull(invites.usedAt), gt(invites.expiresAt, new Date())))
        .orderBy(desc(invites.createdAt));
      return {
        items: rows.map((r) => ({
          id: r.invite.id,
          email: r.invite.email,
          role: r.invite.role,
          quotaBytes: r.invite.quotaBytes,
          expiresAt: toIso(r.invite.expiresAt),
          createdAt: toIso(r.invite.createdAt),
          createdBy: r.by?.id ? { id: r.by.id, displayName: r.by.displayName } : null,
        })),
      };
    },
  );

  app.post(
    '/admin/invites',
    { schema: { body: CreateInviteBody, response: { 200: CreateInviteResponse } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const settings = await ctx.settings.get();
      const token = randomToken(24);
      const quota =
        req.body.quotaBytes === undefined ? settings.defaultQuotaBytes : req.body.quotaBytes;
      if (req.body.email) {
        const [exists] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, req.body.email));
        if (exists) throw conflict('That person already has an account');
      }
      const [row] = await db
        .insert(invites)
        .values({
          email: req.body.email ?? null,
          role: req.body.role,
          quotaBytes: quota,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + req.body.expiresInDays * DAY_MS),
          createdBy: admin.id,
        })
        .returning();
      await audit(db, {
        actorId: admin.id,
        action: 'admin.invite_created',
        targetType: 'invite',
        targetId: row!.id,
        ip: req.clientIp,
        meta: { email: row!.email, role: row!.role, quotaBytes: quota },
      });
      return {
        url: `${ctx.config.publicUrl}/invite/${token}`,
        invite: {
          id: row!.id,
          email: row!.email,
          role: row!.role,
          quotaBytes: row!.quotaBytes,
          expiresAt: toIso(row!.expiresAt),
          createdAt: toIso(row!.createdAt),
          createdBy: { id: admin.id, displayName: admin.displayName },
        },
      };
    },
  );

  app.delete(
    '/admin/invites/:id',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      // Expire rather than delete, so the audit trail keeps a reference.
      const revoked = await db
        .update(invites)
        .set({ expiresAt: new Date() })
        .where(
          and(
            eq(invites.id, req.params.id),
            isNull(invites.usedAt),
            gt(invites.expiresAt, new Date()),
          ),
        )
        .returning({ id: invites.id });
      if (revoked.length > 0) {
        await audit(db, {
          actorId: admin.id,
          action: 'admin.invite_revoked',
          targetType: 'invite',
          targetId: req.params.id,
          ip: req.clientIp,
        });
      }
      return { ok: true as const };
    },
  );

  // ── volumes ───────────────────────────────────────────────────────────────

  app.get(
    '/admin/volumes/candidates',
    {
      schema: {
        response: { 200: z.object({ root: z.string(), items: z.array(VolumeCandidate) }) },
      },
    },
    async () => {
      const [cands, { list, devs }] = await Promise.all([
        ctx.volumes.candidates(),
        volumeDtos(ctx),
      ]);
      return {
        root: ctx.config.volumesRoot,
        items: cands.map((c) => {
          const twin = list.find(
            (v) =>
              v.status !== 'retired' && c.runtime.dev != null && devs.get(v.id) === c.runtime.dev,
          );
          return {
            path: c.path,
            name: c.name,
            totalBytes: c.runtime.disk?.totalBytes ?? 0,
            freeBytes: c.runtime.disk?.freeBytes ?? 0,
            sameFilesystemAs: twin?.name ?? null,
          };
        }),
      };
    },
  );

  async function volumeById(id: string): Promise<VolumeRow> {
    const [v] = await db.select().from(storageVolumes).where(eq(storageVolumes.id, id));
    if (!v) throw notFound('Volume');
    return v;
  }

  async function volumeDto(id: string): Promise<Volume> {
    ctx.volumes.invalidate(id);
    const { list } = await volumeDtos(ctx);
    return list.find((v) => v.id === id)!;
  }

  app.post(
    '/admin/volumes',
    { schema: { body: AddVolumeBody, response: { 200: Volume } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const realPath = await ctx.volumes.validateNewPath(req.body.path);
      const row = await ctx.volumes
        .register({
          name: req.body.name,
          path: realPath,
          capacityLimitBytes: req.body.capacityLimitBytes ?? null,
          reserveBytes: req.body.reserveBytes ?? 0,
        })
        .catch((err: unknown) => {
          // A double-clicked "Add" races past validateNewPath's check; the unique index decides.
          if (isUniqueViolation(err, 'storage_volumes_path_key')) {
            throw conflict('That directory is already a volume');
          }
          throw err;
        });
      await audit(db, {
        actorId: admin.id,
        action: 'admin.volume_added',
        targetType: 'volume',
        targetId: row.id,
        ip: req.clientIp,
        meta: { name: row.name, path: row.path },
      });
      return volumeDto(row.id);
    },
  );

  app.patch(
    '/admin/volumes/:id',
    { schema: { params: IdParams, body: UpdateVolumeBody, response: { 200: Volume } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const v = await volumeById(req.params.id);
      if (req.body.status && (v.status === 'draining' || v.status === 'retired')) {
        throw conflict(`Volume is ${v.status}; use the drain controls instead`);
      }
      await db
        .update(storageVolumes)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(storageVolumes.id, v.id));
      await audit(db, {
        actorId: admin.id,
        action: 'admin.volume_updated',
        targetType: 'volume',
        targetId: v.id,
        ip: req.clientIp,
        meta: req.body,
      });
      return volumeDto(v.id);
    },
  );

  app.post(
    '/admin/volumes/:id/drain',
    { schema: { params: IdParams, response: { 200: Volume } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const v = await volumeById(req.params.id);
      if (v.status === 'retired') throw conflict('Volume is already retired');
      // Make sure the rest of the pool can take this volume's files before starting.
      const others = (await volumeDtos(ctx)).list.filter(
        (o) => o.id !== v.id && o.status === 'active' && o.online && o.disk,
      );
      const stored = (await ctx.volumes.usage()).get(v.id)?.bytes ?? 0;
      const room = others.reduce(
        (s, o) => s + Math.max(0, (o.disk?.freeBytes ?? 0) - o.reserveBytes),
        0,
      );
      if (others.length === 0) {
        throw new AppError(
          409,
          ErrorCode.STORAGE_FULL,
          'Add another active volume before draining this one',
        );
      }
      if (room < stored) {
        throw new AppError(
          409,
          ErrorCode.STORAGE_FULL,
          `Other volumes have ${formatBytes(room)} free but this one holds ${formatBytes(stored)}`,
        );
      }
      await db
        .update(storageVolumes)
        .set({
          status: 'draining',
          statusMessage: 'Waiting to start moving files…',
          updatedAt: new Date(),
        })
        .where(eq(storageVolumes.id, v.id));
      await ctx.jobs.send('drain-volume', { volumeId: v.id });
      await audit(db, {
        actorId: admin.id,
        action: 'admin.volume_drain_started',
        targetType: 'volume',
        targetId: v.id,
        ip: req.clientIp,
      });
      return volumeDto(v.id);
    },
  );

  app.post(
    '/admin/volumes/:id/cancel-drain',
    { schema: { params: IdParams, response: { 200: Volume } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const v = await volumeById(req.params.id);
      if (v.status !== 'draining') throw conflict('Volume is not draining');
      await db
        .update(storageVolumes)
        .set({
          status: 'readonly',
          statusMessage: 'Drain cancelled; volume is read-only',
          updatedAt: new Date(),
        })
        .where(eq(storageVolumes.id, v.id));
      await audit(db, {
        actorId: admin.id,
        action: 'admin.volume_drain_cancelled',
        targetType: 'volume',
        targetId: v.id,
        ip: req.clientIp,
      });
      return volumeDto(v.id);
    },
  );

  // ── settings & audit ──────────────────────────────────────────────────────

  app.get('/admin/settings', { schema: { response: { 200: Settings } } }, async () =>
    ctx.settings.get(),
  );

  app.patch(
    '/admin/settings',
    { schema: { body: UpdateSettingsBody, response: { 200: Settings } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const before = await ctx.settings.get();
      const next = await ctx.settings.update(req.body);
      await audit(db, {
        actorId: admin.id,
        action: 'admin.settings_updated',
        ip: req.clientIp,
        meta: { before, after: next },
      });
      return next;
    },
  );

  app.get(
    '/admin/audit',
    { schema: { querystring: AuditQuery, response: { 200: AuditPage } } },
    async (req) => {
      const rows = await db
        .select({ entry: auditLog, actor: { id: users.id, displayName: users.displayName } })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorId))
        .where(req.query.before ? lt(auditLog.id, req.query.before) : undefined)
        .orderBy(desc(auditLog.id))
        .limit(req.query.limit + 1);
      const page = rows.slice(0, req.query.limit);
      return {
        items: page.map((r) => ({
          id: r.entry.id,
          actor: r.actor?.id ? { id: r.actor.id, displayName: r.actor.displayName } : null,
          action: r.entry.action,
          targetType: r.entry.targetType,
          targetId: r.entry.targetId,
          ip: r.entry.ip,
          meta: r.entry.meta,
          createdAt: toIso(r.entry.createdAt),
        })),
        nextCursor:
          rows.length > req.query.limit ? (page[page.length - 1]?.entry.id ?? null) : null,
      };
    },
  );
};
