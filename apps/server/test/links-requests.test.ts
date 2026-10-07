import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, nodes, shareLinks, users } from '../src/db/schema';
import {
  addMember,
  bytes,
  CHUNK,
  Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let owner: Client;
let ownerId: string;
let root: string;
let inbox: string;
let secretFile: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  owner = a.client;
  ownerId = a.me.id;
  root = a.me.rootNodeId;
  inbox = (await owner.post('/folders', { parentId: root, name: 'Wedding photos' })).body.id;
  secretFile = (await uploadFile(owner, inbox, 'private-note.txt', Buffer.from('not for guests')))
    .final!.body.node.id;
});
afterAll(async () => {
  await env.close();
});

const tokenOf = (url: string) => url.split('/s/')[1]!;

async function newRequest(body: Record<string, unknown> = {}) {
  const res = await owner.post(`/nodes/${inbox}/links`, { kind: 'upload', ...body });
  expect(res.status).toBe(200);
  return { link: res.body, token: tokenOf(res.body.url) };
}

/** Sends `data` through a file request the way the web page does (chunked). */
async function send(guest: Client, token: string, name: string, data: Buffer, from?: string) {
  const created = await guest.post(`/public/links/${token}/uploads`, {
    name,
    size: data.length,
    ...(from ? { from } : {}),
  });
  if (created.status !== 200) return { created, last: null };
  let last = null;
  for (let i = 0; i < created.body.totalChunks; i++) {
    last = await guest.req('PUT', `/public/links/${token}/uploads/${created.body.id}/chunks/${i}`, {
      body: data.subarray(i * CHUNK, (i + 1) * CHUNK),
    });
  }
  return { created, last };
}

const childNames = async (folderId: string) =>
  (await owner.get(`/nodes/${folderId}/children`)).body.items.map((n: { name: string }) => n.name);

