import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, nodes, storageVolumes } from '../src/db/schema';
import { drainVolume } from '../src/jobs/maintenance';
import { readMediaInfo } from '../src/jobs/media-info';
import { extractText } from '../src/jobs/text';
import { generateThumbnail } from '../src/jobs/thumbnail';
import { thumbPaths } from '../src/storage/thumbs';
import { VOLUME_MARKER } from '../src/storage/volume-manager';
import { bytes, type Client, createTestEnv, setupAdmin, type TestEnv, uploadFile } from './helpers';

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

async function blobOf(nodeId: string) {
  const [row] = (await env.ctx.db.execute(
    sql`select b.id, b.thumb_status AS "thumbStatus" from nodes n join blobs b on b.id = n.blob_id
        where n.id = ${nodeId}`,
  )) as unknown as { id: string; thumbStatus: string }[];
  return row!;
}

const hasFfmpeg = await promisify(execFile)('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);

async function clip(name: string, seconds: number): Promise<Buffer> {
  const file = path.join(env.dataDir, name);
  await promisify(execFile)('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=64x64:d=${seconds}`,
    '-pix_fmt',
    'yuv420p',
    '-y',
    file,
  ]);
  return readFile(file);
}

describe('thumbnails', () => {
  it.skipIf(!hasFfmpeg)(
    'two runs for the same blob (upload + recovery) do not break each other',
    async () => {
      const up = await uploadFile(admin, root, 'twice.mp4', await clip('twice.mp4', 2), {
        mimeType: 'video/mp4',
      });
      const blob = await blobOf(up.final!.body.node.id);
      const warnings: unknown[] = [];
      const warn = env.ctx.log.warn.bind(env.ctx.log);
      env.ctx.log.warn = ((obj: unknown, ...rest: unknown[]) => {
        warnings.push(obj);
        return (warn as (...a: unknown[]) => void)(obj, ...rest);
      }) as typeof env.ctx.log.warn;
      try {
        for (let i = 0; i < 3; i++) {
          await Promise.all([
            generateThumbnail(env.ctx, blob.id),
            generateThumbnail(env.ctx, blob.id),
          ]);
        }
      } finally {
        env.ctx.log.warn = warn;
      }
      expect(warnings).toEqual([]);
      expect((await blobOf(up.final!.body.node.id)).thumbStatus).toBe('ready');
      for (const p of thumbPaths(env.ctx.config.cacheDir, blob.id)) {
        expect((await stat(p)).isFile()).toBe(true);
      }
    },
  );

  it.skipIf(!hasFfmpeg)('renders clips shorter than a second', async () => {
    const up = await uploadFile(admin, root, 'short.mp4', await clip('short.mp4', 0.5), {
      mimeType: 'video/mp4',
    });
    const blob = await blobOf(up.final!.body.node.id);
    await generateThumbnail(env.ctx, blob.id);
    expect((await blobOf(up.final!.body.node.id)).thumbStatus).toBe('ready');
  });
});

