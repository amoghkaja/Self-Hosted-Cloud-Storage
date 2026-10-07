import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, nodes } from '../src/db/schema';
import { reconcileUsage } from '../src/jobs/maintenance';
import {
  addMember,
  bytes,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let owner: Client;
let root: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  owner = a.client;
  root = a.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

const used = async (c: Client) => (await c.get('/auth/me')).body.usedBytes as number;
const row = async (id: string) =>
  (await env.ctx.db.select().from(nodes).where(eq(nodes.id, id)))[0]!;
const folder = async (c: Client, parentId: string, name: string) =>
  (await c.post('/folders', { parentId, name })).body.id as string;
const content = async (c: Client, id: string) =>
  Buffer.from((await c.get(`/nodes/${id}/content`)).raw.rawPayload);

describe('copy', () => {
  it('"Make a copy" in the same folder is instant, shares the bytes and counts once more', async () => {
    const data = bytes(1000, 1);
    const file = (await uploadFile(owner, root, 'recipe.pdf', data)).final!.body.node;
    const before = await used(owner);
    const copy = await owner.post(`/nodes/${file.id}/copy`, { parentId: root });
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ name: 'recipe (copy).pdf', size: 1000, parentId: root });
    expect((await row(copy.body.id)).blobId).toBe((await row(file.id)).blobId);
    expect(Buffer.compare(await content(owner, copy.body.id), data)).toBe(0);
    expect(await used(owner)).toBe(before + 1000);
    const again = await owner.post(`/nodes/${file.id}/copy`, { parentId: root });
    expect(again.body.name).toBe('recipe (copy 2).pdf');

    // Deleting the original for good leaves the copies' bytes alone.
    await owner.del(`/nodes/${file.id}`);
    await owner.del(`/trash/${file.id}`);
    expect(Buffer.compare(await content(owner, copy.body.id), data)).toBe(0);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('copies a whole folder tree somewhere else', async () => {
    const trip = await folder(owner, root, 'Trip');
    const day = await folder(owner, trip, 'Day 1');
    await uploadFile(owner, day, 'beach.jpg', bytes(300, 2));
    await uploadFile(owner, trip, 'plan.txt', bytes(50, 3));
    const archive = await folder(owner, root, 'Archive');
    const before = await used(owner);

    const res = await owner.post(`/nodes/${trip}/copy`, { parentId: archive });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Trip', type: 'folder', parentId: archive });
    const top = (await owner.get(`/nodes/${res.body.id}/children`)).body.items;
    expect(top.map((n: { name: string }) => n.name)).toEqual(['Day 1', 'plan.txt']);
    const inner = (await owner.get(`/nodes/${top[0].id}/children`)).body.items;
    expect(inner.map((n: { name: string }) => n.name)).toEqual(['beach.jpg']);
    expect(Buffer.compare(await content(owner, inner[0].id), bytes(300, 2))).toBe(0);
    expect(await used(owner)).toBe(before + 350);
    // Copying it again next to itself keeps both.
    const twice = await owner.post(`/nodes/${trip}/copy`, { parentId: archive });
    expect(twice.body.name).toBe('Trip (1)');
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it("won't copy a folder into itself", async () => {
    const a = await folder(owner, root, 'Loop');
    const b = await folder(owner, a, 'Inner');
    expect((await owner.post(`/nodes/${a}/copy`, { parentId: b })).status).toBe(400);
    expect((await owner.post(`/nodes/${a}/copy`, { parentId: a })).status).toBe(400);
  });

  it('lets someone copy what was shared with them into their own space, on their quota', async () => {
    const cousin = await addMember(env, owner, 'cousin@example.com');
    const shared = await folder(owner, root, 'Wedding');
    const photo = (await uploadFile(owner, shared, 'kiss.jpg', bytes(400, 4))).final!.body.node;
    await owner.post(`/nodes/${shared}/shares`, { userId: cousin.me.id, permission: 'view' });
    const ownerBefore = await used(owner);

    // Not into the owner's folder: they can only view it.
    expect((await cousin.client.post(`/nodes/${photo.id}/copy`, { parentId: shared })).status).toBe(
      403,
    );
    const copy = await cousin.client.post(`/nodes/${photo.id}/copy`, {
      parentId: cousin.me.rootNodeId,
    });
    expect(copy.status).toBe(200);
    expect(copy.body.ownerId).toBe(cousin.me.id);
    expect(await used(cousin.client)).toBe(400);
    expect(await used(owner)).toBe(ownerBefore);

    // Someone who can't see it can't copy it (and learns nothing).
    const stranger = await addMember(env, owner, 'stranger@example.com');
    expect(
      (await stranger.client.post(`/nodes/${photo.id}/copy`, { parentId: stranger.me.rootNodeId }))
        .status,
    ).toBe(404);
  });

  it('respects quotas', async () => {
    const small = await addMember(env, owner, 'small@example.com', { quotaBytes: 500 });
    const home = small.me.rootNodeId;
    const f = (await uploadFile(small.client, home, 'a.bin', bytes(300, 5))).final!.body.node;
    const res = await small.client.post(`/nodes/${f.id}/copy`, { parentId: home });
    expect(res.status).toBe(507);
    expect(await used(small.client)).toBe(300);
    expect((await small.client.get('/auth/me')).body.usedBytes).toBe(300);
  });

  it('WebDAV COPY is instant too (the copy shares the bytes)', async () => {
    const created = await owner.post('/auth/app-passwords', { name: 'Mac' });
    const auth = `Basic ${Buffer.from(`${created.body.username}:${created.body.password}`).toString('base64')}`;
    const put = await env.app.inject({
      method: 'PUT',
      url: '/dav/My%20Files/movie.mp4',
      headers: { authorization: auth },
      payload: bytes(2000, 6),
    });
    expect(put.statusCode).toBe(201);
    const res = await env.app.inject({
      method: 'COPY' as 'GET',
      url: '/dav/My%20Files/movie.mp4',
      headers: { authorization: auth, destination: '/dav/My%20Files/movie%20copy.mp4' },
    });
    expect(res.statusCode).toBe(201);
    const [a] = await env.ctx.db.select().from(nodes).where(eq(nodes.name, 'movie.mp4'));
    const [b] = await env.ctx.db.select().from(nodes).where(eq(nodes.name, 'movie copy.mp4'));
    expect(b!.blobId).toBe(a!.blobId);
    expect(await env.ctx.db.select().from(blobs).where(eq(blobs.id, a!.blobId!))).toHaveLength(1);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('takes along files still waiting for their virus check, not infected ones', async () => {
    const inbox = await folder(owner, root, 'From guests');
    const waiting = (await uploadFile(owner, inbox, 'guest.jpg', bytes(100, 7))).final!.body.node;
    const bad = (await uploadFile(owner, inbox, 'bad.jpg', bytes(100, 8))).final!.body.node;
    const scan = async (id: string, status: 'held' | 'infected') =>
      env.ctx.db
        .update(blobs)
        .set({ scanStatus: status })
        .where(eq(blobs.id, (await row(id)).blobId!));
    await scan(waiting.id, 'held');
    await scan(bad.id, 'infected');
    const names = async (id: string) =>
      (await owner.get(`/nodes/${id}/children`)).body.items.map((n: { name: string }) => n.name);

    const res = await owner.post(`/nodes/${inbox}/copy`, { parentId: root });
    expect(res.status).toBe(200);
    expect(await names(res.body.id)).toEqual(['guest.jpg']);

    const created = await owner.post('/auth/app-passwords', { name: 'Laptop' });
    const auth = `Basic ${Buffer.from(`${created.body.username}:${created.body.password}`).toString('base64')}`;
    const dav = await env.app.inject({
      method: 'COPY' as 'GET',
      url: '/dav/My%20Files/From%20guests',
      headers: { authorization: auth, destination: '/dav/My%20Files/Guests%20copy' },
    });
    expect(dav.statusCode).toBe(201);
    const [copy] = await env.ctx.db.select().from(nodes).where(eq(nodes.name, 'Guests copy'));
    expect(await names(copy!.id)).toEqual(['guest.jpg']);
  });
});
