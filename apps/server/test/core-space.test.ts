import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bytes,
  Client as C,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let admin: Client;
let root: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  admin = a.client;
  root = a.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

describe('storage figures', () => {
  it('honour a disk capacity limit everywhere "free" is shown', async () => {
    const vol = (await admin.get('/admin/overview')).body.volumes[0];
    await admin.patch(`/admin/volumes/${vol.id}`, { capacityLimitBytes: 10_000, reserveBytes: 0 });
    await uploadFile(admin, root, 'a.bin', bytes(4_000, 1));

    const o = (await admin.get('/admin/overview')).body;
    const v = o.volumes[0];
    // The disk itself has far more free space; the limit is what counts for the family.
    expect(v.disk.freeBytes).toBeGreaterThan(10_000);
    expect(v.usable).toEqual({ totalBytes: 10_000, freeBytes: 6_000 });
    expect(o.totals.usableFreeBytes).toBe(6_000);
    expect(o.totals.familyCapacityBytes).toBe(10_000);

    const mine = (await admin.get('/auth/storage')).body;
    expect(mine).toEqual({
      usedBytes: 4_000,
      versionsBytes: 0,
      quotaBytes: null,
      availableBytes: 6_000,
    });
  });

  it('takes the tightest of quota, family limit and disks', async () => {
    const m = await addMember(env, admin, 'kid@example.com', { quotaBytes: 5_000 });
    expect((await m.client.get('/auth/storage')).body.availableBytes).toBe(5_000);
    await admin.patch('/admin/settings', { globalCapacityBytes: 7_000 });
    // Family limit 7 000, 4 000 already used by the admin.
    expect((await m.client.get('/auth/storage')).body.availableBytes).toBe(3_000);
    expect((await admin.get('/admin/overview')).body.totals.familyCapacityBytes).toBe(7_000);
    await admin.patch('/admin/settings', { globalCapacityBytes: null });
  });
});

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('branding', () => {
  it('shows the uploaded logo, wordmark and home link to everyone, and icons from the logo', async () => {
    const before = (await new C(env.app).get('/auth/setup-status')).body;
    expect(before).toMatchObject({ logoVersion: null, homeUrl: null, wordmark: before.appName });
    // The AGPL source offer is always there for signed-out visitors too.
    expect(before.sourceUrl).toBe('https://github.com/amoghkaja/Cloud-Storage');

    const up = await admin.post('/admin/branding/logo', {
      mimeType: 'image/svg+xml',
      data: b64(SVG),
    });
    expect(up.status).toBe(200);
    expect(up.body.hasLogo).toBe(true);
    await admin.patch('/admin/branding', { wordmark: 'Cloud', homeUrl: 'https://example.com' });

    const guest = new C(env.app);
    const s = (await guest.get('/auth/setup-status')).body;
    expect(s).toMatchObject({ wordmark: 'Cloud', homeUrl: 'https://example.com' });
    expect(s.logoVersion).toEqual(expect.any(String));
    const logo = await guest.get('/brand/logo');
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toBe('image/svg+xml');
    expect(logo.headers['content-security-policy']).toContain('sandbox');
    const icon = await guest.get('/brand/icon/180');
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.raw.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });

  it('refuses scripted SVGs, fake PNGs and non-admins', async () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>';
    expect(
      (await admin.post('/admin/branding/logo', { mimeType: 'image/svg+xml', data: b64(evil) }))
        .status,
    ).toBe(400);
    expect(
      (await admin.post('/admin/branding/logo', { mimeType: 'image/png', data: b64(SVG) })).status,
    ).toBe(400);
    const m = await addMember(env, admin, 'brand@example.com');
    expect((await m.client.patch('/admin/branding', { wordmark: 'x' })).status).toBe(403);
    expect((await admin.patch('/admin/branding', { homeUrl: 'javascript:alert(1)' })).status).toBe(
      400,
    );
  });
});

describe('privacy', () => {
  it('asks search engines to stay away, on every response', async () => {
    const guest = new C(env.app);
    const robots = await env.app.inject({ method: 'GET', url: '/robots.txt' });
    expect(robots.body).toContain('Disallow: /');
    expect(robots.headers['x-robots-tag']).toContain('noindex');
    expect((await guest.get('/auth/setup-status')).headers['x-robots-tag']).toContain('noindex');
  });
});
