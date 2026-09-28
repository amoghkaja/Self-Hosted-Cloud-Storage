import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context';
import { sessions, users } from '../src/db/schema';
import { Keyring } from '../src/lib/crypto';
import { checkTotp } from '../src/modules/auth/service';
import {
  addMember,
  Client,
  createTestEnv,
  SETUP_TOKEN,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('first-run setup', () => {
  it('reports that setup is needed, rejects a wrong token, then creates the admin', async () => {
    const c = new Client(env.app);
    expect((await c.get('/auth/setup-status')).body).toMatchObject({ needsSetup: true });
    const wrong = await c.post('/auth/setup', {
      setupToken: 'not-the-right-token-xx',
      email: 'x@example.com',
      displayName: 'X',
      password: 'correct horse battery',
    });
    expect(wrong.status).toBe(403);

    const { me, client } = await setupAdmin(env);
    expect(me.role).toBe('admin');
    expect(me.quotaBytes).toBeNull();
    expect((await client.get('/auth/me')).body.email).toBe('admin@example.com');

    const again = await c.post('/auth/setup', {
      setupToken: SETUP_TOKEN,
      email: 'y@example.com',
      displayName: 'Y',
      password: 'correct horse battery',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SETUP_COMPLETE');
  });
});

describe('login', () => {
  it('sets a hardened session cookie and logs out', async () => {
    const c = new Client(env.app);
    const res = await c.post('/auth/login', {
      email: 'ADMIN@example.com',
      password: 'correct horse battery',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await c.get('/auth/me')).status).toBe(200);
    await c.post('/auth/logout');
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('gives the same error for unknown emails and wrong passwords', async () => {
    const c = new Client(env.app);
    const a = await c.post('/auth/login', {
      email: 'nobody@example.com',
      password: 'whatever12345',
    });
    const b = await c.post('/auth/login', {
      email: 'admin@example.com',
      password: 'wrong password!!',
    });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.detail).toBe(b.body.detail);
  });

  it('locks an account after repeated failures', async () => {
    const { client: admin } = await loginAdmin();
    await addMember(env, admin, 'lockme@example.com');
    const c = new Client(env.app);
    for (let i = 0; i < 5; i++) {
      await c.post('/auth/login', { email: 'lockme@example.com', password: 'wrong password!!' });
    }
    const locked = await c.post('/auth/login', {
      email: 'lockme@example.com',
      password: 'another long password',
    });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests from other origins', async () => {
    const { client } = await loginAdmin();
    const res = await client.req('POST', '/folders', {
      json: { parentId: (await client.get('/auth/me')).body.rootNodeId, name: 'x' },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_REJECTED');
  });

  it('rejects form-encoded bodies', async () => {
    const c = new Client(env.app);
    const res = await c.req('POST', '/auth/login', {
      body: Buffer.from('email=a&password=b'),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(415);
  });
});

describe('invites', () => {
  it('are single use and bound to the invited email', async () => {
    const { client: admin } = await loginAdmin();
    const inv = await admin.post('/admin/invites', { email: 'kid@example.com', quotaBytes: 1024 });
    const token = String(inv.body.url).split('/invite/')[1]!;
    const guest = new Client(env.app);
    expect((await guest.get(`/invites/${token}`)).body).toMatchObject({ email: 'kid@example.com' });
    const wrongEmail = await guest.post(`/invites/${token}/accept`, {
      email: 'other@example.com',
      displayName: 'Other',
      password: 'another long password',
    });
    expect(wrongEmail.status).toBe(400);
    const ok = await guest.post(`/invites/${token}/accept`, {
      email: 'kid@example.com',
      displayName: 'Kid',
      password: 'another long password',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.quotaBytes).toBe(1024);
    const reuse = await new Client(env.app).post(`/invites/${token}/accept`, {
      email: 'kid@example.com',
      displayName: 'Kid',
      password: 'another long password',
    });
    expect(reuse.status).toBe(404);
  });
});

describe('two-factor', () => {
  it('requires a TOTP code after enabling and rejects replayed codes', async () => {
    const { client: admin } = await loginAdmin();
    const { client } = await addMember(env, admin, 'totp@example.com');
    const setup = await client.post('/auth/totp/setup');
    expect(setup.status).toBe(200);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
    const enable = await client.post('/auth/totp/enable', { code: totp.generate() });
    expect(enable.status).toBe(200);
    expect(enable.body.totpEnabled).toBe(true);

    const c = new Client(env.app);
    const step1 = await c.post('/auth/login', {
      email: 'totp@example.com',
      password: 'another long password',
    });
    expect(step1.body.status).toBe('mfa_required');
    expect(c.cookies.size).toBe(0);
    // The code used to enable is already consumed: replay must fail.
    const replay = await c.post('/auth/login/totp', {
      mfaToken: step1.body.mfaToken,
      code: totp.generate(),
    });
    expect(replay.status).toBe(401);
    const next = totp.generate({ timestamp: Date.now() + 30_000 });
    const ok = await c.post('/auth/login/totp', { mfaToken: step1.body.mfaToken, code: next });
    expect(ok.status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(200);
  });
});

describe('password change', () => {
  it('revokes other sessions', async () => {
    const { client: admin } = await loginAdmin();
    await addMember(env, admin, 'pw@example.com');
    const laptop = new Client(env.app);
    const phone = new Client(env.app);
    await laptop.post('/auth/login', {
      email: 'pw@example.com',
      password: 'another long password',
    });
    await phone.post('/auth/login', { email: 'pw@example.com', password: 'another long password' });
    const res = await laptop.post('/auth/password', {
      currentPassword: 'another long password',
      newPassword: 'a brand new password',
    });
    expect(res.status).toBe(200);
    expect((await laptop.get('/auth/me')).status).toBe(200);
    expect((await phone.get('/auth/me')).status).toBe(401);
  });
});

async function loginAdmin() {
  const client = new Client(env.app);
  const res = await client.post('/auth/login', {
    email: 'admin@example.com',
    password: 'correct horse battery',
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return { client };
}

describe('rate limiting', () => {
  it('throttles login attempts per IP', async () => {
    const strict = await createTestEnv({ RATE_LIMIT_SCALE: '1' });
    try {
      const c = new Client(strict.app);
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push(
          (await c.post('/auth/login', { email: `n${i}@example.com`, password: 'x' })).status,
        );
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await strict.close();
    }
  });
});

describe('web app manifest', () => {
  it('uses the configured family name', async () => {
    const named = await createTestEnv({ APP_NAME: 'Kaja Family Cloud' });
    try {
      const res = await named.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/manifest+json');
      expect(res.json()).toMatchObject({
        name: 'Kaja Family Cloud',
        short_name: 'Kaja Family',
        start_url: '/files',
      });
    } finally {
      await named.close();
    }
  });
});

describe('lockout under concurrency', () => {
  it('a burst of parallel wrong passwords still locks the account', async () => {
    const admin = new Client(env.app);
    await admin.post('/auth/login', {
      email: 'admin@example.com',
      password: 'correct horse battery',
    });
    await addMember(env, admin, 'burst@example.com');
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        new Client(env.app).post('/auth/login', {
          email: 'burst@example.com',
          password: 'wrong password!!',
        }),
      ),
    );
    // At most 5 attempts get as far as checking the password; the rest are refused as locked.
    expect(attempts.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    expect(attempts.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(7);
    const right = await new Client(env.app).post('/auth/login', {
      email: 'burst@example.com',
      password: 'another long password',
    });
    expect(right.status).toBe(429);
  });

  it('the same two-factor code used twice at once lets only one sign-in through', async () => {
    const admin = new Client(env.app);
    await admin.post('/auth/login', {
      email: 'admin@example.com',
      password: 'correct horse battery',
    });
    const { client } = await addMember(env, admin, 'race2fa@example.com');
    const setup = await client.post('/auth/totp/setup');
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
    await client.post('/auth/totp/enable', { code: totp.generate() });
    const code = totp.generate({ timestamp: Date.now() + 30_000 });
    const tokens = await Promise.all(
      [0, 1].map(async () => {
        const c = new Client(env.app);
        const r = await c.post('/auth/login', {
          email: 'race2fa@example.com',
          password: 'another long password',
        });
        return { c, token: r.body.mfaToken as string };
      }),
    );
    const results = await Promise.all(
      tokens.map(({ c, token }) => c.post('/auth/login/totp', { mfaToken: token, code })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });
});

describe('lockout and two-factor together', () => {
  async function totpMember(email: string) {
    const { client: admin } = await loginAdmin();
    const { client } = await addMember(env, admin, email);
    const setup = await client.post('/auth/totp/setup');
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
    await client.post('/auth/totp/enable', { code: totp.generate() });
    return { client, totp };
  }

  it('lets a two-factor user sign in after a few typos (the password step does not lock)', async () => {
    const { totp } = await totpMember('typos@example.com');
    const c = new Client(env.app);
    for (let i = 0; i < 4; i++) {
      const r = await c.post('/auth/login', {
        email: 'typos@example.com',
        password: 'typo typo typo',
      });
      expect(r.status).toBe(401);
    }
    const step1 = await c.post('/auth/login', {
      email: 'typos@example.com',
      password: 'another long password',
    });
    expect(step1.body.status).toBe('mfa_required');
    const ok = await c.post('/auth/login/totp', {
      mfaToken: step1.body.mfaToken,
      code: totp.generate({ timestamp: Date.now() + 30_000 }),
    });
    expect(ok.status).toBe(200);
  });

  it('still counts wrong codes when the password is known', async () => {
    await totpMember('guess2fa@example.com');
    const c = new Client(env.app);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const step1 = await c.post('/auth/login', {
        email: 'guess2fa@example.com',
        password: 'another long password',
      });
      if (step1.status !== 200) {
        statuses.push(step1.status);
        continue;
      }
      const r = await c.post('/auth/login/totp', { mfaToken: step1.body.mfaToken, code: '000000' });
      statuses.push(r.status);
    }
    // Five wrong codes lock the account; knowing the password doesn't reset the counter.
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('keeps working for an account with a very long failure history', async () => {
    const { client: admin } = await loginAdmin();
    const { me } = await addMember(env, admin, 'patient@example.com');
    // power(2, n) overflows float8 past n = 1023, which used to turn every sign-in into a 500.
    await env.ctx.db.update(users).set({ failedLogins: 5000 }).where(eq(users.id, me.id));
    const wrong = await new Client(env.app).post('/auth/login', {
      email: 'patient@example.com',
      password: 'wrong password!!',
    });
    expect(wrong.status).toBe(401);
    const [row] = await env.ctx.db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, me.id));
    expect(row!.lockedUntil!.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  it('does not replace the secret of an account that already has two-factor on', async () => {
    const { client: admin } = await loginAdmin();
    const { client, me } = await addMember(env, admin, 'stale2fa@example.com');
    expect((await client.get('/auth/me')).status).toBe(200); // session (totp off) now cached
    // Two-factor gets turned on elsewhere (another tab, another app replica).
    const secretEnc = env.ctx.keys.encrypt('totp', new OTPAuth.Secret({ size: 20 }).base32);
    await env.ctx.db
      .update(users)
      .set({ totpEnabled: true, totpSecretEnc: secretEnc })
      .where(eq(users.id, me.id));
    const setup = await client.post('/auth/totp/setup');
    expect(setup.status).toBe(409);
    const [row] = await env.ctx.db
      .select({ enc: users.totpSecretEnc })
      .from(users)
      .where(eq(users.id, me.id));
    expect(row!.enc).toBe(secretEnc);
  });

  it('records the time-step of the clock reading the code was checked against', () => {
    const keys = new Keyring('z'.repeat(40));
    const secret = new OTPAuth.Secret({ size: 20 });
    const ctx = { keys } as unknown as AppContext;
    const stepStart = Math.floor(Date.now() / 30_000) * 30_000;
    const code = new OTPAuth.TOTP({ secret }).generate({ timestamp: stepStart + 29_999 });
    // The clock crosses a 30 s boundary between two readings.
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(stepStart + 29_999)
      .mockReturnValue(stepStart + 30_001);
    try {
      const step = checkTotp(ctx, keys.encrypt('totp', secret.base32), code, null);
      expect(step).toBe(stepStart / 30_000);
    } finally {
      now.mockRestore();
    }
  });
});

describe('two-factor after the secret key changed', () => {
  it('explains the problem instead of failing with a bare server error', async () => {
    const { client: admin } = await loginAdmin();
    const { client, me } = await addMember(env, admin, 'rekeyed@example.com');
    const setup = await client.post('/auth/totp/setup');
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
    await client.post('/auth/totp/enable', { code: totp.generate() });
    // As if the database was restored next to a regenerated SECRET_KEY.
    const otherKey = new Keyring('another-secret-key-that-is-at-least-32-chars');
    await env.ctx.db
      .update(users)
      .set({ totpSecretEnc: otherKey.encrypt('totp', setup.body.secret) })
      .where(eq(users.id, me.id));
    const c = new Client(env.app);
    const step1 = await c.post('/auth/login', {
      email: 'rekeyed@example.com',
      password: 'another long password',
    });
    const res = await c.post('/auth/login/totp', {
      mfaToken: step1.body.mfaToken,
      code: totp.generate({ timestamp: Date.now() + 30_000 }),
    });
    expect(res.body.code).toBe('MFA_UNAVAILABLE');
    expect(res.body.detail).toMatch(/secret key changed/);
  });
});

describe('sliding session expiry', () => {
  it('extends a session that has been idle for over an hour', async () => {
    const { client } = await loginAdmin();
    const [admin] = await env.ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@example.com'));
    const idleSince = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await env.ctx.db
      .update(sessions)
      .set({ lastSeenAt: idleSince, expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(sessions.userId, admin!.id));
    expect((await client.get('/auth/me')).status).toBe(200);
    const rows = await env.ctx.db
      .select({ lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, admin!.id));
    const touched = rows.find((r) => r.lastSeenAt > idleSince);
    expect(touched).toBeDefined();
    expect(touched!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });
});

describe('caching', () => {
  it('marks API answers private and uncacheable unless the route chose a policy', async () => {
    const { client } = await loginAdmin();
    const me = await client.get('/auth/me');
    expect(me.headers['cache-control']).toBe('private, no-store');
    const anon = await new Client(env.app).get('/auth/me');
    expect(anon.status).toBe(401);
    expect(anon.headers['cache-control']).toBe('private, no-store');
    const missing = await client.get('/api/v1/no-such-route');
    expect(missing.headers['cache-control']).toBe('private, no-store');
    const root = me.body.rootNodeId as string;
    const { final } = await uploadFile(client, root, 'cache.txt', Buffer.from('hello'));
    const content = await client.get(`/nodes/${final!.body.node.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers['cache-control']).toBe('private, no-cache');
    const health = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.headers['cache-control']).toBeUndefined();
  });

  it('marks network-drive answers private and uncacheable', async () => {
    const res = await env.app.inject({ method: 'PROPFIND' as 'GET', url: '/dav/' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
