import {
  AcceptInviteBody,
  ChangePasswordBody,
  ErrorCode,
  IdParams,
  InviteInfo,
  LoginBody,
  LoginResponse,
  LoginTotpBody,
  Me,
  Ok,
  SessionInfo,
  SetupBody,
  SetupStatus,
  TokenParams,
  TotpDisableBody,
  TotpEnableBody,
  TotpSetupResponse,
  UpdateProfileBody,
} from '@familycloud/shared/all';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ensureSetupToken } from '../../context';
import { invites, sessions, type UserRow, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { safeEqual, sha256 } from '../../lib/crypto';
import { toMe } from '../../lib/dto';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/passwords';
import { toIso } from '../../lib/time';
import { clearSessionCookie, requestMeta, requireUser, setSessionCookie } from '../../plugins/auth';
import { strictLimit } from '../../plugins/security';
import { checkTotp, createUserWithRoot, newTotp } from './service';

const LOCK_AFTER = 5;
const MFA_TOKEN_TTL = 5 * 60;

const invalidCredentials = () =>
  new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect');

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  async function startSession(req: FastifyRequest, reply: FastifyReply, user: UserRow) {
    const s = await ctx.sessions.create(db, user.id, requestMeta(req));
    setSessionCookie(ctx, reply, s.token, s.absoluteExpiresAt);
  }

  const locked = (until: Date | null) => {
    const minutes = until ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000)) : 1;
    return new AppError(
      429,
      ErrorCode.ACCOUNT_LOCKED,
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  };

  /**
   * Counts a sign-in attempt *before* the secret is checked, in one atomic statement, and
   * refuses it while the account is locked. Counting first means a burst of parallel guesses
   * can't all read "not locked" before any failure is written: the row lock serializes them and
   * the 6th sees the lock set by the 5th. The counter is reset only after a full sign-in.
   * Lock length doubles from 1 minute per extra failure, capped at 60 minutes.
   */
  async function claimAttempt(userId: string): Promise<number> {
    const [row] = await db
      .update(users)
      .set({
        failedLogins: sql`${users.failedLogins} + 1`,
        lockedUntil: sql`CASE WHEN ${users.failedLogins} + 1 >= ${LOCK_AFTER}
          THEN now() + make_interval(mins => least(power(2, ${users.failedLogins} + 1 - ${LOCK_AFTER}), 60)::int)
          ELSE NULL END`,
      })
      .where(
        and(
          eq(users.id, userId),
          sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= now())`,
        ),
      )
      .returning({ attempts: users.failedLogins });
    if (row) return row.attempts;
    const [current] = await db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, userId));
    throw locked(current?.lockedUntil ?? null);
  }

  async function auditFailure(
    userId: string,
    req: FastifyRequest,
    reason: string,
    attempts: number,
  ) {
    await audit(db, {
      actorId: userId,
      action: 'auth.login_failed',
      ip: req.clientIp,
      meta: { reason, attempts },
    });
  }

  // ── first-run setup ───────────────────────────────────────────────────────

  app.get('/auth/setup-status', { schema: { response: { 200: SetupStatus } } }, async () => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    return { needsSetup: (row?.n ?? 0) === 0, appName: ctx.config.appName };
  });

  app.post(
    '/auth/setup',
    { config: strictLimit(5), schema: { body: SetupBody, response: { 200: Me } } },
    async (req, reply) => {
      const expected = await ensureSetupToken(ctx);
      if (!expected) throw conflict('Setup is already complete', ErrorCode.SETUP_COMPLETE);
      if (!safeEqual(req.body.setupToken.trim(), expected)) {
        throw forbidden('Setup token is incorrect. Find it in the server logs.');
      }
      const passwordHash = await hashPassword(req.body.password);
      const user = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(727003)`);
        const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
        if ((row?.n ?? 0) > 0)
          throw conflict('Setup is already complete', ErrorCode.SETUP_COMPLETE);
        return createUserWithRoot(tx, {
          email: req.body.email,
          displayName: req.body.displayName,
          passwordHash,
          role: 'admin',
          quotaBytes: null,
        });
      });
      await ctx.settings.setRaw('setupToken', null);
      await startSession(req, reply, user);
      await audit(db, { actorId: user.id, action: 'auth.setup', ip: req.clientIp });
      return toMe(user);
    },
  );

  // ── login ─────────────────────────────────────────────────────────────────

  app.post(
    '/auth/login',
    { config: strictLimit(10), schema: { body: LoginBody, response: { 200: LoginResponse } } },
    async (req, reply) => {
      const [user] = await db.select().from(users).where(eq(users.email, req.body.email));
      const attempts = user ? await claimAttempt(user.id) : 0;
      const ok = await verifyPassword(user?.passwordHash ?? null, req.body.password);
      if (!user || !ok || user.disabledAt) {
        if (user) await auditFailure(user.id, req, !ok ? 'password' : 'disabled', attempts);
        throw invalidCredentials();
      }
      // With two-factor on, the counter keeps running until the code is also correct, so knowing
      // the password can't be used to reset the lockout between TOTP guesses.
      if (user.totpEnabled) {
        return {
          status: 'mfa_required' as const,
          mfaToken: ctx.keys.sign('mfa', { uid: user.id }, MFA_TOKEN_TTL),
        };
      }
      await db
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      await startSession(req, reply, user);
      await audit(db, { actorId: user.id, action: 'auth.login', ip: req.clientIp });
      return { status: 'ok' as const, user: toMe(user) };
    },
  );

  app.post(
    '/auth/login/totp',
    { config: strictLimit(10), schema: { body: LoginTotpBody, response: { 200: LoginResponse } } },
    async (req, reply) => {
      const claims = ctx.keys.verify<{ uid: string }>('mfa', req.body.mfaToken);
      if (!claims) {
        throw new AppError(401, ErrorCode.MFA_INVALID, 'Sign-in expired, please start again');
      }
      const [user] = await db.select().from(users).where(eq(users.id, claims.uid));
      if (!user || user.disabledAt || !user.totpEnabled || !user.totpSecretEnc) {
        throw new AppError(401, ErrorCode.MFA_INVALID, 'Sign-in expired, please start again');
      }
      const attempts = await claimAttempt(user.id);
      const step = checkTotp(ctx, user.totpSecretEnc, req.body.code, user.totpLastStep);
      if (step === null) {
        await auditFailure(user.id, req, 'totp', attempts);
        throw new AppError(401, ErrorCode.MFA_INVALID, 'That code is not valid');
      }
      // Consume the time-step atomically: two parallel requests with the same code can't both win.
      const consumed = await db
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null, totpLastStep: step })
        .where(
          and(
            eq(users.id, user.id),
            sql`(${users.totpLastStep} IS NULL OR ${users.totpLastStep} < ${step})`,
          ),
        )
        .returning({ id: users.id });
      if (consumed.length === 0) {
        await auditFailure(user.id, req, 'totp_replay', attempts);
        throw new AppError(401, ErrorCode.MFA_INVALID, 'That code was already used');
      }
      await startSession(req, reply, user);
      await audit(db, {
        actorId: user.id,
        action: 'auth.login',
        ip: req.clientIp,
        meta: { mfa: true },
      });
      return { status: 'ok' as const, user: toMe(user) };
    },
  );

  app.post('/auth/logout', { schema: { response: { 200: Ok } } }, async (req, reply) => {
    if (req.auth) await ctx.sessions.revoke(db, req.auth.sessionId, req.auth.user.id);
    clearSessionCookie(ctx, reply);
    return { ok: true as const };
  });

  // ── profile ───────────────────────────────────────────────────────────────

  app.get('/auth/me', { schema: { response: { 200: Me } } }, async (req) => {
    const { user } = requireUser(req);
    // Fresh read: usage changes constantly and the session cache may hold an older copy.
    const [fresh] = await db.select().from(users).where(eq(users.id, user.id));
    return toMe(fresh!);
  });

  app.patch(
    '/auth/me',
    { schema: { body: UpdateProfileBody, response: { 200: Me } } },
    async (req) => {
      const { user } = requireUser(req);
      const [row] = await db
        .update(users)
        .set({ displayName: req.body.displayName, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();
      ctx.sessions.forgetUser(user.id);
      return toMe(row!);
    },
  );

  app.post(
    '/auth/password',
    { config: strictLimit(10), schema: { body: ChangePasswordBody, response: { 200: Ok } } },
    async (req) => {
      const { user, sessionId } = requireUser(req);
      const [fresh] = await db.select().from(users).where(eq(users.id, user.id));
      if (!(await verifyPassword(fresh!.passwordHash, req.body.currentPassword))) {
        throw new AppError(400, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
      }
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.newPassword), updatedAt: new Date() })
        .where(eq(users.id, user.id));
      // A changed password should end every other session (e.g. a stolen laptop).
      await ctx.sessions.revokeAll(db, user.id, sessionId);
      await audit(db, { actorId: user.id, action: 'auth.password_changed', ip: req.clientIp });
      return { ok: true as const };
    },
  );

  // ── sessions ──────────────────────────────────────────────────────────────

  app.get(
    '/auth/sessions',
    { schema: { response: { 200: z.object({ items: z.array(SessionInfo) }) } } },
    async (req) => {
      const { user, sessionId } = requireUser(req);
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())))
        .orderBy(desc(sessions.lastSeenAt));
      return {
        items: rows.map((s) => ({
          id: s.id,
          ip: s.ip,
          userAgent: s.userAgent,
          createdAt: toIso(s.createdAt),
          lastSeenAt: toIso(s.lastSeenAt),
          current: s.id === sessionId,
        })),
      };
    },
  );

  app.delete(
    '/auth/sessions/:id',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req, reply) => {
      const { user, sessionId } = requireUser(req);
      if (!(await ctx.sessions.revoke(db, req.params.id, user.id))) throw notFound('Session');
      if (req.params.id === sessionId) clearSessionCookie(ctx, reply);
      return { ok: true as const };
    },
  );

  // ── two-factor ────────────────────────────────────────────────────────────

  app.post(
    '/auth/totp/setup',
    { schema: { response: { 200: TotpSetupResponse } } },
    async (req) => {
      const { user } = requireUser(req);
      if (user.totpEnabled) throw conflict('Two-factor authentication is already on');
      const { secretBase32, url } = newTotp(ctx, user.email);
      await db
        .update(users)
        .set({ totpSecretEnc: ctx.keys.encrypt('totp', secretBase32), totpLastStep: null })
        .where(eq(users.id, user.id));
      return { secret: secretBase32, otpauthUrl: url };
    },
  );

  app.post(
    '/auth/totp/enable',
    { config: strictLimit(10), schema: { body: TotpEnableBody, response: { 200: Me } } },
    async (req) => {
      const { user } = requireUser(req);
      const [fresh] = await db.select().from(users).where(eq(users.id, user.id));
      if (!fresh?.totpSecretEnc || fresh.totpEnabled) {
        throw conflict('Start two-factor setup first');
      }
      const step = checkTotp(ctx, fresh.totpSecretEnc, req.body.code, null);
      if (step === null) throw new AppError(400, ErrorCode.MFA_INVALID, 'That code is not valid');
      const [row] = await db
        .update(users)
        .set({ totpEnabled: true, totpLastStep: step })
        .where(eq(users.id, user.id))
        .returning();
      ctx.sessions.forgetUser(user.id);
      await audit(db, { actorId: user.id, action: 'auth.totp_enabled', ip: req.clientIp });
      return toMe(row!);
    },
  );

  app.post(
    '/auth/totp/disable',
    { config: strictLimit(10), schema: { body: TotpDisableBody, response: { 200: Me } } },
    async (req) => {
      const { user } = requireUser(req);
      const [fresh] = await db.select().from(users).where(eq(users.id, user.id));
      if (!fresh?.totpEnabled || !fresh.totpSecretEnc) throw conflict('Two-factor is not on');
      const passwordOk = await verifyPassword(fresh.passwordHash, req.body.password);
      const step = checkTotp(ctx, fresh.totpSecretEnc, req.body.code, fresh.totpLastStep);
      if (!passwordOk || step === null) {
        throw new AppError(400, ErrorCode.MFA_INVALID, 'Password or code is incorrect');
      }
      const [row] = await db
        .update(users)
        .set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null })
        .where(eq(users.id, user.id))
        .returning();
      ctx.sessions.forgetUser(user.id);
      await audit(db, { actorId: user.id, action: 'auth.totp_disabled', ip: req.clientIp });
      return toMe(row!);
    },
  );

  // ── invites ───────────────────────────────────────────────────────────────

  async function findInvite(token: string) {
    const [row] = await db
      .select({ invite: invites, invitedBy: users.displayName })
      .from(invites)
      .leftJoin(users, eq(users.id, invites.createdBy))
      .where(
        and(
          eq(invites.tokenHash, sha256(token)),
          isNull(invites.usedAt),
          gt(invites.expiresAt, new Date()),
        ),
      );
    if (!row)
      throw new AppError(
        404,
        ErrorCode.INVITE_INVALID,
        'This invite link is invalid or has expired',
      );
    return row;
  }

  app.get(
    '/invites/:token',
    { config: strictLimit(30), schema: { params: TokenParams, response: { 200: InviteInfo } } },
    async (req) => {
      const { invite, invitedBy } = await findInvite(req.params.token);
      return {
        email: invite.email,
        role: invite.role,
        expiresAt: toIso(invite.expiresAt),
        invitedBy: invitedBy ?? ctx.config.appName,
      };
    },
  );

  app.post(
    '/invites/:token/accept',
    {
      config: strictLimit(10),
      schema: { params: TokenParams, body: AcceptInviteBody, response: { 200: Me } },
    },
    async (req, reply) => {
      const { invite } = await findInvite(req.params.token);
      if (invite.email && invite.email !== req.body.email) {
        throw new AppError(400, ErrorCode.INVITE_INVALID, `This invite is for ${invite.email}`);
      }
      const passwordHash = await hashPassword(req.body.password);
      const user = await db.transaction(async (tx) => {
        // Single use: only one concurrent accept can flip used_at.
        const [claimed] = await tx
          .update(invites)
          .set({ usedAt: new Date() })
          .where(and(eq(invites.id, invite.id), isNull(invites.usedAt)))
          .returning();
        if (!claimed)
          throw new AppError(404, ErrorCode.INVITE_INVALID, 'This invite was already used');
        const created = await createUserWithRoot(tx, {
          email: req.body.email,
          displayName: req.body.displayName,
          passwordHash,
          role: claimed.role,
          quotaBytes: claimed.quotaBytes,
        });
        await tx.update(invites).set({ usedBy: created.id }).where(eq(invites.id, claimed.id));
        return created;
      });
      await startSession(req, reply, user);
      await audit(db, {
        actorId: user.id,
        action: 'user.joined',
        targetType: 'invite',
        targetId: invite.id,
        ip: req.clientIp,
      });
      return toMe(user);
    },
  );
};
