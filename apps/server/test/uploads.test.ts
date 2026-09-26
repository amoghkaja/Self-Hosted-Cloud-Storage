import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashBlob, reconcileUsage } from '../src/jobs/maintenance';
import {
  addMember,
  bytes,
  CHUNK,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let admin: Client;
let root: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  admin = a.client;
  root = a.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

describe('chunked uploads', () => {
  it('accepts chunks out of order and in parallel, and the bytes round-trip exactly', async () => {
    const data = bytes(Math.floor(CHUNK * 3.5), 7);
    for (const order of ['reverse', 'parallel'] as const) {
      const { final } = await uploadFile(admin, root, `big-${order}.bin`, data, { order });
      expect(final?.status).toBe(200);
      const node = final!.body.node ?? (await admin.get(`/uploads/${final!.body.id}`)).body.node;
      expect(node).toBeTruthy();
      const dl = await admin.get(`/nodes/${node.id}/content`);
      expect(dl.status).toBe(200);
      expect(Buffer.compare(dl.raw.rawPayload, data)).toBe(0);
    }
    expect(env.jobs.sent.some((j) => j.name === 'hash')).toBe(true);
  });

  it('reports received chunks so clients can resume', async () => {
    const data = bytes(CHUNK * 2 + 10);
    const created = await admin.post('/uploads', {
      parentId: root,
      name: 'resume.bin',
      size: data.length,
    });
    const id = created.body.id;
    await admin.req('PUT', `/uploads/${id}/chunks/2`, { body: data.subarray(CHUNK * 2) });
    const status = await admin.get(`/uploads/${id}`);
    expect(status.body.receivedChunks).toEqual([2]);
    await admin.req('PUT', `/uploads/${id}/chunks/0`, { body: data.subarray(0, CHUNK) });
    const last = await admin.req('PUT', `/uploads/${id}/chunks/1`, {
      body: data.subarray(CHUNK, CHUNK * 2),
    });
    expect(last.body.status).toBe('completed');
    expect(last.body.node.size).toBe(data.length);
  });

  it('rejects chunks with the wrong length', async () => {
    const created = await admin.post('/uploads', {
      parentId: root,
      name: 'bad.bin',
      size: CHUNK + 5,
    });
    const tooBig = await admin.req('PUT', `/uploads/${created.body.id}/chunks/1`, {
      body: bytes(6),
    });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe('CHUNK_INVALID');
    const outOfRange = await admin.req('PUT', `/uploads/${created.body.id}/chunks/9`, {
      body: bytes(1),
    });
    expect(outOfRange.status).toBe(400);
  });

  it('handles empty files and auto-renames duplicates', async () => {
    const a = await uploadFile(admin, root, 'empty.txt', Buffer.alloc(0));
    expect(a.final?.body.node.size).toBe(0);
    const b = await uploadFile(admin, root, 'empty.txt', Buffer.alloc(0));
    expect(b.final?.body.node.name).toBe('empty (1).txt');
  });
});

describe('downloads', () => {
  it('supports byte ranges for video seeking', async () => {
    const data = bytes(10_000, 3);
    const { final } = await uploadFile(admin, root, 'clip.mp4', data, { mimeType: 'video/mp4' });
    const id = final!.body.node.id;
    const part = await admin.get(`/nodes/${id}/content?inline=1`, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/10000');
    expect(Buffer.compare(part.raw.rawPayload, data.subarray(100, 200))).toBe(0);
    expect(part.headers['content-type']).toBe('video/mp4');
    const bad = await admin.get(`/nodes/${id}/content`, { range: 'bytes=20000-' });
    expect(bad.status).toBe(416);
    const etag = String(part.headers.etag);
    expect((await admin.get(`/nodes/${id}/content`, { 'if-none-match': etag })).status).toBe(304);
  });

  it('never renders uploaded HTML or SVG on our origin (stored XSS)', async () => {
    for (const [name, mime] of [
      ['evil.html', 'text/html'],
      ['evil.svg', 'image/svg+xml'],
    ] as const) {
      const { final } = await uploadFile(
        admin,
        root,
        name,
        Buffer.from('<script>alert(1)</script>'),
        { mimeType: mime },
      );
      const res = await admin.get(`/nodes/${final!.body.node.id}/content?inline=1`);
      expect(res.headers['content-disposition']).toMatch(/^attachment/);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-security-policy']).toMatch(/sandbox/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('encodes unicode filenames safely in Content-Disposition', async () => {
    const { final } = await uploadFile(admin, root, 'Résumé "final".pdf', Buffer.from('%PDF'));
    const res = await admin.get(`/nodes/${final!.body.node.id}/content`);
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf",
    );
    expect(res.headers['content-disposition']).toContain('filename="Resume _final_.pdf"');
  });

  it('streams folders as zip', async () => {
    const f = (await admin.post('/folders', { parentId: root, name: 'Zipme' })).body.id;
    await uploadFile(admin, f, 'one.txt', Buffer.from('one'));
    const sub = (await admin.post('/folders', { parentId: f, name: 'sub' })).body.id;
    await uploadFile(admin, sub, 'two.txt', Buffer.from('two'));
    const res = await admin.get(`/zip?ids=${f}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = res.raw.rawPayload;
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zip.includes(Buffer.from('Zipme/sub/two.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('Zipme/one.txt'))).toBe(true);
  });
});

describe('quotas', () => {
  it('blocks uploads beyond the quota and releases reservations on abort', async () => {
    const { client, me } = await addMember(env, admin, 'quota@example.com', { quotaBytes: 3000 });
    const ok = await uploadFile(client, me.rootNodeId, 'a.bin', bytes(2000));
    expect(ok.final?.status).toBe(200);
    const over = await client.post('/uploads', {
      parentId: me.rootNodeId,
      name: 'b.bin',
      size: 1500,
    });
    expect(over.status).toBe(507);
    expect(over.body.code).toBe('QUOTA_EXCEEDED');

    const pending = await client.post('/uploads', {
      parentId: me.rootNodeId,
      name: 'c.bin',
      size: 1000,
    });
    expect(pending.status).toBe(200);
    expect(
      (await client.post('/uploads', { parentId: me.rootNodeId, name: 'd.bin', size: 1 })).status,
    ).toBe(507);
    await client.del(`/uploads/${pending.body.id}`);
    expect(
      (await client.post('/uploads', { parentId: me.rootNodeId, name: 'e.bin', size: 1 })).status,
    ).toBe(200);
  });

  it('never over-commits under concurrent uploads', async () => {
    const { client, me } = await addMember(env, admin, 'race@example.com', { quotaBytes: 5000 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client.post('/uploads', { parentId: me.rootNodeId, name: `r${i}.bin`, size: 1000 }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 507)).toHaveLength(15);
  });

  it('lowering a quota below usage blocks new uploads but keeps files readable', async () => {
    const { client, me } = await addMember(env, admin, 'shrink@example.com', {
      quotaBytes: 10_000,
    });
    const up = await uploadFile(client, me.rootNodeId, 'keep.bin', bytes(4000));
    await admin.patch(`/admin/users/${me.id}`, { quotaBytes: 1000 });
    expect(
      (await client.post('/uploads', { parentId: me.rootNodeId, name: 'x', size: 1 })).status,
    ).toBe(507);
    expect((await client.get(`/nodes/${up.final!.body.node.id}/content`)).status).toBe(200);
  });

  it('enforces the global capacity cap across all users', async () => {
    const used = (await admin.get('/admin/overview')).body.totals;
    await admin.patch('/admin/settings', {
      globalCapacityBytes: used.usedBytes + used.reservedBytes + 100,
    });
    const res = await admin.post('/uploads', { parentId: root, name: 'cap.bin', size: 101 });
    expect(res.status).toBe(507);
    expect(res.body.code).toBe('CAPACITY_EXCEEDED');
    await admin.patch('/admin/settings', { globalCapacityBytes: null });
  });

  it('reconcile fixes drifted counters', async () => {
    const { sql } = await import('drizzle-orm');
    await env.ctx.db.execute(sql`update users set used_bytes = used_bytes + 12345`);
    const drift = await reconcileUsage(env.ctx);
    expect(drift.length).toBeGreaterThan(0);
    expect(await reconcileUsage(env.ctx)).toHaveLength(0);
  });

  it('records checksums', async () => {
    const { final } = await uploadFile(admin, root, 'sum.txt', Buffer.from('abc'));
    const node = final!.body.node;
    const { sql } = await import('drizzle-orm');
    const [row] = (await env.ctx.db.execute(
      sql`select blob_id from nodes where id = ${node.id}`,
    )) as unknown as { blob_id: string }[];
    await hashBlob(env.ctx, row!.blob_id);
    const [blob] = (await env.ctx.db.execute(
      sql`select sha256 from blobs where id = ${row!.blob_id}`,
    )) as unknown as { sha256: string }[];
    expect(blob!.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
