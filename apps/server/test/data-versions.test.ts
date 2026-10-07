import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, fileVersions, nodes } from '../src/db/schema';
import { reconcileUsage, recoverPendingWork } from '../src/jobs/maintenance';
import { purgeExpiredVersions } from '../src/modules/versions/service';
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
let ownerEmail: string;
let root: string;
let dav: (method: string, path: string, body?: Buffer) => Promise<{ status: number }>;
let davHeader: string;
const davAuth = async () => ({ header: davHeader });

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  owner = a.client;
  ownerEmail = a.me.email;
  root = a.me.rootNodeId;
  const created = await owner.post('/auth/app-passwords', {
    name: 'Laptop',
    password: owner.password,
  });
  const auth = `Basic ${Buffer.from(`${ownerEmail}:${created.body.password}`).toString('base64')}`;
  davHeader = auth;
  dav = async (method, path, body) => {
    const res = await env.app.inject({
      method: method as 'PUT',
      url: path,
      headers: { authorization: auth },
      payload: body,
    });
    return { status: res.statusCode };
  };
});
afterAll(async () => {
  await env.close();
});

const used = async (c: Client = owner) => (await c.get('/auth/me')).body.usedBytes as number;
const nodeByName = async (name: string) =>
  (await env.ctx.db.select().from(nodes).where(eq(nodes.name, name)))[0]!;
const blobExists = async (blobId: string) =>
  (await env.ctx.db.select().from(blobs).where(eq(blobs.id, blobId))).length > 0;
const blobFileExists = async (blobId: string, volumeId: string) =>
  !!(await stat(await env.ctx.volumes.blobFile({ id: blobId, volumeId })).catch(() => null));
const content = async (c: Client, url: string) => Buffer.from((await c.get(url)).raw.rawPayload);

