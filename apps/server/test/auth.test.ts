import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createTestEnv, SETUP_TOKEN, setupAdmin, type TestEnv } from './helpers';

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
