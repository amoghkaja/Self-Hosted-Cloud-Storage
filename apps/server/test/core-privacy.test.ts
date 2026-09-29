import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { cleanupSessions } from '../src/jobs/maintenance';
import { Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;

beforeAll(async () => {
  env = await createTestEnv();
  admin = (await setupAdmin(env)).client;
});
afterAll(async () => {
  await env.close();
});

describe('privacy page facts', () => {
  it('shows the admin notice and the real retention periods to everyone', async () => {
    await admin.patch('/admin/settings', { trashRetentionDays: 14, versionRetentionDays: 7 });
    const saved = await admin.patch('/admin/branding', {
      privacyNotice: '  Run by the Smith family.\nQuestions: privacy@example.com  ',
    });
    expect(saved.body.privacyNotice).toBe(
      'Run by the Smith family.\nQuestions: privacy@example.com',
    );
    const pub = await new Client(env.app).get('/auth/setup-status');
    expect(pub.body).toMatchObject({
      privacyNotice: 'Run by the Smith family.\nQuestions: privacy@example.com',
      trashRetentionDays: 14,
      versionRetentionDays: 7,
    });
    expect((await admin.patch('/admin/branding', { privacyNotice: 'x'.repeat(2001) })).status).toBe(
      400,
    );
  });

  it('keeps the security log for a year, not forever', async () => {
    await env.ctx.db.insert(auditLog).values([
      { actorId: null, action: 'test.old', createdAt: new Date(Date.now() - 400 * 86_400_000) },
      { actorId: null, action: 'test.recent', createdAt: new Date(Date.now() - 300 * 86_400_000) },
    ]);
    await cleanupSessions(env.ctx);
    const left = (await env.ctx.db.execute(
      sql`SELECT action FROM audit_log WHERE action LIKE 'test.%'`,
    )) as unknown as { action: string }[];
    expect(left.map((r) => r.action)).toEqual(['test.recent']);
  });
});
