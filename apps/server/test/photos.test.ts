import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodes } from '../src/db/schema';
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
let dad: Client;
let mom: Client;
let kid: Client;
let momId: string;
let kidId: string;
let dadId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  dad = a.client;
  dadId = a.me.id;
  const m = await addMember(env, dad, 'mom@example.com');
  const k = await addMember(env, dad, 'kid@example.com');
  mom = m.client;
  momId = m.me.id;
  kid = k.client;
  kidId = k.me.id;
});
afterAll(async () => {
  await env.close();
});

const photo = (n: number) => bytes(500, n);

async function addPhoto(c: Client, albumId: string, name: string, n = 1) {
  const { folderId } = (await c.post(`/albums/${albumId}/folder`, {})).body;
  return (await uploadFile(c, folderId, name, photo(n), { mimeType: 'image/jpeg' })).final!.body
    .node.id as string;
}

describe('trip albums', () => {
  it('lets everyone on the trip add photos from their own space, and the family see them', async () => {
    const created = await mom.post('/albums', {
      title: 'Goa',
      startDate: '2026-08-12',
      endDate: '2026-08-18',
      peopleIds: [momId, dadId],
    });
    expect(created.status).toBe(200);
    const album = created.body;
    expect(album).toMatchObject({ canContribute: true, canEdit: true, photoCount: 0 });
    expect(album.people.map((p: { id: string }) => p.id).sort()).toEqual([dadId, momId].sort());

    const a = await addPhoto(mom, album.id, 'IMG_1.jpg', 1);
    const b = await addPhoto(dad, album.id, 'IMG_1.jpg', 2);
    // Anything that isn't a photo or video stays out of the album.
    const { folderId } = (await dad.post(`/albums/${album.id}/folder`, {})).body;
    await uploadFile(dad, folderId, 'notes.txt', bytes(10, 3), { mimeType: 'text/plain' });

    // The kid wasn't on the trip but is family: they can view, not add.
    const seen = (await kid.get(`/albums/${album.id}`)).body;
    expect(seen).toMatchObject({ photoCount: 2, canContribute: false, canEdit: false });
    expect(seen.cover.nodeId).toBe(a);
    const photos = (await kid.get(`/albums/${album.id}/photos`)).body.items;
    expect(photos.map((p: { id: string }) => p.id)).toEqual([a, b]);
    expect(photos[1].addedBy.id).toBe(dadId);
    const content = await kid.get(`/albums/${album.id}/photos/${b}/content`);
    expect(content.status).toBe(200);
    expect((await kid.post(`/albums/${album.id}/folder`, {})).status).toBe(403);
    // …but still not through the file API, which is private to the owner.
    expect((await kid.get(`/nodes/${b}/content`)).status).toBe(404);

    // Their trip folder says it feeds a family album; ordinary folders don't.
    const tripFolder = (await dad.get(`/nodes/${folderId}`)).body;
    expect(tripFolder.album).toEqual({ id: album.id, title: 'Goa' });
    const home = (await dad.get(`/nodes/${tripFolder.breadcrumbs[0].id}`)).body;
    expect(home.album).toBeNull();

    // Each person's photos count against their own quota and live in their own Trips folder.
    const dadMe = (await dad.get('/auth/me')).body;
    expect(dadMe.usedBytes).toBeGreaterThanOrEqual(500);

    // Filter by person, newest trips first.
    const withMom = (await kid.get(`/albums?person=${momId}`)).body.items;
    expect(withMom.map((x: { id: string }) => x.id)).toContain(album.id);
    expect((await kid.get(`/albums?person=${kidId}`)).body.items).toHaveLength(0);

    // Download everything as one zip, with duplicate names kept apart.
    const zip = await kid.get(`/albums/${album.id}/zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
  });

  it('only the starter (or an admin) edits, and deleting an album keeps the photos', async () => {
    const album = (
      await mom.post('/albums', { title: 'Ooty', startDate: '2025-12-24', peopleIds: [momId] })
    ).body;
    const id = await addPhoto(mom, album.id, 'snow.jpg', 5);
    expect((await kid.patch(`/albums/${album.id}`, { title: 'Mine' })).status).toBe(403);
    const edited = await mom.patch(`/albums/${album.id}`, {
      title: 'Ooty winter',
      peopleIds: [momId, kidId],
      coverNodeId: id,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.title).toBe('Ooty winter');
    // Now on the trip, the kid can add photos.
    expect((await kid.post(`/albums/${album.id}/folder`, {})).status).toBe(200);
    expect(
      (await mom.patch(`/albums/${album.id}`, { startDate: '2026-01-01', endDate: '2025-12-31' }))
        .status,
    ).toBe(400);

    expect((await dad.del(`/albums/${album.id}`)).status).toBe(200); // admin
    expect((await mom.get(`/albums/${album.id}`)).status).toBe(404);
    expect((await mom.get(`/nodes/${id}`)).status).toBe(200);
  });

  it('drops photos that are trashed, and re-creates a deleted trip folder', async () => {
    const album = (
      await kid.post('/albums', { title: 'School trip', startDate: '2026-03-01', peopleIds: [] })
    ).body;
    const id = await addPhoto(kid, album.id, 'bus.jpg', 7);
    await kid.del(`/nodes/${id}`);
    expect((await kid.get(`/albums/${album.id}`)).body.photoCount).toBe(0);
    expect((await kid.get(`/albums/${album.id}/photos/${id}/content`)).status).toBe(404);

    const first = (await kid.post(`/albums/${album.id}/folder`, {})).body.folderId;
    await kid.del(`/nodes/${first}`);
    const second = (await kid.post(`/albums/${album.id}/folder`, {})).body.folderId;
    expect(second).not.toBe(first);
  });

  it("keeps what isn't a photo or video private, even from someone who knows its checksum", async () => {
    const album = (
      await dad.post('/albums', { title: 'Paris', startDate: '2026-05-01', peopleIds: [dadId] })
    ).body;
    const { folderId } = (await dad.post(`/albums/${album.id}/folder`, {})).body;
    const kidRoot = (await kid.get('/auth/me')).body.rootNodeId;
    /** Stores `data` in Dad's trip folder, then asks for an instant copy as the kid. */
    const probe = async (name: string, data: Buffer, mimeType: string) => {
      const node = (await uploadFile(dad, folderId, name, data, { mimeType })).final!.body.node;
      const [row] = await env.ctx.db
        .select({ blobId: nodes.blobId })
        .from(nodes)
        .where(eq(nodes.id, node.id));
      await hashBlob(env.ctx, row!.blobId!);
      const res = await kid.post('/uploads/instant', {
        parentId: kidRoot,
        name: `copy of ${name}`,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
      expect(res.status).toBe(200);
      return res.body.node;
    };

    // A boarding pass kept with the trip's photos isn't in the album, so the kid can't get it.
    expect(await probe('boarding pass.pdf', bytes(2000, 41), 'application/pdf')).toBeNull();
    // A photo in the album is the family's to see, so a copy of it is fine.
    expect(await probe('eiffel.jpg', bytes(3000, 42), 'image/jpeg')).toMatchObject({
      name: 'copy of eiffel.jpg',
    });
  });

  it('can still edit a trip after someone on it has had their account disabled', async () => {
    const aunt = await addMember(env, dad, 'aunt@example.com');
    const album = (
      await mom.post('/albums', {
        title: 'Kerala',
        startDate: '2026-02-01',
        peopleIds: [momId, aunt.me.id],
      })
    ).body;
    expect((await dad.patch(`/admin/users/${aunt.me.id}`, { disabled: true })).status).toBe(200);
    // The edit form sends everyone already on the trip back, the aunt too.
    const edited = await mom.patch(`/albums/${album.id}`, {
      title: 'Kerala backwaters',
      peopleIds: [momId, aunt.me.id],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.title).toBe('Kerala backwaters');
    expect(edited.body.people.map((p: { id: string }) => p.id).sort()).toEqual(
      [momId, aunt.me.id].sort(),
    );
    // …but nobody disabled can be added to a trip they weren't on.
    const other = (
      await mom.post('/albums', { title: 'Munnar', startDate: '2026-02-05', peopleIds: [momId] })
    ).body;
    const added = await mom.patch(`/albums/${other.id}`, { peopleIds: [momId, aunt.me.id] });
    expect(added.status).toBe(400);
    expect(added.body.detail).toBe('Someone in the list is not in the family');
  });

  it('pages through an album with the cursors it hands out', async () => {
    const album = (
      await mom.post('/albums', { title: 'Pages', startDate: '2026-04-02', peopleIds: [momId] })
    ).body;
    const ids = new Set<string>();
    for (const n of [61, 62, 63]) ids.add(await addPhoto(mom, album.id, `p${n}.jpg`, n));
    const pageAfter = (cursor: string | null) =>
      kid.get<{ items: { id: string }[]; nextCursor: string | null }>(
        `/albums/${album.id}/photos?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await pageAfter(cursor);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((p) => p.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(ids);
  });

  it('refuses a page cursor it never handed out (400, not a server error)', async () => {
    const album = (
      await mom.post('/albums', { title: 'Cursors', startDate: '2026-04-01', peopleIds: [momId] })
    ).body;
    const cursor = (c: unknown) => Buffer.from(JSON.stringify(c)).toString('base64url');
    const someId = '00000000-0000-4000-8000-000000000000';
    for (const c of [
      ['2020-02-30T00:00:00.000000', someId],
      ['2020', someId],
      ['0000-01-01T00:00:00.000000', someId],
      ['2026-01-01T00:00:00.000000', '-'.repeat(36)],
    ]) {
      const res = await kid.get(`/albums/${album.id}/photos?cursor=${cursor(c)}`);
      expect(res.status, JSON.stringify(c)).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', detail: 'Invalid cursor' });
    }
  });

  it('refuses unknown people and bad dates', async () => {
    const bad = await mom.post('/albums', {
      title: 'X',
      startDate: '2026-01-01',
      peopleIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await mom.post('/albums', {
          title: 'X',
          startDate: '2026-01-02',
          endDate: '2026-01-01',
          peopleIds: [],
        })
      ).status,
    ).toBe(400);
  });
});
