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
let albumId: string;
let photo: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  dad = a.client;
  const m = await addMember(env, dad, 'mom@example.com');
  mom = m.client;
  momId = m.me.id;
  kid = (await addMember(env, dad, 'kid@example.com')).client;
  albumId = (
    await mom.post('/albums', { title: 'Goa', startDate: '2026-08-12', peopleIds: [momId] })
  ).body.id;
  const { folderId } = (await mom.post(`/albums/${albumId}/folder`, {})).body;
  photo = (await uploadFile(mom, folderId, 'beach.jpg', bytes(300, 1), { mimeType: 'image/jpeg' }))
    .final!.body.node.id;
});
afterAll(async () => {
  await env.close();
});

const url = (path = '') => `/albums/${albumId}/photos/${photo}${path}`;

describe('hearts and comments on photos', () => {
  it('lets anyone in the family heart and comment, and shows the counts in the album', async () => {
    expect((await kid.req('PUT', url('/heart'))).body).toMatchObject({ hearted: true });
    // Twice is still one heart.
    await kid.req('PUT', url('/heart'));
    const s = (await dad.req('PUT', url('/heart'))).body;
    expect(s.hearts.map((h: { displayName: string }) => h.displayName)).toHaveLength(2);
    expect(s.hearted).toBe(true);

    const c = await kid.post(url('/comments'), { body: '  Best day!  ' });
    expect(c.status).toBe(200);
    expect(c.body.comments).toEqual([
      expect.objectContaining({ body: 'Best day!', canDelete: true }),
    ]);
    expect((await kid.post(url('/comments'), { body: '   ' })).status).toBe(400);
    expect((await kid.post(url('/comments'), { body: 'x'.repeat(1001) })).status).toBe(400);

    const item = (await mom.get(`/albums/${albumId}/photos`)).body.items[0];
    expect(item).toMatchObject({ hearts: 2, hearted: false, comments: 1 });
    expect((await kid.get(`/albums/${albumId}/photos`)).body.items[0].hearted).toBe(true);

    expect((await kid.req('DELETE', url('/heart'))).body.hearted).toBe(false);
    expect((await mom.get(url('/social'))).body.hearts).toHaveLength(1);
  });

  it('lets the writer, the photo’s owner or an admin delete a comment, and nobody else', async () => {
    const mine = (await dad.post(url('/comments'), { body: 'Who took this?' })).body.comments.at(
      -1,
    );
    const kids = (await kid.get(url('/social'))).body.comments;
    expect(kids.at(-1)).toMatchObject({ id: mine.id, canDelete: false });
    expect((await kid.del(url(`/comments/${mine.id}`))).status).toBe(403);
    // The photo is mom's: she may tidy up its comments.
    const kidComment = kids[0].id;
    expect((await mom.del(url(`/comments/${kidComment}`))).status).toBe(200);
    expect((await dad.del(url(`/comments/${mine.id}`))).body.comments).toEqual([]);
    expect((await dad.del(url(`/comments/${mine.id}`))).status).toBe(404);
  });

  it('only works on photos of that album, and goes away with the photo', async () => {
    const other = (
      await kid.post('/albums', { title: 'Zoo', startDate: '2026-09-01', peopleIds: [] })
    ).body.id;
    expect((await kid.get(`/albums/${other}/photos/${photo}/social`)).status).toBe(404);
    expect((await kid.req('PUT', `/albums/${other}/photos/${photo}/heart`)).status).toBe(404);
    await kid.post(url('/comments'), { body: 'bye' });
    // In the trash, it's out of the album; back, and the comments are still there.
    await mom.del(`/nodes/${photo}`);
    expect((await kid.get(url('/social'))).status).toBe(404);
    const trash = (await mom.get('/trash')).body.items;
    await mom.post(`/trash/${trash[0].id}/restore`, {});
    expect((await kid.get(url('/social'))).body.comments).toHaveLength(1);
  });
});
