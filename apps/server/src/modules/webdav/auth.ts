import { randomInt } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import type { Db } from '../../db/client';
import { appPasswords, type UserRow, users } from '../../db/schema';
import { rateLimitKey } from '../../lib/client-ip';
import { sha256 } from '../../lib/crypto';

// No 0/o/1/l/i so passwords are easy to read and type on a phone keyboard.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 20 characters from a 31-symbol alphabet ≈ 99 bits of entropy, shown as xxxxx-xxxxx-xxxxx-xxxxx. */
export function generateAppPassword(): string {
  const chars = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

/** Users may type the password with or without dashes, spaces or capitals. */
export function normalizeAppPassword(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashAppPassword(input: string): string {
  return sha256(`app-password:${normalizeAppPassword(input)}`);
}

interface CachedAuth {
  user: UserRow;
  appPasswordId: string;
}

const MAX_FAILURES_PER_MINUTE = 10;

/**
 * HTTP Basic auth for WebDAV clients: username = account email, password = an app password.
 * Account passwords are never accepted here, so a leaked device password can be revoked on
 * its own and never exposes the account (or bypasses two-factor for the web app).
 */
export class DavAuthenticator {
  private readonly cache = new LRUCache<string, CachedAuth>({ max: 1000, ttl: 60_000 });
  private readonly failures = new LRUCache<string, number>({ max: 10_000, ttl: 60_000 });

  constructor(private readonly db: Db) {}

  /** Failures count per rateLimitKey: an IPv6 client could otherwise rotate within its /64. */
  isThrottled(ip: string): boolean {
    return (this.failures.get(rateLimitKey(ip)) ?? 0) >= MAX_FAILURES_PER_MINUTE;
  }

  async authenticate(header: string | undefined, ip: string): Promise<UserRow | null> {
    if (!header?.startsWith('Basic ')) return null;
    const key = sha256(header);
    const hit = this.cache.get(key);
    if (hit) return hit.user;

    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return this.fail(ip);
    }
    const sep = decoded.indexOf(':');
    if (sep < 0) return this.fail(ip);
    const email = decoded.slice(0, sep).trim().toLowerCase();
    const password = decoded.slice(sep + 1);
    if (!email || password.length < 10 || password.length > 100) return this.fail(ip);

    const [row] = await this.db
      .select({ user: users, app: appPasswords })
      .from(appPasswords)
      .innerJoin(users, eq(users.id, appPasswords.userId))
      .where(
        and(
          eq(appPasswords.tokenHash, hashAppPassword(password)),
          eq(users.email, email),
          isNull(users.disabledAt),
        ),
      );
    if (!row) return this.fail(ip);

    const last = row.app.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > 5 * 60_000) {
      await this.db
        .update(appPasswords)
        .set({ lastUsedAt: new Date(), lastUsedIp: ip })
        .where(eq(appPasswords.id, row.app.id));
    }
    this.cache.set(key, { user: row.user, appPasswordId: row.app.id });
    return row.user;
  }

  /** Drop cached logins for a user (password revoked, account disabled). */
  forgetUser(userId: string): void {
    for (const [k, v] of this.cache.entries()) {
      if (v.user.id === userId) this.cache.delete(k);
    }
  }

  private fail(ip: string): null {
    const key = rateLimitKey(ip);
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    return null;
  }
}
