import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
let adminEmail: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  admin = a.client;
  adminEmail = a.me.email;
});
afterAll(async () => {
  await env.close();
});

const domainOf = (email: string) => email.split('@')[1]!;
const basic = (email: string, pw: string) =>
  `Basic ${Buffer.from(`${email}:${pw}`).toString('base64')}`;

describe('allowed email domains', () => {
  it('limits invites and sign-in to the allowed domains, and signs out everyone else', async () => {
    const outsider = await addMember(env, admin, 'cousin@gmail.test');
    const devicePw = (
      await outsider.client.post('/auth/app-passwords', {
        name: 'iPad',
        password: outsider.client.password,
      })
    ).body.password as string;
    const dav = () =>
      env.app.inject({
        method: 'PROPFIND' as 'GET',
        url: '/dav/',
        headers: { authorization: basic('cousin@gmail.test', devicePw), depth: '0' },
      });
    expect((await dav()).statusCode).toBe(207);

    // Can't lock yourself out.
    const self = await admin.patch('/admin/settings', { allowedEmailDomains: ['elsewhere.test'] });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('EMAIL_DOMAIN');

    const saved = await admin.patch('/admin/settings', {
      allowedEmailDomains: [` @${domainOf(adminEmail).toUpperCase()} `.trim().replace('@', '')],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.allowedEmailDomains).toEqual([domainOf(adminEmail)]);

    // The outsider's existing session and device password stop working at once…
    expect((await outsider.client.get('/auth/me')).status).toBe(401);
    expect((await dav()).statusCode).toBe(401);
    // …and signing in fails exactly like a wrong password (no hint that the account exists).
    const guest = new Client(env.app);
    const login = await guest.post('/auth/login', {
      email: 'cousin@gmail.test',
      password: 'another long password',
    });
    expect(login.status).toBe(401);
    expect(login.body.code).toBe('INVALID_CREDENTIALS');

    // Invites are limited too, both when created and when accepted.
    const bad = await admin.post('/admin/invites', {
      email: 'friend@gmail.test',
      role: 'member',
      expiresInDays: 7,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('EMAIL_DOMAIN');
    const open = await admin.post('/admin/invites', { role: 'member', expiresInDays: 7 });
    const token = open.body.url.split('/invite/')[1];
    const accept = await new Client(env.app).post(`/invites/${token}/accept`, {
      email: 'friend@gmail.test',
      displayName: 'Friend',
      password: 'another long password',
    });
    expect(accept.status).toBe(400);
    expect(accept.body.code).toBe('EMAIL_DOMAIN');

    // The admin sees who is outside the rule.
    const overview = (await admin.get('/admin/overview')).body;
    expect(overview.warnings.join(' ')).toContain("can't sign in");

    // Lifting the rule lets them back in.
    await admin.patch('/admin/settings', { allowedEmailDomains: [] });
    const back = await new Client(env.app).post('/auth/login', {
      email: 'cousin@gmail.test',
      password: 'another long password',
    });
    expect(back.status).toBe(200);
  });

  it('matches whole domains only', async () => {
    const { emailAllowed } = await import('@familycloud/shared/all');
    expect(emailAllowed(['smithfamily.com'], 'Alex@SmithFamily.com')).toBe(true);
    expect(emailAllowed(['smithfamily.com'], 'x@mail.smithfamily.com')).toBe(false);
    expect(emailAllowed(['smithfamily.com'], 'x@smithfamily.com.evil.test')).toBe(false);
    expect(emailAllowed(['smithfamily.com'], 'smithfamily.com@evil.test')).toBe(false);
    expect(emailAllowed([], 'anyone@anywhere.test')).toBe(true);
  });
});
