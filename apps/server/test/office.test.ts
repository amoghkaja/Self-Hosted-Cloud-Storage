import { mkdir, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scrubUrl } from '../src/context';
import { blobs, fileVersions, nodes } from '../src/db/schema';
import { allowed, createEditorProxy } from '../src/modules/office/proxy';
import { buildWopiApp } from '../src/modules/office/wopi';
import {
  addMember,
  bytes,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

const DISCOVERY = `<wopi-discovery><net-zone name="external-http">
  <app name="writer">
    <action default="true" ext="docx" name="edit" urlsrc="https://office.test/browser/abc/cool.html?"/>
    <action ext="docx" name="view" urlsrc="https://office.test/browser/abc/cool.html?"/>
    <action ext="doc" name="edit" urlsrc="https://office.test/browser/abc/cool.html?"/>
  </app>
  <app name="calc">
    <action ext="xlsx" name="edit" urlsrc="https://office.test/browser/abc/cool.html?"/>
  </app>
</net-zone></wopi-discovery>`;

let editor: http.Server;
/** What the fake editor container was last asked (by the proxy). */
let lastUpstream: { url?: string; headers: http.IncomingHttpHeaders } | null = null;
let env: TestEnv;
let wopi: FastifyInstance;
let alice: Client;
let bob: Client;
let bobId: string;
let aliceRoot: string;
let hostDir: string;

beforeAll(async () => {
  editor = http.createServer((req, res) => {
    lastUpstream = { url: req.url, headers: req.headers };
    if (req.url === '/hosting/discovery') {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(DISCOVERY);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'keep-alive' });
    res.end(`editor:${req.url}`);
  });
  editor.on('upgrade', (_req, socket, head) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    if (head.length) socket.write(`echo:${head}`);
    socket.on('data', (d) => socket.write(`echo:${d}`));
    socket.on('end', () => socket.end());
  });
  await new Promise<void>((r) => editor.listen(0, '127.0.0.1', r));
  const port = (editor.address() as AddressInfo).port;

  env = await createTestEnv({
    OFFICE_PUBLIC_URL: 'http://office.localhost:5174',
    OFFICE_URL: `http://127.0.0.1:${port}`,
    OFFICE_WOPI_URL: 'http://app:3002',
  });
  wopi = await buildWopiApp(env.ctx, { logger: false });
  hostDir = path.join(env.ctx.config.cacheDir, 'updates');
  const a = await setupAdmin(env, 'alice@example.com');
  alice = a.client;
  aliceRoot = a.me.rootNodeId;
  const b = await addMember(env, alice, 'bob@example.com');
  bob = b.client;
  bobId = b.me.id;
});
afterAll(async () => {
  await wopi.close();
  await env.close();
  editor.closeAllConnections();
  await new Promise((r) => editor.close(r));
});

const setSwitch = (enabled: boolean) => alice.req('PUT', '/admin/office', { json: { enabled } });

async function upload(name: string, data = bytes(300)) {
  const up = await uploadFile(alice, aliceRoot, name, data);
  expect(up.final?.status).toBe(200);
  return up.final!.body.node.id as string;
}

