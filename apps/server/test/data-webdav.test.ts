import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodes } from '../src/db/schema';
import { copyNode } from '../src/modules/files/copy';
import { moveNode } from '../src/modules/files/tree';
import { addMember, type Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
let alice: Client;
let aliceRoot: string;
let bobId: string;
let aliceDav: Dav;
let bobDav: Dav;

type Dav = (
  method: string,
  path: string,
  opts?: { body?: string | Readable; headers?: Record<string, string>; remoteAddress?: string },
) => Promise<LightMyRequestResponse>;

function davClient(email: string, password: string): Dav {
  const auth = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  return (method, path, opts = {}) =>
    env.app.inject({
      method: method as 'GET',
      url: path,
      headers: { authorization: auth, ...opts.headers },
      payload: opts.body,
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
    });
}

async function appPassword(client: Client) {
  return (await client.post('/auth/app-passwords', { name: 'Device', password: client.password }))
    .body.password as string;
}

beforeAll(async () => {
  env = await createTestEnv();
  admin = (await setupAdmin(env)).client;
  const a = await addMember(env, admin, 'alice@example.com', { quotaBytes: 100_000 });
  const b = await addMember(env, admin, 'bob@example.com', { quotaBytes: 100_000 });
  alice = a.client;
  aliceRoot = a.me.rootNodeId;
  bobId = b.me.id;
  aliceDav = davClient(a.me.email, await appPassword(alice));
  bobDav = davClient(b.me.email, await appPassword(b.client));
});
afterAll(async () => {
  await env.close();
});

const listing = async (path: string) =>
  (await aliceDav('PROPFIND', path, { headers: { depth: '1' } })).body;

describe('MOVE and COPY', () => {
  it('renames when only the case changes (Finder: "photo.jpg" → "Photo.jpg")', async () => {
    expect((await aliceDav('PUT', '/dav/My%20Files/photo.jpg', { body: 'x' })).statusCode).toBe(
      201,
    );
    const mv = await aliceDav('MOVE', '/dav/My%20Files/photo.jpg', {
      headers: { destination: '/dav/My%20Files/Photo.jpg' },
    });
    expect(mv.statusCode).toBe(201);
    const body = await listing('/dav/My%20Files/');
    expect(body).toContain('/dav/My%20Files/Photo.jpg');
    expect(body).not.toContain('/dav/My%20Files/photo.jpg');
    // Same name: still "source and destination are the same".
    const same = await aliceDav('MOVE', '/dav/My%20Files/Photo.jpg', {
      headers: { destination: '/dav/My%20Files/Photo.jpg' },
    });
    expect(same.statusCode).toBe(403);
  });

  it('refuses to overwrite a folder that contains the source (it would trash the source)', async () => {
    await aliceDav('MKCOL', '/dav/My%20Files/Holder');
    await aliceDav('PUT', '/dav/My%20Files/Holder/inside.txt', { body: 'keep me' });
    const mv = await aliceDav('MOVE', '/dav/My%20Files/Holder/inside.txt', {
      headers: { destination: '/dav/My%20Files/Holder', overwrite: 'T' },
    });
    expect(mv.statusCode).toBe(403);
    const cp = await aliceDav('COPY', '/dav/My%20Files/Holder/inside.txt', {
      headers: { destination: '/dav/My%20Files/Holder', overwrite: 'T' },
    });
    expect(cp.statusCode).toBe(403);
    expect((await aliceDav('GET', '/dav/My%20Files/Holder/inside.txt')).body).toBe('keep me');
    expect((await alice.get('/trash')).body.items).toHaveLength(0);
  });

  it('COPY over an item leaves it in place when the copy fails', async () => {
    const carol = await addMember(env, admin, 'carol@example.com', { quotaBytes: 10_000 });
    const carolDav = davClient(carol.me.email, await appPassword(carol.client));
    await carolDav('PUT', '/dav/My%20Files/big.txt', { body: 'x'.repeat(6000) });
    await carolDav('PUT', '/dav/My%20Files/keep.txt', { body: 'keep me' });
    await carolDav('MKCOL', '/dav/My%20Files/Keep');
    await carolDav('PUT', '/dav/My%20Files/Keep/a.txt', { body: 'a' });
    await carolDav('MKCOL', '/dav/My%20Files/Holder');
    await carolDav('MOVE', '/dav/My%20Files/big.txt', {
      headers: { destination: '/dav/My%20Files/Holder/big.txt' },
    });

    // Neither copy fits in Carol's quota.
    const file = await carolDav('COPY', '/dav/My%20Files/Holder/big.txt', {
      headers: { destination: '/dav/My%20Files/keep.txt', overwrite: 'T' },
    });
    expect(file.statusCode).toBe(507);
    const folder = await carolDav('COPY', '/dav/My%20Files/Holder/', {
      headers: { destination: '/dav/My%20Files/Keep/', overwrite: 'T' },
    });
    expect(folder.statusCode).toBe(507);

    expect((await carolDav('GET', '/dav/My%20Files/keep.txt')).body).toBe('keep me');
    expect((await carolDav('GET', '/dav/My%20Files/Keep/a.txt')).body).toBe('a');
    expect((await carol.client.get('/trash')).body.items).toHaveLength(0);
  });

  it('COPY of a file over a file saves over it: sharing stays, the old text is a version', async () => {
    await aliceDav('PUT', '/dav/My%20Files/report-draft.txt', { body: 'new text' });
    await aliceDav('PUT', '/dav/My%20Files/report.txt', { body: 'old text' });
    const children = await alice.get(`/nodes/${aliceRoot}/children`);
    const report = children.body.items.find((n: { name: string }) => n.name === 'report.txt');
    await alice.post(`/nodes/${report.id}/shares`, { userId: bobId, permission: 'view' });
    const before = (await alice.get('/auth/me')).body.usedBytes;

    const cp = await aliceDav('COPY', '/dav/My%20Files/report-draft.txt', {
      headers: { destination: '/dav/My%20Files/report.txt' },
    });
    expect(cp.statusCode).toBe(204);
    // The same file (not a new one in its place), so Bob still has it.
    expect((await alice.get(`/nodes/${report.id}`)).status).toBe(200);
    expect((await bobDav('GET', '/dav/Shared%20with%20me/report.txt')).body).toBe('new text');
    const versions = await alice.get(`/nodes/${report.id}/versions`);
    expect(versions.body.items.map((v: { size: number }) => v.size)).toEqual([8]);
    expect((await alice.get('/auth/me')).body.usedBytes).toBe(before + 8);
    expect((await aliceDav('GET', '/dav/My%20Files/report-draft.txt')).body).toBe('new text');
    expect((await alice.get('/trash')).body.items).toHaveLength(0);
  });

  it('COPY and MOVE never trash an item they replace once it moved out of reach', async () => {
    const team = (await alice.post('/folders', { parentId: aliceRoot, name: 'Team' })).body.id;
    const plan = (await alice.post('/folders', { parentId: team, name: 'plan' })).body.id;
    const hidden = (await alice.post('/folders', { parentId: aliceRoot, name: 'Hidden' })).body.id;
    await alice.post(`/nodes/${team}/shares`, { userId: bobId, permission: 'edit' });
    await bobDav('PUT', '/dav/Shared%20with%20me/Team/memo.txt', { body: 'memo' });
    const [memo] = await env.ctx.db.select().from(nodes).where(eq(nodes.name, 'memo.txt'));
    // Bob's COPY found "plan" in the shared folder; before it commits, Alice moves "plan" into a
    // folder Bob can't see.
    await alice.patch(`/nodes/${plan}`, { parentId: hidden });
    const copy = copyNode(env.ctx, {
      userId: bobId,
      source: memo!,
      dest: { id: team, ownerId: memo!.ownerId },
      name: 'plan',
      onConflict: 'fail',
      replace: { id: plan, type: 'folder' },
    });
    await expect(copy).rejects.toMatchObject({ status: 403 });
    expect((await alice.get(`/nodes/${plan}`)).status).toBe(200);

    // The same race with MOVE over "plan 2".
    const plan2 = (await alice.post('/folders', { parentId: team, name: 'plan 2' })).body.id;
    await alice.patch(`/nodes/${plan2}`, { parentId: hidden });
    const move = moveNode(
      env.ctx.db,
      memo!,
      { name: 'plan 2', parentId: team },
      { replaceId: plan2, actorId: bobId },
    );
    await expect(move).rejects.toMatchObject({ status: 403 });
    expect((await alice.get(`/nodes/${plan2}`)).status).toBe(200);
    expect((await alice.get('/trash')).body.items).toHaveLength(0);
  });

  it('refuses to copy a folder into itself', async () => {
    await aliceDav('MKCOL', '/dav/My%20Files/Loop');
    await aliceDav('MKCOL', '/dav/My%20Files/Loop/sub');
    const cp = await aliceDav('COPY', '/dav/My%20Files/Loop/', {
      headers: { destination: '/dav/My%20Files/Loop/sub/Loop/' },
    });
    expect(cp.statusCode).toBe(403);
    expect(await listing('/dav/My%20Files/Loop/sub/')).not.toContain('sub/Loop');
  });
});

describe('PROPFIND', () => {
  it('lists every child of a folder bigger than one batch', async () => {
    const many = (await alice.post('/folders', { parentId: aliceRoot, name: 'Many' })).body.id;
    await env.ctx.db.execute(sql`
      INSERT INTO nodes (id, owner_id, parent_id, type, name, created_by)
      SELECT gen_random_uuid(), owner_id, id, 'folder', 'f' || lpad(i::text, 4, '0'), owner_id
      FROM nodes, generate_series(1, 2500) i WHERE id = ${many}`);
    const res = await aliceDav('PROPFIND', '/dav/My%20Files/Many/', { headers: { depth: '1' } });
    expect(res.statusCode).toBe(207);
    const hrefs = [...res.body.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2501);
    expect(new Set(hrefs).size).toBe(2501);
    expect(hrefs[1]).toMatch(/\/f0001\/$/);
    expect(hrefs.at(-1)).toMatch(/\/f2500\/$/);
    expect(res.body.endsWith('</D:multistatus>')).toBe(true);
  });
});

describe('PUT', () => {
  it('lets an edit grantee save over a file shared with them directly', async () => {
    await aliceDav('PUT', '/dav/My%20Files/notes.txt', { body: 'v1' });
    const children = await alice.get(`/nodes/${aliceRoot}/children`);
    const notes = children.body.items.find((n: { name: string }) => n.name === 'notes.txt');
    const share = await alice.post(`/nodes/${notes.id}/shares`, {
      userId: bobId,
      permission: 'view',
    });
    expect(
      (await bobDav('PUT', '/dav/Shared%20with%20me/notes.txt', { body: 'nope' })).statusCode,
    ).toBe(403);

    await alice.patch(`/shares/${share.body.id}`, { permission: 'edit' });
    const before = (await alice.get('/auth/me')).body.usedBytes;
    const put = await bobDav('PUT', '/dav/Shared%20with%20me/notes.txt', { body: 'v2 by bob' });
    expect(put.statusCode).toBe(204);
    expect((await aliceDav('GET', '/dav/My%20Files/notes.txt')).body).toBe('v2 by bob');
    // Same node (sharing kept), charged to the owner; Alice's text is kept as a version.
    expect((await alice.get(`/nodes/${notes.id}`)).status).toBe(200);
    expect((await alice.get('/auth/me')).body.usedBytes).toBe(before + 9);
    const versions = await alice.get(`/nodes/${notes.id}/versions`);
    expect(versions.body.current.modifiedBy.id).toBe(bobId);
    expect(versions.body.items.map((v: { size: number }) => v.size)).toEqual([2]);
  });

  it('honours If-Match and If-None-Match so clients can avoid lost updates', async () => {
    const first = await aliceDav('PUT', '/dav/My%20Files/doc.txt', { body: 'one' });
    const etag = String(first.headers.etag);
    const stale = await aliceDav('PUT', '/dav/My%20Files/doc.txt', {
      body: 'two',
      headers: { 'if-match': '"not-the-current-version"' },
    });
    expect(stale.statusCode).toBe(412);
    expect((await aliceDav('GET', '/dav/My%20Files/doc.txt')).body).toBe('one');
    const createOnly = await aliceDav('PUT', '/dav/My%20Files/doc.txt', {
      body: 'three',
      headers: { 'if-none-match': '*' },
    });
    expect(createOnly.statusCode).toBe(412);
    const ok = await aliceDav('PUT', '/dav/My%20Files/doc.txt', {
      body: 'four',
      headers: { 'if-match': etag },
    });
    expect(ok.statusCode).toBe(204);
    expect((await aliceDav('GET', '/dav/My%20Files/doc.txt')).body).toBe('four');
    const missing = await aliceDav('PUT', '/dav/My%20Files/new.txt', {
      body: 'x',
      headers: { 'if-match': '*' },
    });
    expect(missing.statusCode).toBe(412);
  });

  it('does not keep the empty file Finder and Windows write first as a version', async () => {
    const placeholder = await aliceDav('PUT', '/dav/My%20Files/copied.txt', {
      headers: { 'content-length': '0' },
    });
    expect(placeholder.statusCode).toBe(201);
    const contents = await aliceDav('PUT', '/dav/My%20Files/copied.txt', { body: 'the contents' });
    expect(contents.statusCode).toBe(204);
    const children = await alice.get(`/nodes/${aliceRoot}/children`);
    const file = children.body.items.find((n: { name: string }) => n.name === 'copied.txt');
    expect((await alice.get(`/nodes/${file.id}/versions`)).body.items).toEqual([]);
    expect((await aliceDav('GET', '/dav/My%20Files/copied.txt')).body).toBe('the contents');
  });

  it('refuses a partial PUT instead of replacing the file with the part sent', async () => {
    await aliceDav('PUT', '/dav/My%20Files/resume.txt', { body: 'helloworld' });
    // What `curl -T file -C -` sends to resume an upload: only the bytes after the first five.
    const partial = await aliceDav('PUT', '/dav/My%20Files/resume.txt', {
      body: 'WORLD',
      headers: { 'content-range': 'bytes 5-9/10' },
    });
    expect(partial.statusCode).toBe(400);
    expect((await aliceDav('GET', '/dav/My%20Files/resume.txt')).body).toBe('helloworld');
  });
});

describe('LOCK and PROPPATCH', () => {
  it('LOCK answers 409 when the parent folder is missing, and a refresh keeps its token', async () => {
    expect((await aliceDav('LOCK', '/dav/My%20Files/nope/file.txt')).statusCode).toBe(409);
    const lock = await aliceDav('LOCK', '/dav/My%20Files/doc.txt', {
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"/>',
    });
    const token = String(lock.headers['lock-token']).slice(1, -1);
    const refresh = await aliceDav('LOCK', '/dav/My%20Files/doc.txt', {
      headers: { if: `(<${token}>)`, timeout: 'Second-3600' },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.body).toContain(`<D:href>${token}</D:href>`);
  });

  it('PROPPATCH acknowledges each property it was sent (Windows sets its Win32 times)', async () => {
    const res = await aliceDav('PROPPATCH', '/dav/My%20Files/doc.txt', {
      body:
        '<?xml version="1.0" encoding="utf-8" ?><D:propertyupdate xmlns:D="DAV:" ' +
        'xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop>' +
        '<Z:Win32CreationTime>Mon, 01 Jan 2024 00:00:00 GMT</Z:Win32CreationTime>' +
        '<Z:Win32FileAttributes>00000020</Z:Win32FileAttributes>' +
        '</D:prop></D:set></D:propertyupdate>',
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toMatch(/<x0:Win32CreationTime xmlns:x0="urn:schemas-microsoft-com:"\/>/);
    expect(res.body).toMatch(/<x1:Win32FileAttributes xmlns:x1="urn:schemas-microsoft-com:"\/>/);
    expect(res.body).toContain('HTTP/1.1 200 OK');
    const folder = await aliceDav('PROPPATCH', '/dav/My%20Files/Holder', { body: '' });
    expect(folder.body).toContain('<D:href>/dav/My%20Files/Holder/</D:href>');
  });
});

describe('malformed requests', () => {
  it('answers a NUL in a path or a Destination with 400, not 500', async () => {
    expect((await aliceDav('GET', '/dav/My%20Files/%00')).statusCode).toBe(400);
    expect((await aliceDav('PROPFIND', '/dav/My%20Files/a%00b/')).statusCode).toBe(400);
    await aliceDav('PUT', '/dav/My%20Files/nul-check.txt', { body: 'stay' });
    const mv = await aliceDav('MOVE', '/dav/My%20Files/nul-check.txt', {
      headers: { destination: '/dav/My%20Files/%00/nul-check.txt' },
    });
    expect(mv.statusCode).toBe(400);
    expect((await aliceDav('GET', '/dav/My%20Files/nul-check.txt')).statusCode).toBe(200);
  });

  it('answers a size that is not a plain number of bytes with 411, not 500', async () => {
    for (const size of ['1e300', '18446744073709551615']) {
      const res = await aliceDav('PUT', '/dav/My%20Files/odd-size.bin', {
        // Finder's chunked upload: no Content-Length, the size in its own header.
        body: Readable.from([Buffer.from('abc')]),
        headers: { 'transfer-encoding': 'chunked', 'x-expected-entity-length': size },
      });
      expect(res.statusCode).toBe(411);
    }
  });
});

describe('device password throttle', () => {
  it('counts failures per IPv6 /64, so rotating addresses does not reset it', async () => {
    const wrong = davClient('alice@example.com', 'wrong-wrong-wrong-wrong');
    for (let i = 1; i <= 10; i++) {
      const res = await wrong('PROPFIND', '/dav/', { remoteAddress: `2001:db8:1:2::${i}` });
      expect(res.statusCode).toBe(401);
    }
    const sameNet = await aliceDav('PROPFIND', '/dav/', {
      headers: { depth: '0' },
      remoteAddress: '2001:db8:1:2:ffff::99',
    });
    expect(sameNet.statusCode).toBe(429);
    const otherNet = await aliceDav('PROPFIND', '/dav/', {
      headers: { depth: '0' },
      remoteAddress: '2001:db8:1:3::1',
    });
    expect(otherNet.statusCode).toBe(207);
  });
});
