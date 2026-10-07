import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bytes, type Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv;
let alice: Client;
let aliceEmail: string;
let alicePassword: string;

type Method =
  | 'OPTIONS'
  | 'PROPFIND'
  | 'GET'
  | 'PUT'
  | 'MKCOL'
  | 'MOVE'
  | 'COPY'
  | 'DELETE'
  | 'LOCK'
  | 'UNLOCK'
  | 'PROPPATCH';

/** Speaks WebDAV like Finder / an iOS Files helper: Basic auth with an app password. */
function dav(email: string, password: string) {
  const auth = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
  return (
    method: Method,
    path: string,
    opts: { body?: Buffer | string; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> =>
    env.app.inject({
      method: method as 'GET',
      url: path,
      headers: { authorization: auth, ...opts.headers },
      payload: opts.body,
    });
}

async function newAppPassword(client: Client, name = 'iPad') {
  const res = await client.post('/auth/app-passwords', { name, password: client.password });
  expect(res.status).toBe(200);
  return res.body as {
    password: string;
    username: string;
    davUrl: string;
    appPassword: { id: string };
  };
}

beforeAll(async () => {
  env = await createTestEnv();
  const admin = await setupAdmin(env);
  const a = await addMember(env, admin.client, 'alice@example.com', { quotaBytes: 50_000 });
  alice = a.client;
  aliceEmail = a.me.email;
  alicePassword = (await newAppPassword(alice)).password;
});
afterAll(async () => {
  await env.close();
});

describe('authentication', () => {
  it('OPTIONS advertises WebDAV without credentials (Windows probes this first)', async () => {
    const res = await env.app.inject({ method: 'OPTIONS', url: '/dav/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.dav).toBe('1, 2');
  });

  it('requires an app password; the account password is not accepted', async () => {
    const anon = await env.app.inject({ method: 'PROPFIND' as 'GET', url: '/dav/' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['www-authenticate']).toMatch(/^Basic realm=/);
    expect((await dav(aliceEmail, 'another long password')('PROPFIND', '/dav/')).statusCode).toBe(
      401,
    );
    expect((await dav('bob@example.com', alicePassword)('PROPFIND', '/dav/')).statusCode).toBe(401);
  });

  it('accepts the app password typed without dashes or in capitals', async () => {
    const typed = alicePassword.replace(/-/g, '').toUpperCase();
    expect(
      (await dav(aliceEmail, typed)('PROPFIND', '/dav/', { headers: { depth: '0' } })).statusCode,
    ).toBe(207);
  });

  it('asks for the account password before making a device password', async () => {
    // A device password reaches every file and outlasts a password change: a stolen session
    // alone must not be able to make one.
    const create = (body: { name: string; password?: string }) =>
      alice.post('/auth/app-passwords', body);
    expect((await create({ name: 'Thief' })).status).toBe(400);
    const wrong = await create({ name: 'Thief', password: 'not my password' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.password).toBeUndefined();
    expect((await create({ name: 'Mine', password: alice.password })).status).toBe(200);
  });

  it('revoking a device password locks that device out immediately', async () => {
    const created = await newAppPassword(alice, 'Old phone');
    const phone = dav(aliceEmail, created.password);
    expect((await phone('PROPFIND', '/dav/', { headers: { depth: '0' } })).statusCode).toBe(207);
    expect((await alice.del(`/auth/app-passwords/${created.appPassword.id}`)).status).toBe(200);
    expect((await phone('PROPFIND', '/dav/', { headers: { depth: '0' } })).statusCode).toBe(401);
  });
});

describe('files over WebDAV', () => {
  const d = () => dav(aliceEmail, alicePassword);

  it('lists the two top-level folders with quota information', async () => {
    const res = await d()('PROPFIND', '/dav/', { headers: { depth: '1' } });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain('<D:href>/dav/My%20Files/</D:href>');
    expect(res.body).toContain('<D:href>/dav/Shared%20with%20me/</D:href>');
    expect(res.body).toContain('<D:quota-available-bytes>50000</D:quota-available-bytes>');
  });

  it('creates folders, uploads, downloads and overwrites in place', async () => {
    expect((await d()('MKCOL', '/dav/My%20Files/Trip%20photos')).statusCode).toBe(201);
    expect((await d()('MKCOL', '/dav/My%20Files/Trip%20photos')).statusCode).toBe(405);
    expect((await d()('MKCOL', '/dav/My%20Files/nope/deeper')).statusCode).toBe(409);

    const put = await d()('PUT', '/dav/My%20Files/Trip%20photos/caf%C3%A9.txt', {
      body: 'first version',
    });
    expect(put.statusCode).toBe(201);
    const get = await d()('GET', '/dav/My%20Files/Trip%20photos/caf%C3%A9.txt');
    expect(get.body).toBe('first version');

    const listing = await d()('PROPFIND', '/dav/My%20Files/Trip%20photos/', {
      headers: { depth: '1' },
    });
    expect(listing.body).toContain('/dav/My%20Files/Trip%20photos/caf%C3%A9.txt');
    expect(listing.body).toContain('<D:getcontentlength>13</D:getcontentlength>');

    const again = await d()('PUT', '/dav/My%20Files/Trip%20photos/caf%C3%A9.txt', { body: 'v2' });
    expect(again.statusCode).toBe(204);
    expect((await d()('GET', '/dav/My%20Files/Trip%20photos/caf%C3%A9.txt')).body).toBe('v2');
    // Overwriting keeps what was there as a version (counted until it expires), so a save
    // that went wrong can be undone.
    expect((await alice.get('/auth/me')).body.usedBytes).toBe(2 + 13);
    const search = await alice.get('/search?q=caf');
    const versions = await alice.get(`/nodes/${search.body.items[0].id}/versions`);
    expect(versions.body.items.map((v: { size: number }) => v.size)).toEqual([13]);
  });

  it('handles Finder-style chunked PUTs that announce the size separately', async () => {
    const data = bytes(3000);
    const res = await env.app.inject({
      method: 'PUT',
      url: '/dav/My%20Files/finder.bin',
      headers: {
        authorization: `Basic ${Buffer.from(`${aliceEmail}:${alicePassword}`).toString('base64')}`,
        'transfer-encoding': 'chunked',
        'x-expected-entity-length': '3000',
      },
      // A stream payload has no Content-Length, exactly like Finder's chunked upload.
      payload: Readable.from([data.subarray(0, 1000), data.subarray(1000)]),
    });
    expect(res.statusCode).toBe(201);
    const back = await d()('GET', '/dav/My%20Files/finder.bin');
    expect(Buffer.compare(back.rawPayload, data)).toBe(0);
  });

  it('renames with MOVE, duplicates with COPY, and DELETE goes to the web trash', async () => {
    await d()('PUT', '/dav/My%20Files/a.txt', { body: 'hello' });
    const mv = await d()('MOVE', '/dav/My%20Files/a.txt', {
      headers: { destination: 'https://cloud.example.com/dav/My%20Files/Trip%20photos/b.txt' },
    });
    expect(mv.statusCode).toBe(201);
    expect((await d()('GET', '/dav/My%20Files/a.txt')).statusCode).toBe(404);

    const cp = await d()('COPY', '/dav/My%20Files/Trip%20photos/', {
      headers: { destination: '/dav/My%20Files/Trip%20copy/' },
    });
    expect(cp.statusCode).toBe(201);
    expect((await d()('GET', '/dav/My%20Files/Trip%20copy/b.txt')).body).toBe('hello');

    const noOverwrite = await d()('COPY', '/dav/My%20Files/Trip%20photos/b.txt', {
      headers: { destination: '/dav/My%20Files/Trip%20copy/b.txt', overwrite: 'F' },
    });
    expect(noOverwrite.statusCode).toBe(412);

    expect((await d()('DELETE', '/dav/My%20Files/Trip%20copy/')).statusCode).toBe(204);
    const trash = await alice.get('/trash');
    expect(trash.body.items.some((i: { name: string }) => i.name === 'Trip copy')).toBe(true);
  });

  it('supports the LOCK/UNLOCK handshake Finder and Windows need to mount read-write', async () => {
    const lock = await d()('LOCK', '/dav/My%20Files/finder.bin', {
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"/>',
    });
    expect(lock.statusCode).toBe(200);
    expect(lock.headers['lock-token']).toMatch(/^<opaquelocktoken:/);
    expect(
      (
        await d()('UNLOCK', '/dav/My%20Files/finder.bin', {
          headers: { 'lock-token': String(lock.headers['lock-token']) },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await d()('PROPPATCH', '/dav/My%20Files/finder.bin', { body: '<x/>' })).statusCode,
    ).toBe(207);
  });

  it('enforces quota', async () => {
    const res = await d()('PUT', '/dav/My%20Files/huge.bin', { body: bytes(60_000) });
    expect(res.statusCode).toBe(507);
  });

  it('refuses writes at the virtual top level and requires a length', async () => {
    expect((await d()('PUT', '/dav/loose.txt', { body: 'x' })).statusCode).toBe(403);
    const noLength = await env.app.inject({
      method: 'PUT',
      url: '/dav/My%20Files/x.txt',
      headers: {
        authorization: `Basic ${Buffer.from(`${aliceEmail}:${alicePassword}`).toString('base64')}`,
        'transfer-encoding': 'chunked',
      },
      payload: Readable.from([Buffer.from('abc')]),
    });
    expect(noLength.statusCode).toBe(411);
  });
});

describe('shared folders over WebDAV', () => {
  it('shows family shares and respects view vs edit', async () => {
    const { client: bob, me: bobMe } = await addMember(
      env,
      (await setupAdminClient()).client,
      'bob@example.com',
      { quotaBytes: 50_000 },
    );
    const bobDav = dav(bobMe.email, (await newAppPassword(bob)).password);
    const folder = (
      await alice.post('/folders', {
        parentId: (await alice.get('/auth/me')).body.rootNodeId,
        name: 'Recipes',
      })
    ).body.id;
    const share = await alice.post(`/nodes/${folder}/shares`, {
      userId: bobMe.id,
      permission: 'view',
    });

    const list = await bobDav('PROPFIND', '/dav/Shared%20with%20me/', { headers: { depth: '1' } });
    expect(list.body).toContain('/dav/Shared%20with%20me/Recipes/');
    expect(
      (await bobDav('PUT', '/dav/Shared%20with%20me/Recipes/soup.txt', { body: 'x' })).statusCode,
    ).toBe(403);
    // Private folders of Alice stay invisible.
    expect((await bobDav('PROPFIND', '/dav/Shared%20with%20me/Trip%20photos/')).statusCode).toBe(
      404,
    );

    await alice.patch(`/shares/${share.body.id}`, { permission: 'edit' });
    const aliceBefore = (await alice.get('/auth/me')).body.usedBytes;
    expect(
      (await bobDav('PUT', '/dav/Shared%20with%20me/Recipes/soup.txt', { body: 'tomato' }))
        .statusCode,
    ).toBe(201);
    expect((await alice.get('/auth/me')).body.usedBytes).toBe(aliceBefore + 6);
    // The share root itself cannot be deleted or renamed by the grantee.
    expect((await bobDav('DELETE', '/dav/Shared%20with%20me/Recipes/')).statusCode).toBe(403);
  });
});

describe('brute force protection', () => {
  it('throttles repeated bad passwords per IP', async () => {
    const fresh = await createTestEnv();
    try {
      const auth = `Basic ${Buffer.from('x@example.com:wrong-wrong-wrong-wrong').toString('base64')}`;
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        codes.push(
          (
            await fresh.app.inject({
              method: 'PROPFIND' as 'GET',
              url: '/dav/',
              headers: { authorization: auth },
            })
          ).statusCode,
        );
      }
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
    } finally {
      await fresh.close();
    }
  });
});

async function setupAdminClient() {
  const { Client: C } = await import('./helpers');
  const c = new C(env.app);
  await c.post('/auth/login', { email: 'admin@example.com', password: 'correct horse battery' });
  return { client: c };
}

describe('share revoked during a WebDAV upload', () => {
  it('refuses to commit the file once the share is gone', async () => {
    const { PassThrough } = await import('node:stream');
    const admin = (await setupAdminClient()).client;
    const { client: carol, me: carolMe } = await addMember(env, admin, 'carol@example.com', {
      quotaBytes: 50_000,
    });
    const carolAuth = `Basic ${Buffer.from(`${carolMe.email}:${(await newAppPassword(carol)).password}`).toString('base64')}`;
    const folder = (
      await alice.post('/folders', {
        parentId: (await alice.get('/auth/me')).body.rootNodeId,
        name: 'Shared drop',
      })
    ).body.id;
    const share = await alice.post(`/nodes/${folder}/shares`, {
      userId: carolMe.id,
      permission: 'edit',
    });

    const body = new PassThrough();
    const put = env.app.inject({
      method: 'PUT',
      url: '/dav/Shared%20with%20me/Shared%20drop/late.txt',
      headers: { authorization: carolAuth, 'content-length': '10' },
      payload: body,
    });
    body.write('hello');
    // Wait until the upload is really in flight (its session exists), however slow the machine.
    for (let i = 0; i < 100; i++) {
      const [row] = (await env.ctx.db.execute(
        sql`SELECT count(*)::int AS n FROM upload_sessions WHERE name = 'late.txt'`,
      )) as unknown as { n: number }[];
      if (row!.n > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await alice.del(`/shares/${share.body.id}`)).status).toBe(200);
    body.end('world');
    const res = await put;
    expect(res.statusCode).toBe(403);
    const listing = await alice.get(`/nodes/${folder}/children`);
    expect(listing.body.items).toHaveLength(0);
  });
});

describe('device password limit', () => {
  it('holds under parallel requests', async () => {
    const admin = (await setupAdminClient()).client;
    const { client } = await addMember(env, admin, 'many-devices@example.com');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        client.post('/auth/app-passwords', { name: `Device ${i}`, password: client.password }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(25);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });
});