async function openForEdit(c: Client, id: string) {
  const res = await c.post(`/nodes/${id}/edit`);
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const wopiReq = (
  method: 'GET' | 'POST',
  url: string,
  token: string,
  opts: { body?: Buffer; headers?: Record<string, string> } = {},
) =>
  wopi.inject({
    method,
    url: `${url}?access_token=${encodeURIComponent(token)}`,
    payload: opts.body,
    headers: opts.body
      ? { 'content-type': 'application/octet-stream', ...opts.headers }
      : opts.headers,
  });

describe('the admin switch', () => {
  it('is off until an admin turns it on, and only admins can', async () => {
    expect((await alice.get('/office')).body).toEqual({ available: false });
    expect((await bob.req('PUT', '/admin/office', { json: { enabled: true } })).status).toBe(403);
    const on = await setSwitch(true);
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ configured: true, enabled: true, running: true });
    expect((await bob.get('/office')).body).toEqual({ available: true });
  });

  it('asks the update helper to start or remove the editor, newest request only', async () => {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      path.join(hostDir, 'status.json'),
      JSON.stringify({
        format: 1,
        channel: 'stable',
        checkout: null,
        timezone: null,
        updates: 'notify',
        nextAutoAt: null,
        triedAt: now,
        checkedAt: now,
        problem: null,
        latest: null,
        ready: true,
        manualSteps: false,
        failedVersion: null,
        state: 'idle',
        phase: null,
        from: null,
        to: null,
        at: null,
        reason: null,
        trigger: null,
      }),
    );
    const off = await setSwitch(false);
    expect(off.body).toMatchObject({ enabled: false, helper: 'ok', pending: 'off' });
    expect((await readdir(hostDir)).filter((n) => n.startsWith('request-'))).toEqual([
      'request-office-off',
    ]);
    const on = await setSwitch(true);
    expect(on.body).toMatchObject({ enabled: true, pending: 'on' });
    expect((await readdir(hostDir)).filter((n) => n.startsWith('request-'))).toEqual([
      'request-office-on',
    ]);
  });
});

