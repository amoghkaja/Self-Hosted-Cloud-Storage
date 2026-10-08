import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainVolume } from '../src/jobs/maintenance';
import { generateThumbnail } from '../src/jobs/thumbnail';
import { VOLUME_MARKER } from '../src/storage/volume-manager';
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

async function countBlobs(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else n++;
    }
  };
  await walk(path.join(dir, 'blobs'));
  return n;
}

describe('storage volumes', () => {
  it('starts with a default volume', async () => {
    const res = await admin.get('/admin/overview');
    expect(res.status).toBe(200);
    expect(res.body.volumes).toHaveLength(1);
    expect(res.body.volumes[0]).toMatchObject({ name: 'disk1', status: 'active', online: true });
  });

  it('lists unregistered directories as candidates and adds one as a volume', async () => {
    await mkdir(path.join(env.ctx.config.volumesRoot, 'disk2'), { recursive: true });
    const cands = await admin.get('/admin/volumes/candidates');
    const disk2 = cands.body.items.find((c: { name: string }) => c.name === 'disk2');
    expect(disk2).toBeTruthy();
    // Same filesystem as disk1 in tests: the UI warns that it adds no capacity.
    expect(disk2.sameFilesystemAs).toBe('disk1');

    const added = await admin.post('/admin/volumes', { name: 'disk2', path: disk2.path });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: 'disk2', online: true, status: 'active' });
    const overview = await admin.get('/admin/overview');
    expect(overview.body.warnings.some((w: string) => w.includes('same disk'))).toBe(true);
  });

  it('refuses paths outside the volumes root', async () => {
    for (const p of ['/etc', '../../', '/tmp']) {
      expect((await admin.post('/admin/volumes', { name: 'bad', path: p })).status).toBe(400);
    }
  });

  it('drains a volume: every file moves, verified, and stays downloadable', async () => {
    const vols = (await admin.get('/admin/overview')).body.volumes as {
      id: string;
      name: string;
      path: string;
    }[];
    const disk1 = vols.find((v) => v.name === 'disk1')!;
    const disk2 = vols.find((v) => v.name === 'disk2')!;
    // Pin new uploads to disk1 first so there is something to drain.
    await admin.patch(`/admin/volumes/${disk2.id}`, { status: 'readonly' });
    const files: { id: string; data: Buffer }[] = [];
    for (let i = 0; i < 6; i++) {
      const data = bytes(i === 0 ? CHUNK + 777 : 1000 + i, i + 10);
      const up = await uploadFile(admin, root, `drain-${i}.bin`, data);
      files.push({ id: up.final!.body.node.id, data });
    }
    await admin.patch(`/admin/volumes/${disk2.id}`, { status: 'active' });
    expect(await countBlobs(disk1.path)).toBeGreaterThanOrEqual(6);

    const start = await admin.post(`/admin/volumes/${disk1.id}/drain`);
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('draining');
    expect(env.jobs.take('drain-volume')).toHaveLength(1);
    await drainVolume(env.ctx, disk1.id);

    const after = (await admin.get('/admin/overview')).body.volumes as {
      name: string;
      status: string;
      blobCount: number;
    }[];
    expect(after.find((v) => v.name === 'disk1')).toMatchObject({
      status: 'retired',
      blobCount: 0,
    });
    expect(await countBlobs(disk1.path)).toBe(0);
    for (const f of files) {
      const res = await admin.get(`/nodes/${f.id}/content`);
      expect(Buffer.compare(res.raw.rawPayload, f.data)).toBe(0);
    }
    // New uploads land on the remaining volume.
    const next = await uploadFile(admin, root, 'after-drain.txt', Buffer.from('hi'));
    expect(next.final?.status).toBe(200);
  });

  it('refuses to drain the last active volume', async () => {
    const vols = (await admin.get('/admin/overview')).body.volumes as {
      id: string;
      name: string;
    }[];
    const disk2 = vols.find((v) => v.name === 'disk2')!;
    const res = await admin.post(`/admin/volumes/${disk2.id}/drain`);
    expect(res.status).toBe(409);
  });

  it('detects an unmounted disk (missing marker) as offline instead of writing to it', async () => {
    const vols = (await admin.get('/admin/overview')).body.volumes as {
      id: string;
      name: string;
      path: string;
    }[];
    const disk2 = vols.find((v) => v.name === 'disk2')!;
    const marker = path.join(disk2.path, VOLUME_MARKER);
    const saved = await stat(marker);
    expect(saved.isFile()).toBe(true);
    const { readFile, writeFile } = await import('node:fs/promises');
    const content = await readFile(marker);
    await rm(marker);
    env.ctx.volumes.invalidate();
    const res = await admin.post('/uploads', { parentId: root, name: 'x.bin', size: 10 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('VOLUME_OFFLINE');
    const overview = await admin.get('/admin/overview');
    expect(overview.body.warnings.some((w: string) => w.includes('offline'))).toBe(true);
    const ready = await admin.get('/readyz');
    expect(ready.status).toBe(503);
    await writeFile(marker, content);
    env.ctx.volumes.invalidate();
    expect((await admin.get('/readyz')).status).toBe(200);
  });
});

describe('thumbnails', () => {
  it('renders WebP thumbnails for images and serves them immutable', async () => {
    const png = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#3b82f6' },
    })
      .png()
      .toBuffer();
    const up = await uploadFile(admin, root, 'photo.png', png, { mimeType: 'image/png' });
    const node = up.final!.body.node;
    expect(node.thumb).toBe('pending');
    const job = env.jobs.take('thumbnail').at(-1)!;
    await generateThumbnail(env.ctx, (job.data as { blobId: string }).blobId);
    // As the web app asks for it: with the file's version, so it can be kept for good.
    const res = await admin.get(`/nodes/${node.id}/thumbnail?size=256&v=${node.updatedAt}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toContain('immutable');
    const meta = await sharp(res.raw.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(256);
    const big = await sharp(
      (await admin.get(`/nodes/${node.id}/thumbnail?size=1600`)).raw.rawPayload,
    ).metadata();
    expect(big.width).toBe(1600);
  });

  it('marks non-media files as unsupported without doing work', async () => {
    const up = await uploadFile(admin, root, 'notes.txt', Buffer.from('hello'));
    expect(up.final!.body.node.thumb).toBe('unsupported');
  });
});

describe('admin users & settings', () => {
  it('prevents the last admin from demoting themselves', async () => {
    const me = (await admin.get('/auth/me')).body;
    const res = await admin.patch(`/admin/users/${me.id}`, { role: 'member' });
    expect(res.status).toBe(400);
  });

  it('records admin actions in the audit log', async () => {
    await admin.patch('/admin/settings', { trashRetentionDays: 14 });
    const log = await admin.get('/admin/audit?limit=5');
    expect(
      log.body.items.some((e: { action: string }) => e.action === 'admin.settings_updated'),
    ).toBe(true);
    expect((await admin.get('/admin/settings')).body.trashRetentionDays).toBe(14);
  });
});