describe('drain', () => {
  let disk1: { id: string; path: string };
  let disk2: { id: string; path: string };

  beforeAll(async () => {
    await mkdir(path.join(env.ctx.config.volumesRoot, 'disk2'), { recursive: true });
    const cands = await admin.get('/admin/volumes/candidates');
    const cand = cands.body.items.find((x: { name: string }) => x.name === 'disk2');
    expect((await admin.post('/admin/volumes', { name: 'disk2', path: cand.path })).status).toBe(
      200,
    );
    const vols = (await admin.get('/admin/overview')).body.volumes as {
      id: string;
      name: string;
      path: string;
    }[];
    disk1 = vols.find((v) => v.name === 'disk1')!;
    disk2 = vols.find((v) => v.name === 'disk2')!;
  });

  it('pauses (and retries later) when the other disks are offline, instead of giving up on files', async () => {
    await admin.patch(`/admin/volumes/${disk2.id}`, { status: 'readonly' });
    await uploadFile(admin, root, 'stay.bin', bytes(500, 9));
    await admin.patch(`/admin/volumes/${disk2.id}`, { status: 'active' });
    expect((await admin.post(`/admin/volumes/${disk1.id}/drain`)).status).toBe(200);
    env.jobs.take('drain-volume');

    const marker = path.join(disk2.path, VOLUME_MARKER);
    const saved = await readFile(marker);
    await rm(marker);
    env.ctx.volumes.invalidate();
    try {
      await expect(drainVolume(env.ctx, disk1.id)).rejects.toMatchObject({
        code: 'VOLUME_OFFLINE',
      });
      const overview = (await admin.get('/admin/overview')).body.volumes as {
        id: string;
        status: string;
        statusMessage: string | null;
      }[];
      const d1 = overview.find((v) => v.id === disk1.id)!;
      expect(d1.status).toBe('draining');
    } finally {
      await writeFile(marker, saved);
      env.ctx.volumes.invalidate();
    }
  });

  it('a blob another drain run already moved to the same disk is not deleted', async () => {
    const data = bytes(12_345, 4);
    // disk1 is draining (previous test): put this file there directly, like an older upload.
    const up = await uploadFile(admin, root, 'raced.bin', data);
    const id = up.final!.body.node.id;
    await env.ctx.db.execute(
      sql`update blobs set volume_id = ${disk1.id} where id = (select blob_id from nodes where id = ${id})`,
    );
    const blob = (await blobOf(id)).id;
    await mkdir(path.dirname(env.ctx.volumes.blobPath(disk1.path, blob)), { recursive: true });
    await copyFile(
      env.ctx.volumes.blobPath(disk2.path, blob),
      env.ctx.volumes.blobPath(disk1.path, blob),
    );

    const vm = env.ctx.volumes;
    const pick = vm.pickVolume.bind(vm);
    vm.pickVolume = async (exec, size, excludeId) => {
      const target = await pick(exec, size, excludeId);
      if (size === data.length) {
        // Meanwhile another run of the drain finished moving this same blob to that disk.
        await env.ctx.db.execute(sql`update blobs set volume_id = ${target.id} where id = ${blob}`);
      }
      return target;
    };
    try {
      await drainVolume(env.ctx, disk1.id);
    } finally {
      vm.pickVolume = pick;
    }
    const res = await admin.get(`/nodes/${id}/content`);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.raw.rawPayload, data)).toBe(0);
  });

  it('an upload finishing just as the disk looks empty is moved too, not left on a retired disk', async () => {
    await mkdir(path.join(env.ctx.config.volumesRoot, 'disk3'), { recursive: true });
    const cand = (await admin.get('/admin/volumes/candidates')).body.items.find(
      (x: { name: string }) => x.name === 'disk3',
    );
    const disk3 = (await admin.post('/admin/volumes', { name: 'disk3', path: cand.path })).body;
    // Start an upload on disk3, then drain it while the upload is still going.
    await admin.patch(`/admin/volumes/${disk2.id}`, { status: 'readonly' });
    const data = bytes(2_000, 6);
    const started = await admin.post('/uploads', {
      parentId: root,
      name: 'just-in-time.bin',
      size: data.length,
    });
    await admin.patch(`/admin/volumes/${disk2.id}`, { status: 'active' });
    expect((await admin.post(`/admin/volumes/${disk3.id}/drain`)).status).toBe(200);
    env.jobs.take('drain-volume');

    // The upload commits right after the drain found no files left on disk3.
    const db = env.ctx.db as any;
    const select = db.select;
    let armed = true;
    db.select = (...args: unknown[]) => {
      const builder = select.apply(db, args);
      const from = builder.from.bind(builder);
      builder.from = (table: unknown) => {
        const query = from(table);
        if (armed && table === blobs) {
          armed = false;
          const then = query.then.bind(query);
          // biome-ignore lint/suspicious/noThenProperty: runs the upload once the drain's query has answered
          query.then = (ok: any, fail: any) =>
            then(async (rows: unknown) => {
              const res = await admin.req('PUT', `/uploads/${started.body.id}/chunks/0`, {
                body: data,
              });
              expect(res.body.status).toBe('completed');
              return rows;
            }).then(ok, fail);
        }
        return query;
      };
      return builder;
    };
    try {
      await drainVolume(env.ctx, disk3.id);
    } finally {
      db.select = select;
    }
    expect(armed).toBe(false);
    const [file] = await env.ctx.db
      .select({ volumeId: blobs.volumeId })
      .from(blobs)
      .innerJoin(nodes, eq(nodes.blobId, blobs.id))
      .where(eq(nodes.name, 'just-in-time.bin'));
    expect(file?.volumeId).toBe(disk2.id);
    const vols = (await admin.get('/admin/overview')).body.volumes as {
      id: string;
      status: string;
    }[];
    expect(vols.find((v) => v.id === disk3.id)?.status).toBe('retired');
  });
});

