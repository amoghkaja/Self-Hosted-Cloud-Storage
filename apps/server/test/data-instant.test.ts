import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, nodes } from '../src/db/schema';
import { hashBlob } from '../src/jobs/maintenance';
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
let alice: Client;
let bob: Client;
let aliceRoot: string;
let bobRoot: string;
let bobId: string;

beforeAll(async () => {
  env = await createTestEnv();
  alice = (await setupAdmin(env)).client;
  aliceRoot = (await alice.get('/auth/me')).body.rootNodeId;
  const b = await addMember(env, alice, 'bob@example.com');
  bob = b.client;
  bobRoot = b.me.rootNodeId;
  bobId = b.me.id;
});
afterAll(async () => {
  await env.close();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Uploads normally and computes the checksum like the worker does. */
async function stored(c: Client, parent: string, name: string, data: Buffer) {
  const node = (await uploadFile(c, parent, name, data)).final!.body.node;
  const [row] = await env.ctx.db
    .select({ blobId: nodes.blobId })
    .from(nodes)
    .where(eq(nodes.id, node.id));
  await hashBlob(env.ctx, row!.blobId!);
  return node;
}

async function blobsWithHash(hash: string) {
  return env.ctx.db.$count(blobs, eq(blobs.sha256, hash));
}

describe('instant uploads', () => {
  it('reuses a file the uploader already has, without sending the bytes', async () => {
    const data = bytes(50_000, 11);
    await stored(alice, aliceRoot, 'video.mp4', data);
    const before = (await alice.get('/auth/me')).body.usedBytes;
    const res = await alice.post('/uploads/instant', {
      parentId: aliceRoot,
      name: 'video copy.mp4',
      size: data.length,
      sha256: sha(data),
    });
    expect(res.status).toBe(200);
    expect(res.body.node).toMatchObject({ name: 'video copy.mp4', size: data.length });
    // Charged like any upload; the saving is transfer time and disk space.
    expect((await alice.get('/auth/me')).body.usedBytes).toBe(before + data.length);
    const content = await alice.get(`/nodes/${res.body.node.id}/content`);
    expect(Buffer.from(content.raw.rawPayload).equals(data)).toBe(true);
  });

  it("never matches another person's private file (the hash can't be used to probe)", async () => {
    const secret = bytes(20_000, 22);
    await stored(alice, aliceRoot, 'private.pdf', secret);
    const res = await bob.post('/uploads/instant', {
      parentId: bobRoot,
      name: 'guess.pdf',
      size: secret.length,
      sha256: sha(secret),
    });
    expect(res.status).toBe(200);
    expect(res.body.node).toBeNull();
  });

  it('matches files shared with the uploader, and deleting one copy keeps the other', async () => {
    const shared = bytes(30_000, 33);
    const folder = (await alice.post('/folders', { parentId: aliceRoot, name: 'Shared' })).body;
    const original = await stored(alice, folder.id, 'photo.jpg', shared);
    await alice.post(`/nodes/${folder.id}/shares`, { userId: bobId, permission: 'view' });
    const copy = (
      await bob.post('/uploads/instant', {
        parentId: bobRoot,
        name: 'photo.jpg',
        size: shared.length,
        sha256: sha(shared),
      })
    ).body.node;
    expect(copy).not.toBeNull();

    // Alice deletes hers for good; Bob's copy still opens.
    await alice.del(`/nodes/${original.id}`);
    expect((await alice.del(`/trash/${original.id}`)).status).toBe(200);
    const content = await bob.get(`/nodes/${copy.id}/content`);
    expect(content.status).toBe(200);
    expect(Buffer.from(content.raw.rawPayload).equals(shared)).toBe(true);

    // When the last file goes, the bytes go too.
    await bob.del(`/nodes/${copy.id}`);
    expect((await bob.del(`/trash/${copy.id}`)).status).toBe(200);
    expect(await blobsWithHash(sha(shared))).toBe(0);
  });

  it('respects quotas and rejects bad hashes', async () => {
    const data = bytes(10_000, 44);
    await stored(alice, aliceRoot, 'x.bin', data);
    expect(
      (
        await alice.post('/uploads/instant', {
          parentId: aliceRoot,
          name: 'y.bin',
          size: data.length,
          sha256: 'NOT-A-HASH',
        })
      ).status,
    ).toBe(400);
  });
});
