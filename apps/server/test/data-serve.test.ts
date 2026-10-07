import { readdir, readlink, rm, unlink } from 'node:fs/promises';
import http from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateThumbnail } from '../src/jobs/thumbnail';
import { thumbPaths } from '../src/storage/thumbs';
import {
  bytes,
  CHUNK,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let c: Client;
let root: string;
let davAuth: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  c = a.client;
  root = a.me.rootNodeId;
  const pw = (await c.post('/auth/app-passwords', { name: 'Mac', password: c.password })).body
    .password;
  davAuth = `Basic ${Buffer.from(`${a.me.email}:${pw}`).toString('base64')}`;
});
afterAll(async () => {
  await env.close();
});

async function blobOf(nodeId: string) {
  const { sql } = await import('drizzle-orm');
  const [row] = (await env.ctx.db.execute(
    sql`select b.id, b.volume_id AS "volumeId", b.thumb_status AS "thumbStatus"
        from nodes n join blobs b on b.id = n.blob_id where n.id = ${nodeId}`,
  )) as unknown as { id: string; volumeId: string; thumbStatus: string }[];
  return row!;
}

describe('file responses', () => {
  it('HEAD reports the real size (WebDAV clients and download managers rely on it)', async () => {
    const { final } = await uploadFile(c, root, 'head.txt', Buffer.from('hello world'));
    const api = await c.req('HEAD', `/nodes/${final!.body.node.id}/content`);
    expect(api.status).toBe(200);
    expect(api.headers['content-length']).toBe('11');
    const dav = await env.app.inject({
      method: 'HEAD',
      url: '/dav/My%20Files/head.txt',
      headers: { authorization: davAuth },
    });
    expect(dav.statusCode).toBe(200);
    expect(dav.headers['content-length']).toBe('11');
  });

  it('answers 304 for an ETag inside a list or with a weak prefix', async () => {
    const { final } = await uploadFile(c, root, 'etag.txt', Buffer.from('etag'));
    const url = `/nodes/${final!.body.node.id}/content`;
    const etag = String((await c.get(url)).headers.etag);
    expect((await c.get(url, { 'if-none-match': `"nope", ${etag}` })).status).toBe(304);
    expect((await c.get(url, { 'if-none-match': `W/${etag}` })).status).toBe(304);
    expect((await c.get(url, { 'if-none-match': '"nope"' })).status).toBe(200);
  });

  it('ignores Range when If-Range names another version, so resumes never splice files', async () => {
    const data = bytes(1000, 5);
    const { final } = await uploadFile(c, root, 'resume.bin', data);
    const url = `/nodes/${final!.body.node.id}/content`;
    const etag = String((await c.get(url)).headers.etag);
    const stale = await c.get(url, { range: 'bytes=500-', 'if-range': '"an-older-version"' });
    expect(stale.status).toBe(200);
    expect(Buffer.compare(stale.raw.rawPayload, data)).toBe(0);
    const fresh = await c.get(url, { range: 'bytes=500-', 'if-range': etag });
    expect(fresh.status).toBe(206);
    expect(Buffer.compare(fresh.raw.rawPayload, data.subarray(500))).toBe(0);
  });
});

describe('zip downloads', () => {
  it('zips a folder whose name looks like a Windows drive ("C: backup")', async () => {
    const f = (await c.post('/folders', { parentId: root, name: 'C: backup' })).body.id;
    await uploadFile(c, f, 'a.txt', Buffer.from('a'));
    const res = await c.get(`/zip?ids=${f}`);
    expect(res.status).toBe(200);
    expect(res.raw.rawPayload.includes(Buffer.from('C_ backup/a.txt'))).toBe(true);
  });

  it('a file missing on disk fails that download instead of crashing the server', async () => {
    const f = (await c.post('/folders', { parentId: root, name: 'Broken' })).body.id;
    const up = await uploadFile(c, f, 'gone.txt', Buffer.from('bye'));
    const blob = await blobOf(up.final!.body.node.id);
    await unlink(await env.ctx.volumes.blobFile(blob));
    // Before the fix the read error was an unhandled stream error: an uncaught exception.
    const res = await c.get(`/zip?ids=${f}`).catch(() => null);
    if (res) expect(res.raw.rawPayload.includes(Buffer.from('PK\x05\x06'))).toBe(false);
    expect((await c.get('/auth/me')).status).toBe(200);
  });

  it('closes the file being read when the client disconnects mid-zip', async () => {
    const f = (await c.post('/folders', { parentId: root, name: 'Big' })).body.id;
    for (let i = 0; i < 3; i++) await uploadFile(c, f, `b${i}.bin`, bytes(CHUNK * 3, i));
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = env.app.server.address() as { port: number };
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { port, host: '127.0.0.1', path: `/api/v1/zip?ids=${f}`, headers: { cookie } },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', reject);
    });
    const openBlobs = async () => {
      const fds = await readdir('/proc/self/fd').catch(() => []);
      const targets = await Promise.all(
        fds.map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => '')),
      );
      return targets.filter((t) => t.includes(`${env.dataDir}/volumes/`) && t.includes('/blobs/'));
    };
    for (let i = 0; i < 20 && (await openBlobs()).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await openBlobs()).toEqual([]);
  });

  it('HEAD on a zip does not build the archive', async () => {
    const res = await c.req('HEAD', `/zip?ids=${root}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
  });
});

describe('thumbnail cache', () => {
  it('re-renders thumbnails whose cached files were lost (docs promise a rebuild)', async () => {
    const png = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#22aa66' },
    })
      .png()
      .toBuffer();
    const up = await uploadFile(c, root, 'lost.png', png, { mimeType: 'image/png' });
    const id = up.final!.body.node.id;
    const blob = await blobOf(id);
    await generateThumbnail(env.ctx, blob.id);
    expect((await c.get(`/nodes/${id}/thumbnail`)).status).toBe(200);

    for (const p of thumbPaths(env.ctx.config.cacheDir, blob.id)) await rm(p, { force: true });
    env.jobs.take('thumbnail');
    expect((await c.get(`/nodes/${id}/thumbnail`)).status).toBe(404);
    expect((await c.get(`/nodes/${id}/thumbnail`)).status).toBe(404);
    // Queued once (the status flip dedupes), and the file shows as pending meanwhile.
    expect(env.jobs.take('thumbnail').map((j) => j.data)).toEqual([{ blobId: blob.id }]);
    expect((await blobOf(id)).thumbStatus).toBe('pending');

    await generateThumbnail(env.ctx, blob.id);
    expect((await c.get(`/nodes/${id}/thumbnail`)).status).toBe(200);
  });
});
