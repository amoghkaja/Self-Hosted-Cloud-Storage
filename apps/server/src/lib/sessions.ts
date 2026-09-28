import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import type { Executor } from '../db/client';
import { sessions, type UserRow, users } from '../db/schema';
import { randomToken, sha256 } from './crypto';
import { DAY_MS } from './time';

const SLIDING_MS = 30 * DAY_MS;
const ABSOLUTE_MS = 90 * DAY_MS;
/** Persist last-seen/sliding-expiry at most this often (avoids a DB write per request). */
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 30_000;

export interface AuthContext {
  sessionId: string;
  user: UserRow;
}

interface Cached extends AuthContext {
  expiresAt: number;
  lastSeenAt: number;
}

export class SessionService {
  private readonly cache = new LRUCache<string, Cached>({ max: 10_000, ttl: CACHE_TTL_MS });
  /**
   * Bumped on every eviction. A lookup that read the database before a revoke/disable/role
   * change must not put that stale row back into the cache after the eviction ran.
   */
  private generation = 0;

  constructor(private readonly db: Executor) {}

  async create(
    exec: Executor,
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; expiresAt: Date; absoluteExpiresAt: Date }> {
    const token = randomToken(32);
    const now = Date.now();
    const expiresAt = new Date(now + SLIDING_MS);
    const absoluteExpiresAt = new Date(now + ABSOLUTE_MS);
    await exec.insert(sessions).values({
      userId,
      tokenHash: sha256(token),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      expiresAt,
      absoluteExpiresAt,
    });
    return { token, expiresAt, absoluteExpiresAt };
  }

  /** Resolves a cookie token to a live session + enabled user, or null. */
  async resolve(token: string): Promise<AuthContext | null> {
    if (token.length < 20 || token.length > 100) return null;
    const hash = sha256(token);
    const now = Date.now();
    const hit = this.cache.get(hash);
    if (hit && hit.expiresAt > now) {
      if (now - hit.lastSeenAt > TOUCH_EVERY_MS) await this.touch(hash, hit);
      return { sessionId: hit.sessionId, user: hit.user };
    }
    const generation = this.generation;
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hash),
          gt(sessions.expiresAt, new Date(now)),
          gt(sessions.absoluteExpiresAt, new Date(now)),
          sql`${users.disabledAt} IS NULL`,
        ),
      );
    if (!row) return null;
    const entry: Cached = {
      sessionId: row.session.id,
      user: row.user,
      expiresAt: row.session.expiresAt.getTime(),
      lastSeenAt: row.session.lastSeenAt.getTime(),
    };
    if (now - entry.lastSeenAt > TOUCH_EVERY_MS) await this.touch(hash, entry);
    if (generation === this.generation) this.cache.set(hash, entry);
    return { sessionId: entry.sessionId, user: entry.user };
  }

  private async touch(hash: string, entry: Cached): Promise<void> {
    const now = Date.now();
    const [row] = await this.db
      .update(sessions)
      .set({
        lastSeenAt: new Date(now),
        expiresAt: sql`least(${new Date(now + SLIDING_MS).toISOString()}::timestamptz, ${sessions.absoluteExpiresAt})`,
      })
      .where(eq(sessions.tokenHash, hash))
      .returning({ expiresAt: sessions.expiresAt });
    entry.lastSeenAt = now;
    if (row) entry.expiresAt = row.expiresAt.getTime();
  }

  async revoke(exec: Executor, sessionId: string, userId: string): Promise<boolean> {
    const rows = await exec
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    this.evict((c) => c.sessionId === sessionId);
    return rows.length > 0;
  }

  /** Signs a user out everywhere (optionally keeping the current session). */
  async revokeAll(exec: Executor, userId: string, exceptSessionId?: string): Promise<void> {
    await exec
      .delete(sessions)
      .where(
        exceptSessionId
          ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
          : eq(sessions.userId, userId),
      );
    this.evict((c) => c.user.id === userId && c.sessionId !== exceptSessionId);
  }

  /** Drops cached copies of a user so role/disable/quota changes apply immediately. */
  forgetUser(userId: string): void {
    this.evict((c) => c.user.id === userId);
  }

  private evict(match: (c: Cached) => boolean): void {
    this.generation++;
    for (const [key, value] of this.cache.entries()) {
      if (match(value)) this.cache.delete(key);
    }
  }
}