describe('a disk that is unmounted for a while', () => {
  it('leaves thumbnails, photo dates and document words waiting, then makes them once it is back', async () => {
    const photo = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#22c55e' },
    })
      .jpeg()
      .toBuffer();
    const pic = (await uploadFile(admin, root, 'away.jpg', photo)).final!.body.node;
    const doc = (await uploadFile(admin, root, 'away.txt', Buffer.from('lighthouse keeper'))).final!
      .body.node;
    const picBlob = (await blobOf(pic.id)).id;
    const docBlob = (await blobOf(doc.id)).id;
    const statuses = async () => {
      const rows = await env.ctx.db
        .select({
          id: blobs.id,
          thumb: blobs.thumbStatus,
          info: blobs.infoStatus,
          text: blobs.textStatus,
        })
        .from(blobs)
        .where(inArray(blobs.id, [picBlob, docBlob]));
      const pick = (id: string) => rows.find((r) => r.id === id)!;
      return { thumb: pick(picBlob).thumb, info: pick(picBlob).info, text: pick(docBlob).text };
    };
    expect(await statuses()).toEqual({ thumb: 'pending', info: 'pending', text: 'pending' });

    // Unmounted: an empty directory where the disk was.
    const [vol] = await env.ctx.db
      .select({ path: storageVolumes.path })
      .from(storageVolumes)
      .innerJoin(blobs, eq(blobs.volumeId, storageVolumes.id))
      .where(eq(blobs.id, picBlob));
    const away = `${vol!.path}.away`;
    await rename(vol!.path, away);
    await mkdir(vol!.path);
    env.ctx.volumes.invalidate();
    try {
      for (const job of [generateThumbnail, readMediaInfo]) {
        await expect(job(env.ctx, picBlob)).rejects.toMatchObject({ code: 'VOLUME_OFFLINE' });
      }
      await expect(extractText(env.ctx, docBlob)).rejects.toMatchObject({
        code: 'VOLUME_OFFLINE',
      });
      // Still waiting, so the hourly recovery queues them again.
      expect(await statuses()).toEqual({ thumb: 'pending', info: 'pending', text: 'pending' });
    } finally {
      await rm(vol!.path, { recursive: true });
      await rename(away, vol!.path);
      env.ctx.volumes.invalidate();
    }
    await generateThumbnail(env.ctx, picBlob);
    await readMediaInfo(env.ctx, picBlob);
    await extractText(env.ctx, docBlob);
    expect(await statuses()).toEqual({ thumb: 'ready', info: 'ready', text: 'ready' });
  });
});

describe('adding disks', () => {
  it('refuses a directory that carries another registered volume’s marker (disk mounted elsewhere)', async () => {
    const vols = (await admin.get('/admin/overview')).body.volumes as {
      name: string;
      path: string;
    }[];
    const disk2 = vols.find((v) => v.name === 'disk2')!;
    const moved = path.join(env.ctx.config.volumesRoot, 'disk2-remounted');
    await mkdir(moved, { recursive: true });
    await copyFile(path.join(disk2.path, VOLUME_MARKER), path.join(moved, VOLUME_MARKER));
    const res = await admin.post('/admin/volumes', { name: 'disk3', path: moved });
    expect(res.status).toBe(409);
    env.ctx.volumes.invalidate();
    const after = (await admin.get('/admin/overview')).body.volumes as {
      name: string;
      online: boolean;
    }[];
    expect(after.find((v) => v.name === 'disk2')?.online).toBe(true);
  });
});
