import { ErrorCode, type UserRole } from '@familycloud/shared/all';
import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import type { AppContext } from '../../context';
import type { Executor } from '../../db/client';
import { nodes, type UserRow, users } from '../../db/schema';
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
