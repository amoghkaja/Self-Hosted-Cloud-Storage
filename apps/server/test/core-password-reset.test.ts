import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, passwordResets } from '../src/db/schema';
import { addMember, Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;

beforeAll(async () => {
  env = await createTestEnv();
  admin = (await setupAdmin(env)).client;
});
afterAll(async () => {
  await env.close();
});

const tokenOf = (url: string) => url.split('/reset/')[1]!;

async function signIn(email: string, password: string) {
  const c = new Client(env.app);
  const res = await c.post('/auth/login', { email, password });
  return { c, res };
}

describe('password reset links', () => {
  it('lets a member choose a new password once, signing them out everywhere', async () => {
    const { client: old, me } = await addMember(env, admin, 'forgot@example.com');
    const link = await admin.post(`/admin/users/${me.id}/password-reset`);
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^http:\/\/localhost:5173\/reset\/[\w-]{32}$/);
    const token = tokenOf(link.body.url);

    const guest = new Client(env.app);
    const info = await guest.get(`/password-resets/${token}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ email: 'forgot@example.com', displayName: 'forgot' });

    const short = await guest.post(`/password-resets/${token}`, { password: 'short' });
    expect(short.status).toBe(400);
    const done = await guest.post(`/password-resets/${token}`, {
      password: 'a brand new password',
    });
    expect(done.status).toBe(200);
    // Using the link doesn't sign anyone in; the old session is gone.
    expect(guest.cookies.size).toBe(0);
    expect((await old.get('/auth/me')).status).toBe(401);

    expect((await signIn('forgot@example.com', 'another long password')).res.status).toBe(401);
    expect((await signIn('forgot@example.com', 'a brand new password')).res.body.status).toBe('ok');

    // Single use.
    const again = await guest.post(`/password-resets/${token}`, {
      password: 'yet another password',
    });
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('RESET_INVALID');
    expect((await guest.get(`/password-resets/${token}`)).status).toBe(404);

    const actions = (await env.ctx.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toContain('admin.password_reset_created');
    expect(actions).toContain('auth.password_reset');
  });

  it('only the newest link works, and expired links do not', async () => {
    const { me } = await addMember(env, admin, 'twice@example.com');
    const first = tokenOf((await admin.post(`/admin/users/${me.id}/password-reset`)).body.url);
    const second = tokenOf((await admin.post(`/admin/users/${me.id}/password-reset`)).body.url);
    const guest = new Client(env.app);
    expect((await guest.get(`/password-resets/${first}`)).status).toBe(404);
    expect((await guest.get(`/password-resets/${second}`)).status).toBe(200);

    await env.ctx.db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResets.userId, me.id));
    const late = await guest.post(`/password-resets/${second}`, { password: 'too late password' });
    expect(late.status).toBe(404);
  });

  it('never gets past two-factor sign-in', async () => {
    const { client, me } = await addMember(env, admin, 'twofactor@example.com');
    const setup = await client.post('/auth/totp/setup');
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
    expect((await client.post('/auth/totp/enable', { code: totp.generate() })).status).toBe(200);

    const token = tokenOf((await admin.post(`/admin/users/${me.id}/password-reset`)).body.url);
    const guest = new Client(env.app);
    expect(
      (await guest.post(`/password-resets/${token}`, { password: 'a fresh password' })).status,
    ).toBe(200);
    const { res } = await signIn('twofactor@example.com', 'a fresh password');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('mfa_required');
  });

  it('is for admins only, and not for their own or a disabled account', async () => {
    const { client: member, me } = await addMember(env, admin, 'plain@example.com');
    const adminMe = (await admin.get('/auth/me')).body;
    expect((await member.post(`/admin/users/${adminMe.id}/password-reset`)).status).toBe(403);
    expect((await admin.post(`/admin/users/${adminMe.id}/password-reset`)).status).toBe(400);

    await admin.patch(`/admin/users/${me.id}`, { disabled: true });
    expect((await admin.post(`/admin/users/${me.id}/password-reset`)).status).toBe(400);
    await admin.patch(`/admin/users/${me.id}`, { disabled: false });
    expect((await admin.post(`/admin/users/${me.id}/password-reset`)).status).toBe(200);
  });

  it('stops working if the account is disabled after the link was made', async () => {
    const { me } = await addMember(env, admin, 'later@example.com');
    const token = tokenOf((await admin.post(`/admin/users/${me.id}/password-reset`)).body.url);
    await admin.patch(`/admin/users/${me.id}`, { disabled: true });
    const guest = new Client(env.app);
    expect(
      (await guest.post(`/password-resets/${token}`, { password: 'sneaky new password' })).status,
    ).toBe(404);
  });
});
