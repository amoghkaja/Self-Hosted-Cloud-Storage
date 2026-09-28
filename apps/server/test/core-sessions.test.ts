import { describe, expect, it } from 'vitest';
import type { Executor } from '../src/db/client';
import { SessionService } from '../src/lib/sessions';

/** A stand-in for the database whose first session lookup resolves only when told to. */
function slowDb(laterRows: unknown[] = []) {
  let release!: (rows: unknown[]) => void;
  const firstLookup = new Promise<unknown[]>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => (++lookups === 1 ? firstLookup : Promise.resolve(laterRows)),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({ returning: () => Promise.resolve([{ id: 's1' }]) }),
    }),
  };
  return { db: db as unknown as Executor, release };
}

describe('session cache', () => {
  const now = Date.now();
  const row = {
    session: { id: 's1', expiresAt: new Date(now + 60_000), lastSeenAt: new Date(now) },
    user: { id: 'u1', role: 'member' },
  };
  const token = 'x'.repeat(43);

  it('does not cache a lookup that raced with signing the user out everywhere', async () => {
    const { db, release } = slowDb();
    const sessions = new SessionService(db);
    const inFlight = sessions.resolve(token); // reads the row before the revoke lands…
    await sessions.revokeAll(db, 'u1'); // …the session is deleted and evicted…
    release([row]); // …then the stale row arrives.
    expect(await inFlight).not.toBeNull(); // that request was already authorized
    // The next request must hit the database (session gone), not a resurrected cache entry.
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('does not cache a stale user read that raced with a role change or disable', async () => {
    const demoted = { ...row, user: { ...row.user, role: 'member' } };
    const { db, release } = slowDb([demoted]);
    const sessions = new SessionService(db);
    const inFlight = sessions.resolve(token); // reads the user while still an admin…
    sessions.forgetUser('u1'); // …the admin rights are removed…
    release([{ ...row, user: { ...row.user, role: 'admin' } }]); // …then the old row arrives.
    expect((await inFlight)?.user.role).toBe('admin');
    expect((await sessions.resolve(token))?.user.role).toBe('member');
  });
});