describe('file requests', () => {
  it('lets anyone send files into the folder without seeing anything in it', async () => {
    const { link, token } = await newRequest({ title: 'Your wedding photos' });
    expect(link).toMatchObject({
      kind: 'upload',
      title: 'Your wedding photos',
      allowDownload: false,
    });
    const guest = new Client(env.app);

    const info = await guest.get(`/public/links/${token}`);
    expect(info.body).toMatchObject({
      kind: 'upload',
      title: 'Your wedding photos',
      locked: false,
      sharedBy: 'Admin',
      node: null,
    });
    // Nothing of the folder is reachable with a request's token.
    for (const path of [
      `/public/links/${token}/folder`,
      `/public/links/${token}/content/${secretFile}`,
      `/public/links/${token}/content/${secretFile}?inline=1`,
      `/public/links/${token}/thumbnail/${secretFile}`,
      `/public/links/${token}/stream/${secretFile}`,
      `/public/links/${token}/preview/${secretFile}`,
      `/public/links/${token}/zip/${inbox}`,
    ]) {
      expect((await guest.get(path)).status, path).toBe(404);
    }

    const data = bytes(CHUNK * 2 + 10, 1);
    const { created, last } = await send(guest, token, 'IMG_0001.jpg', data, 'Priya');
    expect(created.status).toBe(200);
    expect(last!.status).toBe(200);
    expect(last!.body).toEqual({
      receivedCount: 3,
      totalChunks: 3,
      status: 'completed',
      done: true,
    });
    // The sender's reply never names the folder, its owner or the new file's id.
    const reply = JSON.stringify([created.body, last!.body]);
    expect(reply).not.toContain(inbox);
    expect(reply).not.toContain(ownerId);

    // It landed in a folder named after the sender, owned (and counted) by the owner.
    expect(await childNames(inbox)).toContain('Priya');
    const [priya] = await env.ctx.db.select().from(nodes).where(eq(nodes.name, 'Priya'));
    const [photo] = await env.ctx.db.select().from(nodes).where(eq(nodes.name, 'IMG_0001.jpg'));
    expect(photo).toMatchObject({ parentId: priya!.id, ownerId, size: data.length });
    const dl = await owner.get(`/nodes/${photo!.id}/content`);
    expect(Buffer.compare(Buffer.from(dl.raw.rawPayload), data)).toBe(0);

    // The same name again is kept alongside, never replaced.
    await send(guest, token, 'IMG_0001.jpg', bytes(5, 2), 'Priya');
    expect((await childNames(priya!.id)).sort()).toEqual(['IMG_0001 (1).jpg', 'IMG_0001.jpg']);

    const links = (await owner.get(`/nodes/${inbox}/links`)).body.items;
    expect(links.find((l: { id: string }) => l.id === link.id).uploadCount).toBe(2);
    const received = await env.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'link.upload_received'));
    expect(received).toHaveLength(2);
  });

  it('only for folders, and only by their owner', async () => {
    expect((await owner.post(`/nodes/${secretFile}/links`, { kind: 'upload' })).status).toBe(400);
    const cousin = await addMember(env, owner, 'cousin@example.com');
    await owner.post(`/nodes/${inbox}/shares`, { userId: cousin.me.id, permission: 'edit' });
    expect((await cousin.client.post(`/nodes/${inbox}/links`, { kind: 'upload' })).status).toBe(
      403,
    );
  });

  it('a password protects the request too', async () => {
    const { token } = await newRequest({ password: 'photos2026', title: 'Visa papers for Priya' });
    const guest = new Client(env.app);
    // Even the title waits for the password: it can say something private.
    expect((await guest.get(`/public/links/${token}`)).body).toMatchObject({
      locked: true,
      title: null,
    });
    expect((await send(guest, token, 'a.jpg', bytes(10, 3))).created.status).toBe(401);
    await guest.post(`/public/links/${token}/unlock`, { password: 'photos2026' });
    expect((await guest.get(`/public/links/${token}`)).body.title).toBe('Visa papers for Priya');
    expect((await send(guest, token, 'a.jpg', bytes(10, 3))).last!.body.done).toBe(true);
  });

  it('turning a request off stops uploads at once and frees the space they held', async () => {
    const { link, token } = await newRequest();
    const guest = new Client(env.app);
    const started = await guest.post(`/public/links/${token}/uploads`, {
      name: 'big.mov',
      size: CHUNK * 3,
    });
    expect(started.status).toBe(200);
    const reservedBefore = (await env.ctx.db.select().from(users).where(eq(users.id, ownerId)))[0]!
      .reservedBytes;
    expect(reservedBefore).toBeGreaterThanOrEqual(CHUNK * 3);

    await owner.del(`/links/${link.id}`);
    const reservedAfter = (await env.ctx.db.select().from(users).where(eq(users.id, ownerId)))[0]!
      .reservedBytes;
    expect(reservedAfter).toBe(reservedBefore - CHUNK * 3);
    const chunk = await guest.req(
      'PUT',
      `/public/links/${token}/uploads/${started.body.id}/chunks/0`,
      { body: bytes(CHUNK, 4) },
    );
    expect(chunk.status).toBe(404);
    expect(
      (await guest.post(`/public/links/${token}/uploads`, { name: 'x', size: 1 })).status,
    ).toBe(404);
  });

  it('expired requests take nothing more', async () => {
    const { link, token } = await newRequest({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await env.ctx.db.execute(
      sql`UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = ${link.id}`,
    );
    const guest = new Client(env.app);
    expect(
      (await guest.post(`/public/links/${token}/uploads`, { name: 'x', size: 1 })).status,
    ).toBe(410);
  });

  it("an upload can't be driven through another request's token", async () => {
    const one = await newRequest();
    const two = await newRequest();
    const guest = new Client(env.app);
    const started = await guest.post(`/public/links/${one.token}/uploads`, { name: 'x', size: 4 });
    const cross = await guest.req(
      'PUT',
      `/public/links/${two.token}/uploads/${started.body.id}/chunks/0`,
      { body: Buffer.from('abcd') },
    );
    expect(cross.status).toBe(404);
    expect((await guest.get(`/public/links/${two.token}/uploads/${started.body.id}`)).status).toBe(
      404,
    );
    // …nor through the signed-in upload API by someone else.
    const cousin = await addMember(env, owner, 'nosy@example.com');
    expect((await cousin.client.get(`/uploads/${started.body.id}`)).status).toBe(404);
  });

  it('caps uploads in flight per request, and charges the owner (quota applies)', async () => {
    const small = await addMember(env, owner, 'small@example.com', { quotaBytes: 100 });
    const box = (
      await small.client.post('/folders', { parentId: small.me.rootNodeId, name: 'Box' })
    ).body.id;
    const link = await small.client.post(`/nodes/${box}/links`, { kind: 'upload' });
    const token = tokenOf(link.body.url);
    const guest = new Client(env.app);
    expect(
      (await guest.post(`/public/links/${token}/uploads`, { name: 'a', size: 101 })).status,
    ).toBe(507);

    const { token: busy } = await newRequest();
    for (let i = 0; i < 20; i++) {
      const res = await guest.post(`/public/links/${busy}/uploads`, { name: `f${i}`, size: 1 });
      expect(res.status).toBe(200);
    }
    expect(
      (await guest.post(`/public/links/${busy}/uploads`, { name: 'one more', size: 1 })).status,
    ).toBe(429);
  });

  it("a refused upload leaves nothing behind (no empty folder in the sender's name)", async () => {
    const small = await newRequest({ maxUploadBytes: 10 });
    const guest = new Client(env.app);
    const refused = await guest.post(`/public/links/${small.token}/uploads`, {
      name: 'huge.mov',
      size: 11,
      from: 'Spammy McSpamface',
    });
    expect(refused.status).toBe(507);
    expect(await childNames(inbox)).not.toContain('Spammy McSpamface');
  });

  it('stop taking files at their size limit (5 GB unless the owner picks)', async () => {
    const { link } = await newRequest();
    expect(link.maxUploadBytes).toBe(5 * 1024 ** 3);
    const small = await newRequest({ maxUploadBytes: 100 });
    const guest = new Client(env.app);
    expect((await send(guest, small.token, 'a.bin', bytes(60, 1))).last!.body.done).toBe(true);
    // 60 received + 60 more would pass 100.
    expect(
      (await guest.post(`/public/links/${small.token}/uploads`, { name: 'b', size: 60 })).status,
    ).toBe(507);
    expect((await send(guest, small.token, 'c.bin', bytes(40, 2))).last!.body.done).toBe(true);
    const listed = (await owner.get(`/nodes/${inbox}/links`)).body.items.find(
      (l: { id: string }) => l.id === small.link.id,
    );
    expect(listed).toMatchObject({ uploadCount: 2, uploadBytes: 100, maxUploadBytes: 100 });
  });

  it("a disabled account's links stop working", async () => {
    const aunt = await addMember(env, owner, 'aunt@example.com');
    const box = (
      await aunt.client.post('/folders', { parentId: aunt.me.rootNodeId, name: 'Recipes' })
    ).body.id;
    const view = await aunt.client.post(`/nodes/${box}/links`, {});
    const request = await aunt.client.post(`/nodes/${box}/links`, { kind: 'upload' });
    const guest = new Client(env.app);
    expect((await guest.get(`/public/links/${tokenOf(view.body.url)}`)).status).toBe(200);
    await owner.patch(`/admin/users/${aunt.me.id}`, { disabled: true });
    expect((await guest.get(`/public/links/${tokenOf(view.body.url)}`)).status).toBe(404);
    expect((await guest.get(`/public/links/${tokenOf(request.body.url)}`)).status).toBe(404);
  });
});

