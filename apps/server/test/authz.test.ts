import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  bytes,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

/**
 * Authorization matrix: another family member must not be able to see or change anything of
 * mine through any endpoint unless I share it, and then only at the granted level.
 */
let env: TestEnv;
let alice: Client;
let bob: Client;
let aliceRoot: string;
let bobRoot: string;
let bobId: string;
let privateFolder: string;
let privateFile: string;
let shared: string;
let sharedFile: string;

beforeAll(async () => {
  env = await createTestEnv();
  const admin = await setupAdmin(env);
  const a = await addMember(env, admin.client, 'alice@example.com', { quotaBytes: 1_000_000 });
  const b = await addMember(env, admin.client, 'bob@example.com', { quotaBytes: 1_000_000 });
  alice = a.client;
  bob = b.client;
  aliceRoot = a.me.rootNodeId;
  bobRoot = b.me.rootNodeId;
  bobId = b.me.id;
  const secret = await alice.post('/folders', { parentId: aliceRoot, name: 'Private' });
  privateFolder = secret.body.id;
  privateFile = (await uploadFile(alice, privateFolder, 'diary.txt', Buffer.from('secret'))).final!
    .body.node.id;
  shared = (await alice.post('/folders', { parentId: privateFolder, name: 'Family Photos' })).body
    .id;
  sharedFile = (
    await uploadFile(alice, shared, 'beach.jpg', bytes(100), { mimeType: 'image/jpeg' })
  ).final!.body.node.id;
});
afterAll(async () => {
  await env.close();
});

describe('without a share', () => {
  it('every endpoint answers 404 for someone else’s items', async () => {
    const attempts = await Promise.all([
      bob.get(`/nodes/${privateFile}`),
      bob.get(`/nodes/${privateFolder}/children`),
      bob.get(`/nodes/${privateFile}/content`),
      bob.get(`/nodes/${privateFile}/thumbnail`),
      bob.get(`/zip?ids=${privateFolder}`),
      bob.patch(`/nodes/${privateFile}`, { name: 'pwned.txt' }),
      bob.del(`/nodes/${privateFile}`),
      bob.post('/folders', { parentId: privateFolder, name: 'intrusion' }),
      bob.post('/uploads', { parentId: privateFolder, name: 'x', size: 1 }),
      bob.get(`/nodes/${privateFolder}/shares`),
      bob.get(`/nodes/${privateFolder}/links`),
      bob.post(`/nodes/${privateFolder}/links`, {}),
      bob.post(`/nodes/${privateFolder}/shares`, { userId: bobId, permission: 'edit' }),
      bob.post(`/trash/${privateFile}/restore`),
    ]);
    for (const res of attempts) expect(res.status, JSON.stringify(res.body)).toBe(404);
    const lookup = await bob.post('/nodes/lookup', { ids: [privateFile] });
    expect(lookup.body.items).toHaveLength(0);
  });

  it('cannot move own items into someone else’s folder', async () => {
    const mine = (await bob.post('/folders', { parentId: bobRoot, name: 'Mine' })).body.id;
    expect((await bob.patch(`/nodes/${mine}`, { parentId: privateFolder })).status).toBe(404);
  });

  it('search only returns my own files', async () => {
    const res = await bob.get('/search?q=diary');
    expect(res.body.items).toHaveLength(0);
  });
});

describe('with a view share', () => {
  let shareId: string;
  beforeAll(async () => {
    const res = await alice.post(`/nodes/${shared}/shares`, { userId: bobId, permission: 'view' });
    expect(res.status).toBe(200);
    shareId = res.body.id;
  });

  it('can browse and download, and breadcrumbs hide the owner’s private parents', async () => {
    const detail = await bob.get(`/nodes/${sharedFile}`);
    expect(detail.status).toBe(200);
    expect(detail.body.access).toBe('view');
    expect(detail.body.breadcrumbs.map((b: { name: string }) => b.name)).toEqual([
      'Family Photos',
      'beach.jpg',
    ]);
    expect((await bob.get(`/nodes/${shared}/children`)).body.items).toHaveLength(1);
    expect((await bob.get(`/nodes/${sharedFile}/content`)).status).toBe(200);
    const list = await bob.get('/shared-with-me');
    expect(list.body.items[0]).toMatchObject({
      permission: 'view',
      owner: { displayName: 'alice' },
    });
    // The parent above the share stays invisible.
    expect((await bob.get(`/nodes/${privateFolder}`)).status).toBe(404);
  });

  it('cannot modify anything', async () => {
    expect((await bob.patch(`/nodes/${sharedFile}`, { name: 'x.jpg' })).status).toBe(403);
    expect((await bob.del(`/nodes/${sharedFile}`)).status).toBe(403);
    expect((await bob.post('/folders', { parentId: shared, name: 'new' })).status).toBe(403);
    expect((await bob.post('/uploads', { parentId: shared, name: 'x', size: 1 })).status).toBe(403);
    expect((await bob.post(`/nodes/${shared}/links`, {})).status).toBe(403);
  });

  it('upgrading to edit allows uploads, charged to the folder owner', async () => {
    await alice.patch(`/shares/${shareId}`, { permission: 'edit' });
    const before = (await alice.get('/auth/me')).body.usedBytes;
    const bobBefore = (await bob.get('/auth/me')).body.usedBytes;
    const up = await uploadFile(bob, shared, 'from-bob.jpg', bytes(500));
    expect(up.final?.status).toBe(200);
    expect(up.final?.body.node.ownerId).toBe((await alice.get('/auth/me')).body.id);
    expect((await alice.get('/auth/me')).body.usedBytes).toBe(before + 500);
    expect((await bob.get('/auth/me')).body.usedBytes).toBe(bobBefore);

    // Edit on the contents, but not on the share root itself (it lives in Alice's folder).
    expect(
      (await bob.patch(`/nodes/${up.final!.body.node.id}`, { name: 'renamed.jpg' })).status,
    ).toBe(200);
    expect((await bob.patch(`/nodes/${shared}`, { name: 'Mine now' })).status).toBe(403);
    expect((await bob.del(`/nodes/${shared}`)).status).toBe(403);
    // Moving shared content out into Bob's own tree would shift quota: refused.
    const mv = await bob.patch(`/nodes/${up.final!.body.node.id}`, { parentId: bobRoot });
    expect(mv.status).toBe(400);
  });

  it('removing the share revokes access immediately', async () => {
    await alice.del(`/shares/${shareId}`);
    expect((await bob.get(`/nodes/${sharedFile}`)).status).toBe(404);
  });
});

describe('admin role', () => {
  it('members cannot reach admin endpoints', async () => {
    for (const url of ['/admin/overview', '/admin/users', '/admin/settings', '/admin/audit']) {
      expect((await bob.get(url)).status).toBe(403);
    }
  });
});
