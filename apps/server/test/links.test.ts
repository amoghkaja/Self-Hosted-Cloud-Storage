import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestEnv, setupAdmin, type TestEnv, uploadFile } from './helpers';

let env: TestEnv;
let owner: Client;
let root: string;
let folder: string;
let inside: string;
let outside: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  owner = a.client;
  root = a.me.rootNodeId;
  folder = (await owner.post('/folders', { parentId: root, name: 'Trip' })).body.id;
  const sub = (await owner.post('/folders', { parentId: folder, name: 'Day 1' })).body.id;
  inside = (await uploadFile(owner, sub, 'sunset.txt', Buffer.from('sunset'))).final!.body.node.id;
  outside = (await uploadFile(owner, root, 'taxes.txt', Buffer.from('private'))).final!.body.node
    .id;
});
afterAll(async () => {
  await env.close();
});

const tokenOf = (url: string) => url.split('/s/')[1]!;

describe('public share links', () => {
  it('password-protected link: locked until unlocked, then scoped to its subtree', async () => {
    const link = await owner.post(`/nodes/${folder}/links`, {
      password: 'letmein',
      allowDownload: true,
    });
    expect(link.status).toBe(200);
    expect(link.body.hasPassword).toBe(true);
    const token = tokenOf(link.body.url);
    const guest = new Client(env.app);

    const info = await guest.get(`/public/links/${token}`);
    expect(info.body).toMatchObject({ locked: true, node: null });
    expect((await guest.get(`/public/links/${token}/folder`)).status).toBe(401);
    expect((await guest.post(`/public/links/${token}/unlock`, { password: 'nope' })).status).toBe(
      401,
    );
    expect(
      (await guest.post(`/public/links/${token}/unlock`, { password: 'letmein' })).status,
    ).toBe(200);

    const opened = await guest.get(`/public/links/${token}`);
    expect(opened.body.locked).toBe(false);
    const listing = await guest.get(`/public/links/${token}/folder`);
    expect(listing.body.items.map((i: { name: string }) => i.name)).toEqual(['Day 1']);
    const file = await guest.get(`/public/links/${token}/content/${inside}`);
    expect(file.status).toBe(200);
    expect(file.raw.payload).toBe('sunset');
    // Anything outside the shared folder is invisible, even with a valid token.
    expect((await guest.get(`/public/links/${token}/content/${outside}`)).status).toBe(404);
    expect((await guest.get(`/public/links/${token}/folder?folderId=${root}`)).status).toBe(404);
  });

  it('view-only links can preview but not download', async () => {
    const link = await owner.post(`/nodes/${folder}/links`, { allowDownload: false });
    const token = tokenOf(link.body.url);
    const guest = new Client(env.app);
    expect((await guest.get(`/public/links/${token}/content/${inside}?inline=1`)).status).toBe(200);
    expect((await guest.get(`/public/links/${token}/content/${inside}`)).status).toBe(403);
    expect((await guest.get(`/public/links/${token}/zip/${folder}`)).status).toBe(403);
  });

  it('revoked, expired and trashed links stop working', async () => {
    const guest = new Client(env.app);
    const revoked = await owner.post(`/nodes/${folder}/links`, {});
    await owner.del(`/links/${revoked.body.id}`);
    expect((await guest.get(`/public/links/${tokenOf(revoked.body.url)}`)).status).toBe(404);

    const soon = await owner.post(`/nodes/${folder}/links`, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { sql } = await import('drizzle-orm');
    await env.ctx.db.execute(
      sql`update share_links set expires_at = now() - interval '1 minute' where id = ${soon.body.id}`,
    );
    const expired = await guest.get(`/public/links/${tokenOf(soon.body.url)}`);
    expect(expired.status).toBe(410);

    const live = await owner.post(`/nodes/${folder}/links`, {});
    await owner.del(`/nodes/${folder}`);
    expect((await guest.get(`/public/links/${tokenOf(live.body.url)}`)).status).toBe(404);
    await owner.post(`/trash/${folder}/restore`);
    expect((await guest.get(`/public/links/${tokenOf(live.body.url)}`)).status).toBe(200);
  });

  it('the owner can list links again later with a working URL', async () => {
    const list = await owner.get(`/nodes/${folder}/links`);
    expect(list.body.items.length).toBeGreaterThan(0);
    const guest = new Client(env.app);
    expect((await guest.get(`/public/links/${tokenOf(list.body.items[0].url)}`)).status).toBe(200);
  });

  it('garbage tokens are rejected without leaking anything', async () => {
    const guest = new Client(env.app);
    expect((await guest.get('/public/links/aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect((await guest.get('/public/links/short')).status).toBe(400);
  });
});