describe('asking for photos for a trip album', () => {
  it("puts what's sent straight into the album, named after the sender", async () => {
    const album = await owner.post('/albums', {
      title: 'Goa 2026',
      startDate: '2026-03-01',
      peopleIds: [],
    });
    const { folderId } = (await owner.post(`/albums/${album.body.id}/folder`)).body;
    const link = await owner.post(`/nodes/${folderId}/links`, {
      kind: 'upload',
      title: 'Photos for Goa 2026',
    });
    const guest = new Client(env.app);
    const sent = await send(guest, tokenOf(link.body.url), 'beach.jpg', bytes(64, 9), 'Meera');
    expect(sent.last!.body.done).toBe(true);
    const photos = await owner.get(`/albums/${album.body.id}/photos`);
    expect(photos.body.items.map((p: { name: string }) => p.name)).toEqual(['Meera - beach.jpg']);
  });
});

describe('file requests and version history', () => {
  it("only the owner's own saves can clear their old versions, never a share or a file request", async () => {
    const mum = await addMember(env, owner, 'mum-versions@example.com', { quotaBytes: 1000 });
    const home = mum.me.rootNodeId;
    const shared = (await mum.client.post('/folders', { parentId: home, name: 'Shared' })).body.id;
    const doc = (await uploadFile(mum.client, shared, 'letter.txt', bytes(400, 13))).final!.body
      .node;
    await uploadFile(mum.client, shared, 'letter.txt', bytes(400, 14), { onConflict: 'replace' });
    expect((await mum.client.get('/auth/me')).body.usedBytes).toBe(800);
    const versions = async () =>
      (await mum.client.get(`/nodes/${doc.id}/versions`)).body.items.length;

    // A family member with edit access: refused, and Mum's history stays.
    const son = await addMember(env, owner, 'son-versions@example.com');
    await mum.client.post(`/nodes/${shared}/shares`, { userId: son.me.id, permission: 'edit' });
    expect((await uploadFile(son.client, shared, 'big.bin', bytes(300, 15))).created.status).toBe(
      507,
    );
    // A stranger through a file request: the same.
    const link = await mum.client.post(`/nodes/${shared}/links`, { kind: 'upload' });
    const guest = new Client(env.app);
    const token = link.body.url.split('/s/')[1];
    expect(
      (await guest.post(`/public/links/${token}/uploads`, { name: 'x.bin', size: 300 })).status,
    ).toBe(507);
    expect(await versions()).toBe(1);

    // Mum's own upload may use that room.
    expect((await uploadFile(mum.client, home, 'mine.bin', bytes(300, 16))).final?.status).toBe(
      200,
    );
    expect(await versions()).toBe(0);
  });
});