describe('version history', () => {
  it('keeps what a network-drive save replaced, and restoring swaps it back (undoably)', async () => {
    const before = await used();
    const v1 = bytes(300, 1);
    const v2 = bytes(500, 2);
    expect((await dav('PUT', '/dav/My%20Files/budget.xlsx', v1)).status).toBe(201);
    expect((await dav('PUT', '/dav/My%20Files/budget.xlsx', v2)).status).toBe(204);
    const file = await nodeByName('budget.xlsx');
    expect(Buffer.compare(await content(owner, `/nodes/${file.id}/content`), v2)).toBe(0);
    // Both are stored and both count.
    expect(await used()).toBe(before + 800);
    expect((await owner.get('/auth/storage')).body.versionsBytes).toBe(300);

    const list = await owner.get(`/nodes/${file.id}/versions`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ retentionDays: 30, canDelete: true, current: { size: 500 } });
    expect(list.body.items).toHaveLength(1);
    const [old] = list.body.items;
    expect(old.size).toBe(300);
    expect(old.modifiedBy?.displayName).toBe('Admin');
    const dl = await owner.get(`/nodes/${file.id}/versions/${old.id}/content`);
    expect(dl.status).toBe(200);
    expect(Buffer.compare(Buffer.from(dl.raw.rawPayload), v1)).toBe(0);
    expect(dl.headers['content-disposition']).toMatch(
      /budget \(\d{4}-\d\d-\d\d \d\d\.\d\d\)\.xlsx/,
    );

    const restored = await owner.post(`/nodes/${file.id}/versions/${old.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.node).toMatchObject({ id: file.id, size: 300 });
    expect(Buffer.compare(await content(owner, `/nodes/${file.id}/content`), v1)).toBe(0);
    // What was current is now the version: nothing lost, nothing double-counted.
    const after = await owner.get(`/nodes/${file.id}/versions`);
    expect(after.body.items.map((v: { size: number }) => v.size)).toEqual([500]);
    expect(await used()).toBe(before + 800);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('"Replace" on upload saves over the file instead of adding "name (1)"', async () => {
    const first = (await uploadFile(owner, root, 'notes.txt', Buffer.from('first draft'))).final!
      .body.node;
    const replaced = (
      await uploadFile(owner, root, 'NOTES.txt', Buffer.from('second draft!'), {
        onConflict: 'replace',
      })
    ).final!.body.node;
    expect(replaced.id).toBe(first.id);
    expect(replaced.name).toBe('notes.txt');
    expect((await content(owner, `/nodes/${first.id}/content`)).toString()).toBe('second draft!');
    const versions = await owner.get(`/nodes/${first.id}/versions`);
    expect(versions.body.items.map((v: { size: number }) => v.size)).toEqual([11]);

    // The default still keeps both.
    const both = (await uploadFile(owner, root, 'notes.txt', Buffer.from('third'))).final!.body
      .node;
    expect(both.name).toBe('notes (1).txt');

    const check = await owner.post(`/nodes/${root}/name-check`, {
      names: ['Notes.txt', 'missing.txt', 'notes (1).txt'],
    });
    expect(check.body.files.sort()).toEqual(['notes (1).txt', 'notes.txt']);
    expect(check.body.versionRetentionDays).toBe(30);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('an instant re-upload of the very same file replaces nothing and counts nothing', async () => {
    const data = bytes(700, 9);
    const file = (await uploadFile(owner, root, 'same.bin', data)).final!.body.node;
    const blobId = (await nodeByName('same.bin')).blobId!;
    await env.ctx.db
      .update(blobs)
      .set({ sha256: createHash('sha256').update(data).digest('hex') })
      .where(eq(blobs.id, blobId));
    const before = await used();
    const again = await owner.post('/uploads/instant', {
      parentId: root,
      name: 'same.bin',
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      onConflict: 'replace',
    });
    expect(again.body.node.id).toBe(file.id);
    expect(await used()).toBe(before);
    expect((await owner.get(`/nodes/${file.id}/versions`)).body.items).toEqual([]);
  });

  it('editors can see and restore versions, viewers cannot, and only the owner can delete', async () => {
    const editor = await addMember(env, owner, 'editor@example.com');
    const viewer = await addMember(env, owner, 'viewer@example.com');
    const folder = (await owner.post('/folders', { parentId: root, name: 'Family budget' })).body
      .id;
    await owner.post(`/nodes/${folder}/shares`, { userId: editor.me.id, permission: 'edit' });
    await owner.post(`/nodes/${folder}/shares`, { userId: viewer.me.id, permission: 'view' });
    const file = (await uploadFile(owner, folder, 'plan.txt', Buffer.from('plan A'))).final!.body
      .node;
    await uploadFile(editor.client, folder, 'plan.txt', Buffer.from('plan B!'), {
      onConflict: 'replace',
    });

    expect((await viewer.client.get(`/nodes/${file.id}/versions`)).status).toBe(403);
    const list = await editor.client.get(`/nodes/${file.id}/versions`);
    expect(list.status).toBe(200);
    expect(list.body.canDelete).toBe(false);
    expect(list.body.current.modifiedBy.displayName).toBe('editor');
    const [v] = list.body.items;
    expect(v.modifiedBy.displayName).toBe('Admin');
    expect((await viewer.client.get(`/nodes/${file.id}/versions/${v.id}/content`)).status).toBe(
      403,
    );
    expect((await editor.client.del(`/nodes/${file.id}/versions/${v.id}`)).status).toBe(403);
    expect((await editor.client.del(`/nodes/${file.id}/versions`)).status).toBe(403);
    expect((await editor.client.post(`/nodes/${file.id}/versions/${v.id}/restore`)).status).toBe(
      200,
    );
    expect((await content(owner, `/nodes/${file.id}/content`)).toString()).toBe('plan A');

    // Someone with no access at all learns nothing.
    const stranger = await addMember(env, owner, 'stranger@example.com');
    expect((await stranger.client.get(`/nodes/${file.id}/versions`)).status).toBe(404);

    // The owner deletes all versions; their bytes and storage are freed.
    const before = await used();
    const versions = await env.ctx.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.nodeId, file.id));
    expect(versions).toHaveLength(1);
    expect((await owner.del(`/nodes/${file.id}/versions`)).status).toBe(200);
    expect(await used()).toBe(before - versions[0]!.size);
    expect(await blobExists(versions[0]!.blobId)).toBe(false);
  });

  it('a revoked editor cannot restore (checked again under lock)', async () => {
    const cousin = await addMember(env, owner, 'cousin-v@example.com');
    const folder = (await owner.post('/folders', { parentId: root, name: 'Recipes' })).body.id;
    const share = await owner.post(`/nodes/${folder}/shares`, {
      userId: cousin.me.id,
      permission: 'edit',
    });
    const file = (await uploadFile(owner, folder, 'dal.txt', Buffer.from('v1'))).final!.body.node;
    await uploadFile(owner, folder, 'dal.txt', Buffer.from('v2'), { onConflict: 'replace' });
    const [v] = (await cousin.client.get(`/nodes/${file.id}/versions`)).body.items;
    await owner.del(`/shares/${share.body.id}`);
    const res = await cousin.client.post(`/nodes/${file.id}/versions/${v.id}/restore`);
    expect(res.status).toBe(404);
    expect((await content(owner, `/nodes/${file.id}/content`)).toString()).toBe('v2');
  });

  it('deleting a file forever deletes its versions and their bytes', async () => {
    expect((await dav('PUT', '/dav/My%20Files/draft.doc', bytes(111, 3))).status).toBe(201);
    expect((await dav('PUT', '/dav/My%20Files/draft.doc', bytes(222, 4))).status).toBe(204);
    const file = await nodeByName('draft.doc');
    const [version] = await env.ctx.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.nodeId, file.id));
    const [blob] = await env.ctx.db.select().from(blobs).where(eq(blobs.id, version!.blobId));
    expect(await blobFileExists(blob!.id, blob!.volumeId)).toBe(true);
    const before = await used();
    await owner.del(`/nodes/${file.id}`);
    expect(await used()).toBe(before); // still counted while in the trash
    expect((await owner.del(`/trash/${file.id}`)).status).toBe(200);
    expect(await used()).toBe(before - 333);
    expect(await blobExists(blob!.id)).toBe(false);
    expect(await blobFileExists(blob!.id, blob!.volumeId)).toBe(false);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('keeps at most 50 versions of a file, dropping the oldest', async () => {
    for (let i = 0; i < 53; i++) {
      const res = await dav('PUT', '/dav/My%20Files/log.txt', Buffer.from(`entry ${i}`));
      expect([201, 204]).toContain(res.status);
    }
    const file = await nodeByName('log.txt');
    const list = await owner.get(`/nodes/${file.id}/versions`);
    expect(list.body.items).toHaveLength(50);
    // Newest first: the newest version is entry 51, the oldest kept is entry 2.
    const [newest] = list.body.items;
    const oldest = list.body.items.at(-1);
    const read = async (id: string) =>
      (await content(owner, `/nodes/${file.id}/versions/${id}/content`)).toString();
    expect(await read(newest.id)).toBe('entry 51');
    expect(await read(oldest.id)).toBe('entry 2');
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('expired versions are deleted by the nightly job', async () => {
    expect((await dav('PUT', '/dav/My%20Files/old.txt', Buffer.from('aaaa'))).status).toBe(201);
    expect((await dav('PUT', '/dav/My%20Files/old.txt', Buffer.from('bbbbbb'))).status).toBe(204);
    const file = await nodeByName('old.txt');
    await env.ctx.db.execute(
      sql`UPDATE file_versions SET created_at = now() - interval '31 days' WHERE node_id = ${file.id}`,
    );
    const before = await used();
    const result = await purgeExpiredVersions(env.ctx);
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(await used()).toBe(before - result.bytes);
    expect((await owner.get(`/nodes/${file.id}/versions`)).body.items).toEqual([]);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('with versions turned off, saving over a file replaces it outright', async () => {
    await owner.patch('/admin/settings', { versionRetentionDays: 0 });
    try {
      expect((await dav('PUT', '/dav/My%20Files/nover.txt', bytes(100, 5))).status).toBe(201);
      const firstBlob = (await nodeByName('nover.txt')).blobId!;
      const before = await used();
      expect((await dav('PUT', '/dav/My%20Files/nover.txt', bytes(150, 6))).status).toBe(204);
      const file = await nodeByName('nover.txt');
      expect((await owner.get(`/nodes/${file.id}/versions`)).body.items).toEqual([]);
      expect(await used()).toBe(before + 50);
      expect(await blobExists(firstBlob)).toBe(false);
    } finally {
      await owner.patch('/admin/settings', { versionRetentionDays: 30 });
    }
  });
});

describe('background work', () => {
  it('the hourly recovery re-queues work only for bytes a file shows, not old versions', async () => {
    expect((await dav('PUT', '/dav/My%20Files/photo.jpg', bytes(90, 31))).status).toBe(201);
    const oldBlob = (await nodeByName('photo.jpg')).blobId!;
    expect((await dav('PUT', '/dav/My%20Files/photo.jpg', bytes(95, 32))).status).toBe(204);
    const newBlob = (await nodeByName('photo.jpg')).blobId!;
    // Both still waiting for a thumbnail, as if their jobs were lost long ago.
    await env.ctx.db.execute(
      sql`UPDATE blobs SET thumb_status = 'pending', created_at = now() - interval '1 hour'
          WHERE id IN (${oldBlob}, ${newBlob})`,
    );
    env.jobs.take('thumbnail');
    await recoverPendingWork(env.ctx);
    const queued = env.jobs.take('thumbnail').map((j) => (j.data as { blobId: string }).blobId);
    expect(queued).toContain(newBlob);
    expect(queued).not.toContain(oldBlob);
  });
});

describe('editors saving through a temporary file', () => {
  it('keeps the original file (its links and shares), with the old contents as a version', async () => {
    const helper = await addMember(env, owner, 'helper@example.com');
    expect((await dav('PUT', '/dav/My%20Files/Report.docx', bytes(120, 21))).status).toBe(201);
    const original = await nodeByName('Report.docx');
    const link = await owner.post(`/nodes/${original.id}/links`, {});
    await owner.post(`/nodes/${original.id}/shares`, { userId: helper.me.id, permission: 'view' });
    const before = await used();

    // Word/LibreOffice: write "~$Report.tmp", then rename it over "Report.docx".
    expect((await dav('PUT', '/dav/My%20Files/~%24Report.tmp', bytes(150, 22))).status).toBe(201);
    const res = await env.app.inject({
      method: 'MOVE' as 'GET',
      url: '/dav/My%20Files/~%24Report.tmp',
      headers: {
        authorization: (await davAuth()).header,
        destination: '/dav/My%20Files/Report.docx',
        overwrite: 'T',
      },
    });
    expect(res.statusCode).toBe(204);

    const now = await nodeByName('Report.docx');
    expect(now.id).toBe(original.id);
    expect(Buffer.compare(await content(owner, `/nodes/${now.id}/content`), bytes(150, 22))).toBe(
      0,
    );
    expect(
      (await env.ctx.db.select().from(nodes).where(eq(nodes.name, '~$Report.tmp'))).length,
    ).toBe(0);
    // The link still works and shows the new contents; the share is still there.
    const token = link.body.url.split('/s/')[1];
    const guest = await env.app.inject({
      method: 'GET',
      url: `/api/v1/public/links/${token}/content/${now.id}`,
    });
    expect(Buffer.compare(guest.rawPayload, bytes(150, 22))).toBe(0);
    expect((await helper.client.get(`/nodes/${now.id}`)).status).toBe(200);
    // Nothing went to the trash; the old contents are a version instead.
    const trash = await owner.get('/trash');
    expect(trash.body.items.map((i: { name: string }) => i.name)).not.toContain('Report.docx');
    const versions = await owner.get(`/nodes/${now.id}/versions`);
    expect(versions.body.items.map((v: { size: number }) => v.size)).toEqual([120]);
    expect(await used()).toBe(before + 150);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });
});

describe('versions and quota', () => {
  it("frees the oldest versions when they're all that stands in the way of an upload", async () => {
    const tight = await addMember(env, owner, 'tight@example.com', { quotaBytes: 1000 });
    const home = tight.me.rootNodeId;
    const doc = (await uploadFile(tight.client, home, 'essay.txt', bytes(400, 7))).final!.body.node;
    await uploadFile(tight.client, home, 'essay.txt', bytes(400, 8), { onConflict: 'replace' });
    expect(await used(tight.client)).toBe(800);
    expect((await tight.client.get('/auth/storage')).body.versionsBytes).toBe(400);

    // 800 + 300 > 1000: the 400-byte old version makes way.
    const photo = await uploadFile(tight.client, home, 'photo.jpg', bytes(300, 9));
    expect(photo.final?.status).toBe(200);
    expect(await used(tight.client)).toBe(700);
    expect((await tight.client.get(`/nodes/${doc.id}/versions`)).body.items).toEqual([]);

    // Nothing left to free: a real "quota full".
    const big = await uploadFile(tight.client, home, 'big.bin', bytes(400, 10));
    expect(big.created.status).toBe(507);
    expect(await reconcileUsage(env.ctx)).toEqual([]);
  });

  it('never deletes bytes that another file still uses', async () => {
    const data = bytes(256, 11);
    const a = (await uploadFile(owner, root, 'shared-bytes.bin', data)).final!.body.node;
    const blobId = (await env.ctx.db.select().from(nodes).where(eq(nodes.id, a.id)))[0]!.blobId!;
    await env.ctx.db
      .update(blobs)
      .set({ sha256: createHash('sha256').update(data).digest('hex') })
      .where(eq(blobs.id, blobId));
    // A second file points at the same bytes (instant upload), then the first is saved over.
    const twin = await owner.post('/uploads/instant', {
      parentId: root,
      name: 'twin.bin',
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    expect(twin.body.node).not.toBeNull();
    await uploadFile(owner, root, 'shared-bytes.bin', bytes(10, 12), { onConflict: 'replace' });
    await owner.del(`/nodes/${a.id}/versions`);
    expect(await blobExists(blobId)).toBe(true);
    expect(Buffer.compare(await content(owner, `/nodes/${twin.body.node.id}/content`), data)).toBe(
      0,
    );
  });
});
