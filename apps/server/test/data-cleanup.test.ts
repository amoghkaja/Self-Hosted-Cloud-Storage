import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let owner: Client;
let other: Client;
let root: string;
let otherRoot: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  owner = a.client;
  root = a.me.rootNodeId;
  const b = await addMember(env, owner, 'sis@example.com');
  other = b.client;
  otherRoot = b.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

async function upload(c: Client, parentId: string, name: string, data: Buffer) {
  const node = (await uploadFile(c, parentId, name, data, { onConflict: 'replace' })).final!.body
    .node;
  for (const j of env.jobs.take('hash'))
    await hashBlob(env.ctx, (j.data as { blobId: string }).blobId);
  return node as { id: string; size: number };
}

const used = async (c: Client) => (await c.get('/auth/storage')).body.usedBytes as number;

describe('free up space', () => {
  it('lists the biggest files, copies of the same file, old versions and the trash', async () => {
    const docs = (await owner.post('/folders', { parentId: root, name: 'Docs' })).body.id;
    const big = await upload(owner, docs, 'film.mov', bytes(9000, 1));
    const small = await upload(owner, root, 'note.txt', bytes(100, 2));
    // The same photo uploaded twice (separate uploads, matched by checksum) and copied once
    // (sharing the stored bytes).
    const a = await upload(owner, root, 'IMG_1.jpg', bytes(3000, 3));
    const b = await upload(owner, docs, 'IMG_1 (from phone).jpg', bytes(3000, 3));
    const c = (await owner.post(`/nodes/${a.id}/copy`, { parentId: docs })).body;
    // Saved over twice: two older versions.
    await upload(owner, root, 'budget.xlsx', bytes(500, 4));
    await upload(owner, root, 'budget.xlsx', bytes(600, 5));
    const budget = await upload(owner, root, 'budget.xlsx', bytes(700, 6));
    const gone = await upload(owner, root, 'old.zip', bytes(400, 7));
    expect((await owner.del(`/nodes/${gone.id}`)).status).toBe(200);
    // Someone else's files never show up, even shared ones.
    await upload(other, otherRoot, 'huge.bin', bytes(20_000, 8));

    const r = (await owner.get('/cleanup')).body;
    expect(r.largest.map((f: { id: string }) => f.id).slice(0, 2)).toEqual([big.id, a.id]);
    expect(r.largest.find((f: { id: string }) => f.id === big.id).folder).toBe('Docs');
    expect(r.largest.find((f: { id: string }) => f.id === small.id).folder).toBe('');
    expect(r.largest.some((f: { name: string }) => f.name === 'huge.bin')).toBe(false);
    expect(r.largest.some((f: { id: string }) => f.id === gone.id)).toBe(false);

    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]).toMatchObject({ size: 3000, count: 3 });
    expect(r.duplicates[0].files.map((f: { id: string }) => f.id).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    );

    expect(r.versions).toMatchObject({ count: 2, bytes: 1100 });
    expect(r.versions.files).toEqual([
      expect.objectContaining({
        count: 2,
        bytes: 1100,
        file: expect.objectContaining({ id: budget.id }),
      }),
    ]);
    expect(r.trash).toEqual({ count: 1, bytes: 400 });

    // Other people see only their own.
    const theirs = (await other.get('/cleanup')).body;
    expect(theirs.duplicates).toEqual([]);
    expect(theirs.largest.map((f: { name: string }) => f.name)).toEqual(['huge.bin']);
  });

  it('deletes every old version for good and gives the space back', async () => {
    const before = await used(owner);
    const freed = await owner.del('/cleanup/versions');
    expect(freed.status).toBe(200);
    expect(freed.body).toEqual({ count: 2, bytes: 1100 });
    expect(await used(owner)).toBe(before - 1100);
    expect((await owner.get('/cleanup')).body.versions).toMatchObject({ count: 0, bytes: 0 });
    // Nothing left to delete is fine.
    expect((await owner.del('/cleanup/versions')).body).toEqual({ count: 0, bytes: 0 });
  });

  it('leaves other people’s versions alone', async () => {
    await upload(other, otherRoot, 'cv.docx', bytes(300, 9));
    await upload(other, otherRoot, 'cv.docx', bytes(310, 10));
    await owner.del('/cleanup/versions');
    expect((await other.get('/cleanup')).body.versions).toMatchObject({ count: 1, bytes: 300 });
  });

  it('needs a sign-in', async () => {
    const { Client: C } = await import('./helpers');
    expect((await new C(env.app).get('/cleanup')).status).toBe(401);
  });
});