describe('download limits', () => {
  it('counts downloads (not previews) and stops the link when the limit is reached', async () => {
    const note = (await uploadFile(owner, root, 'invite.txt', Buffer.from('you are invited')))
      .final!.body.node;
    const res = await owner.post(`/nodes/${note.id}/links`, { maxDownloads: 2 });
    expect(res.body).toMatchObject({ maxDownloads: 2, downloadCount: 0 });
    const token = tokenOf(res.body.url);
    const guest = new Client(env.app);
    const base = `/public/links/${token}/content/${note.id}`;

    expect((await guest.get(`${base}?inline=1`)).status).toBe(200); // a preview
    expect((await guest.req('HEAD', base)).status).toBe(200);
    expect((await guest.get(base)).status).toBe(200);
    // Resuming the same download isn't another one.
    expect((await guest.get(base, { range: 'bytes=4-' })).status).toBe(206);
    expect((await guest.get(base)).status).toBe(200);
    const listed = (await owner.get(`/nodes/${note.id}/links`)).body.items[0];
    expect(listed.downloadCount).toBe(2);

    expect((await guest.get(base)).status).toBe(410);
    expect((await guest.get(`/public/links/${token}`)).status).toBe(410);
  });

  it('counts whatever sends the file from its start, whatever the Range header says', async () => {
    const ticket = (await uploadFile(owner, root, 'ticket.txt', Buffer.from('admit one'))).final!
      .body.node;
    const res = await owner.post(`/nodes/${ticket.id}/links`, { maxDownloads: 3 });
    const base = `/public/links/${tokenOf(res.body.url)}/content/${ticket.id}`;
    const guest = new Client(env.app);
    const counted = async () =>
      (await owner.get(`/nodes/${ticket.id}/links`)).body.items[0].downloadCount;

    // "The last 1,000 bytes" of a 9-byte file is all of it.
    const suffix = await guest.get(base, { range: 'bytes=-1000' });
    expect(suffix.status).toBe(206);
    expect(suffix.raw.payload).toBe('admit one');
    expect(await counted()).toBe(1);
    // A Range the server doesn't honour gets the whole file.
    const ignored = await guest.get(base, { range: 'pages=2-' });
    expect(ignored.status).toBe(200);
    expect(ignored.raw.payload).toBe('admit one');
    expect(await counted()).toBe(2);
    // So does a resume whose If-Range no longer matches.
    const stale = await guest.get(base, { range: 'bytes=3-', 'if-range': '"older"' });
    expect(stale.status).toBe(200);
    expect(stale.raw.payload).toBe('admit one');
    expect(await counted()).toBe(3);
    expect((await guest.get(base, { range: 'bytes=3-' })).status).toBe(410);
  });

  it('counts every zip, whatever the Range header says', async () => {
    const box = (await owner.post('/folders', { parentId: root, name: 'Tickets' })).body.id;
    await uploadFile(owner, box, 'one.txt', Buffer.from('one'));
    const res = await owner.post(`/nodes/${box}/links`, { maxDownloads: 1 });
    const zip = `/public/links/${tokenOf(res.body.url)}/zip/${box}`;
    const guest = new Client(env.app);
    const first = await guest.get(zip, { range: 'bytes=100-' });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/zip');
    expect((await owner.get(`/nodes/${box}/links`)).body.items[0].downloadCount).toBe(1);
    expect((await guest.get(zip)).status).toBe(410);
  });
});

