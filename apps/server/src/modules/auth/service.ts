import { randomInt } from 'node:crypto';
import { ErrorCode, type UserRole } from '@familycloud/shared/all';
import { and, eq, isNull } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { nodes, recoveryCodes, type UserRow, users } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import { AppError, conflict, isUniqueViolation } from '../../lib/errors';

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
