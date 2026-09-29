import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createTestEnv, setupAdmin, type TestEnv, uploadFile } from './helpers';

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

  it('pages large folder listings with a cursor', async () => {
    const big = (await owner.post('/folders', { parentId: root, name: 'Big' })).body.id;
    for (const name of ['b', 'a', 'd', 'c', 'e']) {
      await owner.post('/folders', { parentId: big, name });
    }
    const link = await owner.post(`/nodes/${big}/links`, { allowDownload: true });
    const token = tokenOf(link.body.url);
    const guest = new Client(env.app);
    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `&cursor=${cursor}` : '';
      const page = await guest.get(`/public/links/${token}/folder?limit=2${q}`);
      expect(page.status).toBe(200);
      names.push(...page.body.items.map((i: { name: string }) => i.name));
      cursor = page.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(names).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(pages).toBe(3);
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

    // Deleting ends every link into the deleted items for good, including links to files
    // inside a deleted folder; restoring doesn't bring them back.
    const live = await owner.post(`/nodes/${folder}/links`, {});
    const toFile = await owner.post(`/nodes/${inside}/links`, {});
    await owner.del(`/nodes/${folder}`);
    expect((await guest.get(`/public/links/${tokenOf(live.body.url)}`)).status).toBe(404);
    await owner.post(`/trash/${folder}/restore`);
    expect((await guest.get(`/public/links/${tokenOf(live.body.url)}`)).status).toBe(404);
    expect((await guest.get(`/public/links/${tokenOf(toFile.body.url)}`)).status).toBe(404);
    expect((await owner.get(`/nodes/${folder}/links`)).body.items).toEqual([]);
  });

  it('lists what the user shares, with live links and family members', async () => {
    const other = await addMember(env, owner, 'aunt@example.com');
    const note = (await uploadFile(owner, root, 'plan.txt', Buffer.from('plan'))).final!.body.node;
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const link = await owner.post(`/nodes/${note.id}/links`, { expiresAt });
    const dead = await owner.post(`/nodes/${note.id}/links`, {});
    await owner.del(`/links/${dead.body.id}`);
    await owner.post(`/nodes/${outside}/shares`, { userId: other.me.id, permission: 'view' });

    const res = await owner.get('/shared-by-me');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.items.map((i: { node: { name: string } }) => [i.node.name, i]),
    );
    expect(byName['plan.txt'].links).toEqual([
      expect.objectContaining({ id: link.body.id, expiresAt, url: link.body.url }),
    ]);
    expect(byName['taxes.txt'].people).toEqual([
      expect.objectContaining({ grantee: expect.objectContaining({ id: other.me.id }) }),
    ]);
    // Deleted items and other people's things are not listed.
    expect(byName.Trip).toBeUndefined();
    expect((await other.client.get('/shared-by-me')).body.items).toEqual([]);
  });

  it('the owner can list links again later with a working URL', async () => {
    await owner.post(`/nodes/${folder}/links`, {});
    const list = await owner.get(`/nodes/${folder}/links`);
    expect(list.body.items.length).toBeGreaterThan(0);
    const guest = new Client(env.app);
    expect((await guest.get(`/public/links/${tokenOf(list.body.items[0].url)}`)).status).toBe(200);
  });

  it('locks a link after too many wrong passwords, whatever IPs they come from', async () => {
    const link = await owner.post(`/nodes/${folder}/links`, { password: 'right one' });
    const token = tokenOf(link.body.url);
    const guest = new Client(env.app);
    for (let i = 0; i < 20; i++) {
      const res = await guest.req('POST', `/public/links/${token}/unlock`, {
        json: { password: `guess ${i}` },
        headers: { 'cf-connecting-ip': `198.51.100.${i + 1}` },
      });
      expect(res.status).toBe(401);
    }
    const locked = await guest.req('POST', `/public/links/${token}/unlock`, {
      json: { password: 'right one' },
      headers: { 'cf-connecting-ip': '203.0.113.99' },
    });
    expect(locked.status).toBe(429);
    // Other links are unaffected.
    const other = await owner.post(`/nodes/${folder}/links`, { password: 'another' });
    expect(
      (await guest.post(`/public/links/${tokenOf(other.body.url)}/unlock`, { password: 'another' }))
        .status,
    ).toBe(200);
  });

  it('garbage tokens are rejected without leaking anything', async () => {
    const guest = new Client(env.app);
    expect((await guest.get('/public/links/aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect((await guest.get('/public/links/short')).status).toBe(400);
  });
});
