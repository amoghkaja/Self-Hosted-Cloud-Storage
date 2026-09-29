import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, blobs, nodes, users } from '../src/db/schema';
import { reconcileUsage } from '../src/jobs/maintenance';
import {
  addMember,
  bytes,
  Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let admin: Client;
let adminId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  admin = a.client;
  adminId = a.me.id;
});
afterAll(async () => {
  await env.close();
});

const blobOf = async (nodeId: string) =>
  (await env.ctx.db.select({ b: nodes.blobId }).from(nodes).where(eq(nodes.id, nodeId)))[0]!.b!;
const onDisk = async (blobId: string) => {
  const [b] = await env.ctx.db.select().from(blobs).where(eq(blobs.id, blobId));
  if (!b) return false;
  return !!(await stat(await env.ctx.volumes.blobFile(b)).catch(() => null));
};

describe('deleting an account', () => {
  it('needs the account disabled first, the email typed, and never your own', async () => {
    const m = await addMember(env, admin, 'careful@example.com');
    expect(
      (await admin.post(`/admin/users/${m.me.id}/delete`, { confirmEmail: 'careful@example.com' }))
        .status,
    ).toBe(400);
    await admin.patch(`/admin/users/${m.me.id}`, { disabled: true });
    expect(
      (await admin.post(`/admin/users/${m.me.id}/delete`, { confirmEmail: 'someone@else.com' }))
        .status,
    ).toBe(400);
    expect(
      (await admin.post(`/admin/users/${adminId}/delete`, { confirmEmail: 'admin@example.com' }))
        .status,
    ).toBe(400);
    expect(
      (
        await m.client.post(`/admin/users/${m.me.id}/delete`, {
          confirmEmail: 'careful@example.com',
        })
      ).status,
    ).toBe(401);
  });

  it('removes their files, versions, shares, links and album photos, and nobody else’s', async () => {
    const leaving = await addMember(env, admin, 'leaving@example.com');
    const home = leaving.me.rootNodeId;
    const secret = (await uploadFile(leaving.client, home, 'diary.txt', bytes(500, 1))).final!.body
      .node;
    await uploadFile(leaving.client, home, 'diary.txt', bytes(600, 2), { onConflict: 'replace' });
    const shared = (await uploadFile(leaving.client, home, 'recipe.pdf', bytes(300, 3))).final!.body
      .node;
    // Someone else holds the very same bytes (instant upload): those must survive.
    const recipeBlob = await blobOf(shared.id);
    await env.ctx.db
      .update(blobs)
      .set({ sha256: createHash('sha256').update(bytes(300, 3)).digest('hex') })
      .where(eq(blobs.id, recipeBlob));
    await leaving.client.post(`/nodes/${shared.id}/shares`, {
      userId: adminId,
      permission: 'view',
    });
    const twin = await admin.post('/uploads/instant', {
      parentId: (await admin.get('/auth/me')).body.rootNodeId,
      name: 'my recipe.pdf',
      size: 300,
      sha256: createHash('sha256').update(bytes(300, 3)).digest('hex'),
    });
    expect(twin.body.node).not.toBeNull();
    const link = await leaving.client.post(`/nodes/${secret.id}/links`, {});
    const diaryBlob = await blobOf(secret.id);
    const album = await admin.post('/albums', {
      title: 'Picnic',
      startDate: '2026-05-01',
      peopleIds: [leaving.me.id],
    });
    const { folderId } = (await leaving.client.post(`/albums/${album.body.id}/folder`)).body;
    await uploadFile(leaving.client, folderId, 'picnic.jpg', bytes(100, 4));
    // A file they put in the admin's shared folder belongs to the admin: it stays.
    const box = (
      await admin.post('/folders', {
        parentId: (await admin.get('/auth/me')).body.rootNodeId,
        name: 'Box',
      })
    ).body.id;
    await admin.post(`/nodes/${box}/shares`, { userId: leaving.me.id, permission: 'edit' });
    const gift = (await uploadFile(leaving.client, box, 'gift.txt', Buffer.from('for you'))).final!
      .body.node;
    const adminUsedBefore = (await admin.get('/auth/me')).body.usedBytes;

    await admin.patch(`/admin/users/${leaving.me.id}`, { disabled: true });
    const del = await admin.post(`/admin/users/${leaving.me.id}/delete`, {
      confirmEmail: ' Leaving@Example.com ',
    });
    expect(del.status).toBe(200);

    expect(await env.ctx.db.select().from(users).where(eq(users.id, leaving.me.id))).toEqual([]);
    expect(await env.ctx.db.select().from(nodes).where(eq(nodes.ownerId, leaving.me.id))).toEqual(
      [],
    );
    expect(await onDisk(diaryBlob)).toBe(false);
    expect(await onDisk(recipeBlob)).toBe(true);
    const mine = await admin.get(`/nodes/${twin.body.node.id}/content`);
    expect(Buffer.compare(Buffer.from(mine.raw.rawPayload), bytes(300, 3))).toBe(0);
    expect((await admin.get(`/nodes/${gift.id}/content`)).status).toBe(200);
    expect((await admin.get('/auth/me')).body.usedBytes).toBe(adminUsedBefore);
    expect((await admin.get('/shared-with-me')).body.items).toEqual([]);
    const token = link.body.url.split('/s/')[1];
    expect((await new Client(env.app).get(`/public/links/${token}`)).status).toBe(404);
    expect((await admin.get(`/albums/${album.body.id}/photos`)).body.items).toEqual([]);
    const [entry] = await env.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'admin.user_deleted'));
    expect(entry?.meta).toMatchObject({ email: 'leaving@example.com' });
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });
});