describe('opening a file', () => {
  beforeEach(async () => {
    await setSwitch(true);
  });

  it('gives the owner an editor address and a token for that file', async () => {
    const id = await upload('letter.docx');
    const res = await alice.post(`/nodes/${id}/edit`);
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe('http://office.localhost:5174');
    expect(res.body.url).toBe(
      `http://office.localhost:5174/browser/abc/cool.html?WOPISrc=${encodeURIComponent(`http://app:3002/wopi/files/${id}`)}&closebutton=1`,
    );
    expect(res.body.accessToken.length).toBeGreaterThan(30);
    expect(res.body.accessTokenTtl).toBeGreaterThan(Date.now());
  });

  it('refuses people who can only view (403) or not see it (404)', async () => {
    const id = await upload('private.docx');
    expect((await bob.post(`/nodes/${id}/edit`)).status).toBe(404);
    await alice.post(`/nodes/${id}/shares`, { userId: bobId, permission: 'view' });
    expect((await bob.post(`/nodes/${id}/edit`)).status).toBe(403);
  });

  it('refuses older formats, and everything while switched off', async () => {
    const doc = await upload('old.doc');
    expect((await alice.post(`/nodes/${doc}/edit`)).body.code).toBe('OFFICE_UNAVAILABLE');
    const id = await upload('later.docx');
    await setSwitch(false);
    const res = await alice.post(`/nodes/${id}/edit`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OFFICE_UNAVAILABLE');
  });

  it('refuses a file with a virus in it', async () => {
    const id = await upload('bad.docx');
    const [node] = await env.ctx.db.select().from(nodes).where(eq(nodes.id, id));
    await env.ctx.db
      .update(blobs)
      .set({ scanStatus: 'infected', scanSignature: 'Eicar' })
      .where(eq(blobs.id, node!.blobId!));
    expect((await alice.post(`/nodes/${id}/edit`)).body.code).toBe('FILE_INFECTED');
  });
});

describe('the editor reading and saving (WOPI)', () => {
  beforeEach(async () => {
    await setSwitch(true);
  });

  it('describes the file, sends it, and saves over it keeping one version per session', async () => {
    const original = bytes(400, 7);
    const id = await upload('report.docx', original);
    const token = await openForEdit(alice, id);

    const info = await wopiReq('GET', `/wopi/files/${id}`, token);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      BaseFileName: 'report.docx',
      Size: 400,
      UserCanWrite: true,
      UserCanNotWriteRelative: true,
      PostMessageOrigin: env.ctx.config.publicOrigin,
    });
    const file = await wopiReq('GET', `/wopi/files/${id}/contents`, token);
    expect(file.statusCode).toBe(200);
    expect(Buffer.from(file.rawPayload).equals(original)).toBe(true);

    const first = bytes(500, 8);
    const save1 = await wopiReq('POST', `/wopi/files/${id}/contents`, token, {
      body: first,
      headers: { 'x-cool-wopi-timestamp': info.json().LastModifiedTime },
    });
    expect(save1.statusCode).toBe(200);
    const second = bytes(600, 9);
    const save2 = await wopiReq('POST', `/wopi/files/${id}/contents`, token, {
      body: second,
      headers: { 'x-cool-wopi-timestamp': save1.json().LastModifiedTime },
    });
    expect(save2.statusCode).toBe(200);

    const content = await alice.get(`/nodes/${id}/content`);
    expect(Buffer.from(content.raw.rawPayload).equals(second)).toBe(true);
    // Two autosaves, one version: the file as it was when opened.
    const versions = await env.ctx.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.nodeId, id));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.size).toBe(400);
    // Opening it again starts a new session, which keeps what the last one saved.
    const again = await openForEdit(alice, id);
    const info2 = await wopiReq('GET', `/wopi/files/${id}`, again);
    await wopiReq('POST', `/wopi/files/${id}/contents`, again, {
      body: bytes(50, 1),
      headers: { 'x-cool-wopi-timestamp': info2.json().LastModifiedTime },
    });
    expect(
      await env.ctx.db.select().from(fileVersions).where(eq(fileVersions.nodeId, id)),
    ).toHaveLength(2);
  });

  it('answers 1010 when the file changed since the editor opened it', async () => {
    const id = await upload('shared-notes.docx');
    const token = await openForEdit(alice, id);
    const opened = (await wopiReq('GET', `/wopi/files/${id}`, token)).json().LastModifiedTime;
    // Saved over from elsewhere meanwhile (an upload with "Replace").
    await uploadFile(alice, aliceRoot, 'shared-notes.docx', bytes(77, 3), {
      onConflict: 'replace',
    });
    const res = await wopiReq('POST', `/wopi/files/${id}/contents`, token, {
      body: bytes(10),
      headers: { 'x-cool-wopi-timestamp': opened },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ COOLStatusCode: 1010 });
    // Overwriting, once the person chose to: no timestamp.
    const forced = await wopiReq('POST', `/wopi/files/${id}/contents`, token, { body: bytes(10) });
    expect(forced.statusCode).toBe(200);
  });

  it('only works for the file the token was made for', async () => {
    const id = await upload('one.docx');
    const other = await upload('two.docx');
    const token = await openForEdit(alice, id);
    expect((await wopiReq('GET', `/wopi/files/${other}`, token)).statusCode).toBe(401);
    expect((await wopiReq('GET', `/wopi/files/${other}/contents`, token)).statusCode).toBe(401);
    expect((await wopiReq('GET', `/wopi/files/${id}`, 'x'.repeat(43))).statusCode).toBe(401);
    expect((await wopi.inject({ method: 'GET', url: `/wopi/files/${id}` })).statusCode).toBe(401);
  });

  it('stops when the share is taken away or made view-only', async () => {
    const id = await upload('family-budget.xlsx');
    const share = await alice.post(`/nodes/${id}/shares`, { userId: bobId, permission: 'edit' });
    const token = await openForEdit(bob, id);
    expect((await wopiReq('GET', `/wopi/files/${id}`, token)).json().UserCanWrite).toBe(true);

    await alice.patch(`/shares/${share.body.id}`, { permission: 'view' });
    expect((await wopiReq('GET', `/wopi/files/${id}`, token)).json().UserCanWrite).toBe(false);
    const save = await wopiReq('POST', `/wopi/files/${id}/contents`, token, { body: bytes(5) });
    expect(save.statusCode).toBe(403);

    await alice.del(`/shares/${share.body.id}`);
    expect((await wopiReq('GET', `/wopi/files/${id}`, token)).statusCode).toBe(404);
    expect((await wopiReq('GET', `/wopi/files/${id}/contents`, token)).statusCode).toBe(404);
  });

  it('ends with the sign-in it came from', async () => {
    const id = await upload('signed-out.docx');
    await alice.post(`/nodes/${id}/shares`, { userId: bobId, permission: 'edit' });
    const { client: carol } = await addMember(env, alice, `carol-${Date.now()}@example.com`);
    await alice.post(`/nodes/${id}/shares`, {
      userId: (await carol.get('/auth/me')).body.id,
      permission: 'edit',
    });
    const token = await openForEdit(carol, id);
    expect((await wopiReq('GET', `/wopi/files/${id}`, token)).statusCode).toBe(200);
    await carol.post('/auth/logout');
    expect((await wopiReq('GET', `/wopi/files/${id}`, token)).statusCode).toBe(401);
  });

  it('switched off: nothing opens, but files already open can still be saved', async () => {
    const id = await upload('closing.docx');
    const token = await openForEdit(alice, id);
    await setSwitch(false);
    expect((await wopiReq('GET', `/wopi/files/${id}`, token)).statusCode).toBe(403);
    const save = await wopiReq('POST', `/wopi/files/${id}/contents`, token, { body: bytes(9) });
    expect(save.statusCode).toBe(200);
  });

  it('never sends a file with a virus in it', async () => {
    const id = await upload('later-infected.docx');
    const token = await openForEdit(alice, id);
    const [node] = await env.ctx.db.select().from(nodes).where(eq(nodes.id, id));
    await env.ctx.db
      .update(blobs)
      .set({ scanStatus: 'infected', scanSignature: 'Eicar' })
      .where(eq(blobs.id, node!.blobId!));
    const res = await wopiReq('GET', `/wopi/files/${id}/contents`, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FILE_INFECTED');
  });
});

