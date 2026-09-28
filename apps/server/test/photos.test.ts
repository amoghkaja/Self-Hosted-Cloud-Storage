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
