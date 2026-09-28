import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSetupToken } from '../src/context';
import { settings } from '../src/db/schema';
import { SettingsStore } from '../src/lib/settings';
import { addMember, type Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('first-run setup token', () => {
  it('is the same for everyone who asks at once (app, replicas, cli setup-token)', async () => {
    // Without SETUP_TOKEN in the environment the token is generated and stored on first use.
    const ctx = { ...env.ctx, config: { ...env.ctx.config, setupToken: null } };
    // Open the whole pool first so the callers really run side by side.
    await Promise.all(
      Array.from({ length: 5 }, () => env.ctx.db.execute(sql`select pg_sleep(0.05)`)),
    );
    const tokens = await Promise.all(Array.from({ length: 5 }, () => ensureSetupToken(ctx)));
    expect(tokens[0]).toBeTruthy();
    expect(new Set(tokens).size).toBe(1);
    expect(await ensureSetupToken(ctx)).toBe(tokens[0]);
  });
});

describe('admin', () => {
  let admin: Client;
  beforeAll(async () => {
    admin = (await setupAdmin(env)).client;
  });

  it('never lets two admins demote each other at the same moment', async () => {
    const second = await addMember(env, admin, 'second-admin@example.com', { role: 'admin' });
    const me = (await admin.get('/auth/me')).body;
    const results = await Promise.all([
      admin.patch(`/admin/users/${second.me.id}`, { role: 'member' }),
      second.client.patch(`/admin/users/${me.id}`, { disabled: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const list = (await (results[0]!.status === 200 ? admin : second.client).get('/admin/users'))
      .body.items as { role: string; disabled: boolean }[];
    expect(list.filter((u) => u.role === 'admin' && !u.disabled).length).toBe(1);
    // Put things back for the other tests.
    if (results[0]!.status !== 200) {
      await second.client.patch(`/admin/users/${me.id}`, { disabled: false });
    }
  });

  it('keeps both of two settings changes made at the same moment', async () => {
    // Two app replicas (or two admins' requests) each holding a cached copy of the settings.
    const one = new SettingsStore(env.ctx.db);
    const two = new SettingsStore(env.ctx.db);
    await Promise.all([one.get(), two.get()]);
    await Promise.all([
      one.update({ trashRetentionDays: 11 }),
      two.update({ maxFileSizeBytes: 123_456 }),
    ]);
    const [stored] = await env.ctx.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'app'));
    expect(stored!.value).toMatchObject({ trashRetentionDays: 11, maxFileSizeBytes: 123_456 });
    const cleared = await admin.patch('/admin/settings', { maxFileSizeBytes: null });
    expect(cleared.body).toMatchObject({ trashRetentionDays: 11, maxFileSizeBytes: null });
    expect((await admin.get('/admin/settings')).body.maxFileSizeBytes).toBeNull();
  });

  it('answers a double-clicked "add volume" with a conflict, not a server error', async () => {
    const dir = path.join(env.ctx.config.volumesRoot, 'disk2');
    await mkdir(dir);
    // Open the whole pool first so both requests check the path before either inserts.
    await Promise.all(
      Array.from({ length: 5 }, () => env.ctx.db.execute(sql`select pg_sleep(0.05)`)),
    );
    const results = await Promise.all(
      [0, 1].map(() => admin.post('/admin/volumes', { name: 'disk2', path: dir })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('records revoked invites in the audit log', async () => {
    const inv = await admin.post('/admin/invites', { email: 'later@example.com' });
    const revoke = await admin.del(`/admin/invites/${inv.body.invite.id}`);
    expect(revoke.status).toBe(200);
    const token = String(inv.body.url).split('/invite/')[1]!;
    expect((await admin.get(`/invites/${token}`)).status).toBe(404);
    const audit = (await admin.get('/admin/audit')).body.items as {
      action: string;
      targetId: string;
    }[];
    expect(audit.find((e) => e.action === 'admin.invite_revoked')?.targetId).toBe(
      inv.body.invite.id,
    );
  });
});