describe('the editor proxy', () => {
  let proxy: http.Server;
  let port: number;
  beforeAll(async () => {
    proxy = createEditorProxy(env.ctx);
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    port = (proxy.address() as AddressInfo).port;
  });
  afterAll(async () => {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, { headers });

  it('lets only the editor pages and WebSocket through', () => {
    const wopiSrc = encodeURIComponent('http://app:3002/wopi/files/0198?access_token=abc');
    expect(allowed('/browser/abc/cool.html?WOPISrc=x')).toBe(true);
    expect(allowed(`/cool/${wopiSrc}/ws?WOPISrc=${wopiSrc}`)).toBe(true);
    expect(allowed('/cool/clipboard?WOPISrc=x')).toBe(true);
    for (const url of [
      '/',
      '/cool/convert-to/pdf',
      '/cool/%63onvert-to',
      '/COOL/CONVERT-TO',
      '/browser/abc/../../cool/convert-to',
      '/browser/abc/%2e%2e/%2e%2e/cool/convert-to',
      '/cool/adminws',
      '/cool/getMetrics',
      '/browser/dist/admin/admin.html',
      '/hosting/discovery',
      '/lool/convert-to',
      '/api/v1/auth/me',
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('passes pages through with their Host, without the app’s cookies', async () => {
    await setSwitch(true);
    const res = await get('/browser/abc/cool.html', { cookie: 'fc_session=secret' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('editor:/browser/abc/cool.html');
    expect(lastUpstream?.headers.cookie).toBeUndefined();
    expect(lastUpstream?.headers.host).toBe(`127.0.0.1:${port}`);
    expect((await get('/cool/convert-to/pdf')).status).toBe(404);
  });

  it('passes WebSockets through', async () => {
    const socket = net.connect(port, '127.0.0.1');
    socket.write(
      'GET /cool/x/ws HTTP/1.1\r\nHost: office.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello',
    );
    let received = '';
    await new Promise<void>((resolve) => {
      socket.on('data', (d) => {
        received += d;
        if (received.includes('echo:hello')) resolve();
      });
    });
    expect(received).toMatch(/^HTTP\/1.1 101/);
    socket.destroy();
  });

  it('turned off: says so instead of opening the editor', async () => {
    await setSwitch(false);
    const res = await get('/browser/abc/cool.html');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('turned off');
  });
});

it('keeps the editor’s tokens out of the logs', () => {
  expect(scrubUrl('/wopi/files/1/contents?access_token=abc123&x=1')).toBe(
    '/wopi/files/1/contents?access_token=[token]&x=1',
  );
});
