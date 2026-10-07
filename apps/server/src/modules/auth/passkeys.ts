import {
  ConfirmPasswordBody,
  ErrorCode,
  emailAllowed,
  LoginResponse,
  Ok,
  Passkey,
  PasskeyLoginBody,
  PasskeyOptions,
  RegisterPasskeyBody,
  RenamePasskeyBody,
} from '@familycloud/shared/all';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import { type PasskeyRow, passkeys, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { toMe } from '../../lib/dto';
import { AppError, notFound } from '../../lib/errors';
import { toIso, toIsoOrNull } from '../../lib/time';
import { requestMeta, requireUser, setSessionCookie } from '../../plugins/auth';
import { strictLimit } from '../../plugins/security';
import { confirmPassword } from './service';

const CHALLENGE_TTL = 5 * 60;
const MAX_PER_USER = 20;

const invalid = (message = 'That passkey could not be verified. Try again.') =>
  new AppError(401, ErrorCode.PASSKEY_INVALID, message);

function toDto(p: PasskeyRow): Passkey {
  return {
    id: p.id,
    name: p.name,
    backedUp: p.backedUp,
    createdAt: toIso(p.createdAt),
    lastUsedAt: toIsoOrNull(p.lastUsedAt),
  };
}

/** "iPhone" / "Mac" / "Windows" from the browser, as a default name people recognise. */
function deviceName(userAgent: string | undefined) {
  const ua = userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}

/**
 * Passkeys (WebAuthn): sign in with Face ID / Touch ID, synced through iCloud Keychain or Google
 * Password Manager. They are phishing-resistant and verify the person (biometric or device PIN),
 * so a passkey sign-in counts as two factors and skips the TOTP step.
 *
 * Challenges travel in short-lived signed tokens, so no server-side state is needed, and each
 * token is accepted once (in-memory; the API runs as a single process).
 */
export const passkeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;
  const rpID = ctx.config.passkeyRpId;
  const origin = ctx.config.publicOrigin;
  const used = new LRUCache<string, true>({ max: 10_000, ttl: CHALLENGE_TTL * 1000 });

  /**
   * Returns the challenge in a token once; a replayed challenge is refused. Keyed by the
   * challenge, not the token text: "<token>.x" verifies too, and synced passkeys always report a
   * signature counter of 0, so nothing else would stop a captured sign-in being sent again.
   */
  function takeChallenge(purpose: string, token: string) {
    const claims = ctx.keys.verify<{ c: string; uid?: string }>(purpose, token);
    if (!claims || used.has(claims.c)) throw invalid('This sign-in request expired. Try again.');
    used.set(claims.c, true);
    return claims;
  }

  // ── registration (signed in) ────────────────────────────────────────────

  app.get('/auth/passkeys', { schema: { response: { 200: z.array(Passkey) } } }, async (req) => {
    const { user } = requireUser(req);
    const rows = await db
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, user.id))
      .orderBy(asc(passkeys.createdAt));
    return rows.map(toDto);
  });

  app.post(
    '/auth/passkeys/register/options',
    {
      config: strictLimit(20),
      schema: { body: ConfirmPasswordBody, response: { 200: PasskeyOptions } },
    },
    async (req) => {
      const { user } = requireUser(req);
      await confirmPassword(db, user.id, req.body.password);
      const existing = await db
        .select({ id: passkeys.credentialId, transports: passkeys.transports })
        .from(passkeys)
        .where(eq(passkeys.userId, user.id));
      const options = await generateRegistrationOptions({
        rpName: ctx.config.appName,
        rpID,
        userName: user.email,
        userDisplayName: user.displayName,
        userID: new TextEncoder().encode(user.id),
        attestationType: 'none',
        // Don't create a second passkey on a device that already has one for this account.
        excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports ?? [] })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      return {
        options: options as unknown as Record<string, unknown>,
        token: ctx.keys.sign('passkey-reg', { c: options.challenge, uid: user.id }, CHALLENGE_TTL),
      };
    },
  );

  app.post(
    '/auth/passkeys',
    { config: strictLimit(20), schema: { body: RegisterPasskeyBody, response: { 200: Passkey } } },
    async (req) => {
      const { user } = requireUser(req);
      const claims = takeChallenge('passkey-reg', req.body.token);
      if (claims.uid !== user.id) throw invalid();
      let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        result = await verifyRegistrationResponse({
          response: req.body.response as unknown as RegistrationResponseJSON,
          expectedChallenge: claims.c,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch {
        throw invalid();
      }
      if (!result.verified) throw invalid();
      const { credential, credentialBackedUp } = result.registrationInfo;
      const row = await db.transaction(async (tx) => {
        const count = await tx.$count(passkeys, eq(passkeys.userId, user.id));
        if (count >= MAX_PER_USER) {
          throw new AppError(
            409,
            ErrorCode.CONFLICT,
            `You can have up to ${MAX_PER_USER} passkeys`,
          );
        }
        const [inserted] = await tx
          .insert(passkeys)
          .values({
            userId: user.id,
            name: req.body.name ?? deviceName(req.headers['user-agent']),
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
            transports: credential.transports ?? null,
            backedUp: credentialBackedUp,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) throw new AppError(409, ErrorCode.CONFLICT, 'That passkey is already added');
        return inserted;
      });
      await audit(db, {
        actorId: user.id,
        action: 'auth.passkey_added',
        targetType: 'passkey',
        targetId: row.id,
        ip: req.clientIp,
      });
      return toDto(row);
    },
  );

  app.patch(
    '/auth/passkeys/:id',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        body: RenamePasskeyBody,
        response: { 200: Passkey },
      },
    },
    async (req) => {
      const { user } = requireUser(req);
      const [row] = await db
        .update(passkeys)
        .set({ name: req.body.name })
        .where(and(eq(passkeys.id, req.params.id), eq(passkeys.userId, user.id)))
        .returning();
      if (!row) throw notFound('Passkey');
      return toDto(row);
    },
  );

  app.delete(
    '/auth/passkeys/:id',
    { schema: { params: z.object({ id: z.uuid() }), response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      const [row] = await db
        .delete(passkeys)
        .where(and(eq(passkeys.id, req.params.id), eq(passkeys.userId, user.id)))
        .returning({ id: passkeys.id });
      if (!row) throw notFound('Passkey');
      await audit(db, {
        actorId: user.id,
        action: 'auth.passkey_removed',
        targetType: 'passkey',
        targetId: row.id,
        ip: req.clientIp,
      });
      return { ok: true as const };
    },
  );

  // ── sign-in (public) ────────────────────────────────────────────────────

  app.post(
    '/auth/passkeys/login/options',
    { config: strictLimit(30), schema: { response: { 200: PasskeyOptions } } },
    async () => {
      // No allowCredentials: the device offers whichever passkey it has for this site, so no
      // email is needed and nothing reveals which accounts exist.
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
      return {
        options: options as unknown as Record<string, unknown>,
        token: ctx.keys.sign('passkey-auth', { c: options.challenge }, CHALLENGE_TTL),
      };
    },
  );

  app.post(
    '/auth/passkeys/login',
    {
      config: strictLimit(10),
      schema: { body: PasskeyLoginBody, response: { 200: LoginResponse } },
    },
    async (req, reply) => {
      const claims = takeChallenge('passkey-auth', req.body.token);
      const response = req.body.response as unknown as AuthenticationResponseJSON;
      const credentialId = typeof response.id === 'string' ? response.id : '';
      const [row] = await db
        .select({ key: passkeys, user: users })
        .from(passkeys)
        .innerJoin(users, eq(users.id, passkeys.userId))
        .where(eq(passkeys.credentialId, credentialId));
      if (!row)
        throw invalid('This passkey isn’t registered here anymore. Sign in with your password.');
      let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: claims.c,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: row.key.credentialId,
            publicKey: new Uint8Array(Buffer.from(row.key.publicKey, 'base64url')),
            counter: row.key.counter,
            transports: row.key.transports ?? undefined,
          },
        });
      } catch {
        throw invalid();
      }
      if (!result.verified) throw invalid();
      if (row.user.disabledAt) throw invalid('This account is disabled. Ask a family admin.');
      if (!emailAllowed((await ctx.settings.get()).allowedEmailDomains, row.user.email)) {
        throw invalid('This account can’t sign in here. Ask a family admin.');
      }

      await db
        .update(passkeys)
        .set({
          counter: result.authenticationInfo.newCounter,
          backedUp: result.authenticationInfo.credentialBackedUp,
          lastUsedAt: new Date(),
        })
        .where(eq(passkeys.id, row.key.id));
      await db
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null })
        .where(eq(users.id, row.user.id));
      const s = await ctx.sessions.create(db, row.user.id, requestMeta(req));
      setSessionCookie(ctx, reply, s.token, s.absoluteExpiresAt);
      await audit(db, {
        actorId: row.user.id,
        action: 'auth.login',
        ip: req.clientIp,
        meta: { passkey: true },
      });
      return { status: 'ok' as const, user: toMe(row.user) };
    },
  );
};
