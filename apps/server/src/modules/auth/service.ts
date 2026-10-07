import { randomInt } from 'node:crypto';
import { ErrorCode, type UserRole } from '@familycloud/shared/all';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { nodes, recoveryCodes, type UserRow, users } from '../../db/schema';
import { audit } from '../../lib/audit';
import { sha256 } from '../../lib/crypto';
import { AppError, conflict, isUniqueViolation } from '../../lib/errors';
import { verifyPassword } from '../../lib/passwords';

/** Creates an account together with its root folder ("My Files"). */
export async function createUserWithRoot(
  exec: Executor,
  input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: UserRole;
    quotaBytes: number | null;
  },
): Promise<UserRow> {
  let user: UserRow | undefined;
  try {
    [user] = await exec.insert(users).values(input).returning();
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) {
      throw conflict('An account with this email already exists');
    }
    throw err;
  }
  const [root] = await exec
    .insert(nodes)
    .values({
      ownerId: user!.id,
      parentId: null,
      type: 'folder',
      name: 'My Files',
      createdBy: user!.id,
    })
    .returning();
  const [updated] = await exec
    .update(users)
    .set({ rootNodeId: root!.id })
    .where(eq(users.id, user!.id))
    .returning();
  return updated!;
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

const PERIOD = 30;

export function newTotp(ctx: AppContext, email: string) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: ctx.config.appName,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret,
  });
  return { secretBase32: secret.base32, url: totp.toString() };
}

/**
 * Validates a code against a stored (encrypted) secret, allowing ±1 step of clock drift and
 * rejecting any step at or before the last one used (so an observed code cannot be replayed).
 * Returns the accepted time-step, or null.
 */
export function checkTotp(
  ctx: AppContext,
  secretEnc: string,
  code: string,
  lastStep: number | null,
): number | null {
  let secret: string;
  try {
    secret = ctx.keys.decrypt('totp', secretEnc);
  } catch {
    // Encrypted under a different SECRET_KEY (restored database, regenerated .env): no code can
    // ever match, so say what's wrong instead of a bare 500.
    throw new AppError(
      500,
      ErrorCode.MFA_UNAVAILABLE,
      "Two-factor codes can't be checked because the server's secret key changed. Ask your admin to reset two-factor for your account.",
    );
  }
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  // One clock reading for both the check and the step: if a 30 s boundary passed between two
  // readings, the recorded step would be one ahead and the user's next valid code rejected.
  const now = Date.now();
  const delta = totp.validate({ token: code, window: 1, timestamp: now });
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / PERIOD) + delta;
  if (lastStep !== null && step <= lastStep) return null;
  return step;
}

// ── recovery codes ──────────────────────────────────────────────────────────

const RECOVERY_CODES = 10;
// No 0/o/1/l/i: easy to read off paper and type on a phone.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecoveryCode = (code: string) => sha256(`recovery:${normalizeRecoveryCode(code)}`);

/**
 * Replaces a person's recovery codes with ten new ones (10 characters each, about 49 bits,
 * shown as "abcde-fghjk") and returns them: this is the only time they're seen.
 */
export async function newRecoveryCodes(exec: Executor, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const chars = Array.from(
      { length: 10 },
      () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)],
    ).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
  await exec.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await exec
    .insert(recoveryCodes)
    .values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
  return codes;
}

/** Uses up a recovery code; true when it was valid and unused (one request wins a race). */
export async function useRecoveryCode(
  exec: Executor,
  userId: string,
  code: string,
): Promise<boolean> {
  const used = await exec
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, hashRecoveryCode(code)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });
  return used.length > 0;
}

export async function recoveryCodesLeft(exec: Executor, userId: string): Promise<number> {
  return exec.$count(
    recoveryCodes,
    and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)),
  );
}

export async function dropRecoveryCodes(exec: Executor, userId: string): Promise<void> {
  await exec.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}

/**
 * Asked before anything that hands out a new way into the account (a passkey, a two-factor
 * secret, recovery codes, a device password) or changes the password: with only a stolen
 * session, someone could otherwise add their own way in and keep it. A wrong password counts
 * toward the same lockout as signing in, so the session doesn't buy unlimited guesses.
 */
export async function confirmPassword(
  exec: Executor,
  userId: string,
  password: string,
  ip: string | null,
) {
  // One at a time per account: a burst of parallel guesses can't all be checked before the first
  // failures are counted (sign-in gets this by counting first), a right password never counts,
  // and no database connection waits on the (deliberately slow) hash.
  const attempts = await oneAtATime(userId, async () => {
    const [row] = await exec
      .select({
        hash: users.passwordHash,
        lockedUntil: users.lockedUntil,
        isLocked: sql<boolean>`coalesce(${users.lockedUntil} > now(), false)`,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (row?.isLocked) throw locked(row.lockedUntil);
    if (await verifyPassword(row?.hash ?? null, password)) return null;
    return claimAttempt(exec, userId);
  });
  if (attempts === null) return;
  await auditFailure(exec, userId, ip, 'password_confirm', attempts);
  throw new AppError(400, ErrorCode.INVALID_CREDENTIALS, 'Password is incorrect');
}

/** Password confirmations in flight, per account (the API runs as one process). */
const confirming = new Map<string, Promise<void>>();

/** Runs `fn` once every earlier call for the same key has settled. */
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (confirming.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  confirming.set(key, settled);
  void settled.then(() => {
    if (confirming.get(key) === settled) confirming.delete(key);
  });
  return run;
}

export async function auditFailure(
  exec: Executor,
  userId: string,
  ip: string | null,
  reason: string,
  attempts: number,
) {
  await audit(exec, {
    actorId: userId,
    action: 'auth.login_failed',
    ip,
    meta: { reason, attempts },
  });
}

const LOCK_AFTER = 5;

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
 * Lock length doubles from 1 minute per extra failure, capped at 60 minutes. (The exponent is
 * capped too: power(2, n) overflows float8 past n = 1023, which would turn every later sign-in
 * for the account into a 500 after a slow, weeks-long guessing campaign.)
 */
export async function claimAttempt(exec: Executor, userId: string): Promise<number> {
  const [row] = await exec
    .update(users)
    .set({
      failedLogins: sql`${users.failedLogins} + 1`,
      lockedUntil: sql`CASE WHEN ${users.failedLogins} + 1 >= ${LOCK_AFTER}
        THEN now() + make_interval(mins => least(power(2, least(${users.failedLogins} + 1 - ${LOCK_AFTER}, 6)), 60)::int)
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
  const [current] = await exec
    .select({ lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, userId));
  throw locked(current?.lockedUntil ?? null);
}

/**
 * Takes back an attempt claimed by `claimAttempt` that turned out not to be a failure, without
 * resetting the counter. Before the claim the account was unlocked, so clearing the lock the
 * claim may have set restores that. Skipped if another attempt has been counted since.
 */
export async function refundAttempt(
  exec: Executor,
  userId: string,
  attempts: number,
): Promise<void> {
  await exec
    .update(users)
    .set({ failedLogins: sql`${users.failedLogins} - 1`, lockedUntil: null })
    .where(and(eq(users.id, userId), eq(users.failedLogins, attempts)));
}
