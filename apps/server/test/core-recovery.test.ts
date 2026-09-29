import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const PASSWORD = 'another long password';

async function withTwoFactor(email: string) {
  const m = await addMember(env, admin, email);
  const setup = await m.client.post('/auth/totp/setup');
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const enabled = await m.client.post('/auth/totp/enable', { code: totp.generate() });
  expect(enabled.status).toBe(200);
  return { ...m, totp, codes: enabled.body.recoveryCodes as string[] };
}

async function passwordStep(email: string) {
  const c = new Client(env.app);
  const res = await c.post('/auth/login', { email, password: PASSWORD });
  expect(res.body.status).toBe('mfa_required');
  return { c, mfaToken: res.body.mfaToken as string };
}

describe('recovery codes', () => {
  it('are handed out once when two-factor is turned on', async () => {
    const { client, codes } = await withTwoFactor('lost-phone@example.com');
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
    expect(new Set(codes).size).toBe(10);
    expect((await client.get('/auth/recovery-codes')).body).toEqual({ remaining: 10 });
  });

  it('sign in once each, typed any way, and count toward the lockout', async () => {
    const { client, codes } = await withTwoFactor('sign-in@example.com');
    const { c, mfaToken } = await passwordStep('sign-in@example.com');
    const typed = codes[0]!.toUpperCase().replace('-', ' ');
    const ok = await c.post('/auth/login/recovery', { mfaToken, code: typed });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ok');
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await client.get('/auth/recovery-codes')).body).toEqual({ remaining: 9 });

    // Used up.
    const again = await passwordStep('sign-in@example.com');
    const reuse = await again.c.post('/auth/login/recovery', {
      mfaToken: again.mfaToken,
      code: codes[0],
    });
    expect(reuse.status).toBe(401);

    // Wrong codes lock the account like wrong app codes do.
    const guess = await passwordStep('sign-in@example.com');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (
          await guess.c.post('/auth/login/recovery', {
            mfaToken: guess.mfaToken,
            code: `wrong-code${i}`,
          })
        ).status,
      );
    }
    expect(statuses).toContain(429);
  });

  it('need the password step first (a code alone gets nowhere)', async () => {
    const { codes } = await withTwoFactor('no-token@example.com');
    const c = new Client(env.app);
    const res = await c.post('/auth/login/recovery', { mfaToken: 'forged.token', code: codes[1] });
    expect(res.status).toBe(401);
  });

  it('turn two-factor off after losing the phone, and new codes replace old ones', async () => {
    const { client, codes } = await withTwoFactor('replace@example.com');
    const fresh = await client.post('/auth/recovery-codes', { password: PASSWORD });
    expect(fresh.status).toBe(200);
    expect(fresh.body.codes).toHaveLength(10);
    expect((await client.post('/auth/recovery-codes', { password: 'wrong password' })).status).toBe(
      400,
    );
    // An old code no longer works; a wrong password doesn't use up a new one.
    expect(
      (await client.post('/auth/totp/disable', { password: PASSWORD, recoveryCode: codes[0] }))
        .status,
    ).toBe(400);
    expect(
      (
        await client.post('/auth/totp/disable', {
          password: 'wrong password',
          recoveryCode: fresh.body.codes[0],
        })
      ).status,
    ).toBe(400);
    expect((await client.get('/auth/recovery-codes')).body).toEqual({ remaining: 10 });
    const off = await client.post('/auth/totp/disable', {
      password: PASSWORD,
      recoveryCode: fresh.body.codes[0],
    });
    expect(off.status).toBe(200);
    expect(off.body.totpEnabled).toBe(false);
    expect((await client.get('/auth/recovery-codes')).body).toEqual({ remaining: 0 });
  });

  it('are cleared when an admin resets two-factor', async () => {
    const { client, me } = await withTwoFactor('admin-reset@example.com');
    expect((await admin.post(`/admin/users/${me.id}/reset-totp`)).status).toBe(200);
    expect((await client.get('/auth/recovery-codes')).body).toEqual({ remaining: 0 });
  });
});