describe('a request link that gets around', () => {
  it('always has an end date: 7 days by default, 90 at most', async () => {
    const { link } = await newRequest();
    const days = (new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect((await newRequest({ expiresAt: null })).link.expiresAt).not.toBeNull();
    const tooLong = await owner.post(`/nodes/${inbox}/links`, {
      kind: 'upload',
      expiresAt: new Date(Date.now() + 91 * 86_400_000).toISOString(),
    });
    expect(tooLong.status).toBe(400);
    // Ordinary view links may still have no end date.
    const view = await owner.post(`/nodes/${inbox}/links`, { kind: 'view' });
    expect(view.body.expiresAt).toBeNull();
  });

  it('refuses programs and scripts, whatever the letter case', async () => {
    const { token } = await newRequest();
    const guest = new Client(env.app);
    for (const name of ['setup.EXE', 'invoice.pdf.scr', 'run.bat', 'app.apk']) {
      const res = await send(guest, token, name, Buffer.from('MZ'));
      expect(res.created.status, name).toBe(400);
    }
    expect((await send(guest, token, 'photo.jpg', bytes(10, 1))).last!.status).toBe(200);
  });

  it('stops after 1,000 files', async () => {
    const { link, token } = await newRequest();
    await env.ctx.db
      .update(shareLinks)
      .set({ uploadCount: 1000 })
      .where(eq(shareLinks.id, link.id));
    const res = await send(new Client(env.app), token, 'one-more.jpg', bytes(10, 2));
    expect(res.created.status).toBe(409);
  });

  it('makes a second folder instead of reusing one when asked to rename', async () => {
    const again = await owner.post('/folders', {
      parentId: root,
      name: 'Wedding photos',
      renameIfTaken: true,
    });
    expect(again.status).toBe(200);
    expect(again.body.id).not.toBe(inbox);
    expect(again.body.name).not.toBe('Wedding photos');
  });
});
