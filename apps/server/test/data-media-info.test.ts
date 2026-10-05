import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, nodes } from '../src/db/schema';
import { recoverPendingWork } from '../src/jobs/maintenance';
import { readMediaInfo, wallClock } from '../src/jobs/media-info';
import {
  addMember,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let env: TestEnv;
let dad: Client;
let mom: Client;
let momId: string;
let dadRoot: string;
let dadId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  dad = a.client;
  dadRoot = a.me.rootNodeId;
  dadId = a.me.id;
  const m = await addMember(env, dad, 'mom@example.com');
  mom = m.client;
  momId = m.me.id;
});
afterAll(async () => {
  await env.close();
});

/** A small JPEG with the EXIF a phone writes: when, and optionally where. */
function jpeg(taken: string | null, seed: number, gps = false) {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: seed, g: 80, b: 120 } },
  })
    .jpeg()
    .withExif({
      IFD0: { Make: 'Test' },
      ...(taken ? { IFD2: { DateTimeOriginal: taken } } : {}),
      ...(gps
        ? {
            IFD3: {
              GPSLatitudeRef: 'N',
              GPSLatitude: '15/1 29/1 3000/100',
              GPSLongitudeRef: 'E',
              GPSLongitude: '73/1 49/1 1200/100',
            },
          }
        : {}),
    })
    .toBuffer();
}

async function blobOf(nodeId: string) {
  const [row] = await env.ctx.db
    .select({ blob: blobs })
    .from(nodes)
    .innerJoin(blobs, eq(blobs.id, nodes.blobId))
    .where(eq(nodes.id, nodeId));
  return row!.blob;
}

async function add(c: Client, albumId: string, name: string, data: Buffer, mimeType: string) {
  const { folderId } = (await c.post(`/albums/${albumId}/folder`, {})).body;
  return (await uploadFile(c, folderId, name, data, { mimeType })).final!.body.node.id as string;
}

describe('when photos were taken', () => {
  it('reads camera clock dates, and rejects unset clocks and impossible dates', () => {
    expect(wallClock('2026:08:12 09:30:05')).toBe('2026-08-12 09:30:05');
    expect(wallClock('2026-08-12T09:30:05+0530')).toBe('2026-08-12 09:30:05');
    expect(wallClock('2026-08-12T04:00:05.000000Z')).toBe('2026-08-12 04:00:05');
    expect(wallClock('0000:00:00 00:00:00')).toBeNull();
    expect(wallClock('1970:01:01 00:00:00')).toBeNull();
    expect(wallClock('2026:02:31 10:00:00')).toBeNull();
    expect(wallClock('2999:01:01 10:00:00')).toBeNull();
    expect(wallClock(undefined)).toBeNull();
  });

  it('sorts a trip album by when photos were taken, whoever uploaded them first', async () => {
    const album = (
      await mom.post('/albums', {
        title: 'Goa',
        startDate: '2026-08-12',
        endDate: '2026-08-14',
        peopleIds: [momId, dadId],
      })
    ).body;
    // Mom uploads the last day first; Dad uploads a photo from the first morning a day later;
    // a WhatsApp photo has no date at all.
    const late = await add(
      mom,
      album.id,
      'beach.jpg',
      await jpeg('2026:08:14 18:00:00', 1, true),
      'image/jpeg',
    );
    const early = await add(
      dad,
      album.id,
      'arrival.jpg',
      await jpeg('2026:08:12 09:30:05', 2),
      'image/jpeg',
    );
    const undated = await add(mom, album.id, 'IMG-WA0001.jpg', await jpeg(null, 3), 'image/jpeg');

    const queued = env.jobs.take('media-info').map((j) => (j.data as { blobId: string }).blobId);
    expect(queued).toHaveLength(3);
    // Until it's been read, nothing is known: upload order.
    const before = (await mom.get(`/albums/${album.id}/photos`)).body.items;
    expect(before.map((p: { id: string }) => p.id)).toEqual([late, early, undated]);
    expect(before[0].takenAt).toBeNull();

    for (const blobId of queued) await readMediaInfo(env.ctx, blobId);
    const items = (await mom.get(`/albums/${album.id}/photos`)).body.items;
    // The undated photo was uploaded today, after the trip: it goes last.
    expect(items.map((p: { id: string }) => p.id)).toEqual([early, late, undated]);
    expect(items[0]).toMatchObject({ takenAt: '2026-08-12T09:30:05', location: null });
    expect(items[1].takenAt).toBe('2026-08-14T18:00:00');
    expect(items[1].location.latitude).toBeCloseTo(15.4917, 3);
    expect(items[1].location.longitude).toBeCloseTo(73.82, 3);
    expect(items[2].takenAt).toBeNull();
    expect((await blobOf(undated)).infoStatus).toBe('ready');

    // Pages continue in the same order.
    const p1 = (await mom.get(`/albums/${album.id}/photos?limit=2`)).body;
    const p2 = (await mom.get(`/albums/${album.id}/photos?limit=2&cursor=${p1.nextCursor}`)).body;
    expect([...p1.items, ...p2.items].map((p: { id: string }) => p.id)).toEqual([
      early,
      late,
      undated,
    ]);
    expect(p2.nextCursor).toBeNull();

    // The cover is the earliest photo taken.
    expect((await mom.get(`/albums/${album.id}`)).body.cover.nodeId).toBe(early);
  });

  it('never changes the stored file, and a file it cannot read still sorts by upload time', async () => {
    const data = Buffer.from('not really a jpeg');
    const id = (await uploadFile(dad, dadRoot, 'broken.jpg', data, { mimeType: 'image/jpeg' }))
      .final!.body.node.id;
    const blob = await blobOf(id);
    await readMediaInfo(env.ctx, blob.id);
    const after = await blobOf(id);
    expect(['ready', 'failed']).toContain(after.infoStatus);
    expect(after.takenAt).toBeNull();
    const content = await dad.get(`/nodes/${id}/content`);
    expect(content.body).toEqual(data);
  });

  it('reads photos stored before the update, through the hourly recovery', async () => {
    const id = (
      await uploadFile(dad, dadRoot, 'old.jpg', await jpeg('2025:12:24 20:00:00', 9), {
        mimeType: 'image/jpeg',
      })
    ).final!.body.node.id;
    const blob = await blobOf(id);
    env.jobs.take('media-info');
    await env.ctx.db
      .update(blobs)
      .set({ createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(blobs.id, blob.id));
    await recoverPendingWork(env.ctx);
    const queued = env.jobs.take('media-info').map((j) => (j.data as { blobId: string }).blobId);
    expect(queued).toContain(blob.id);
    await readMediaInfo(env.ctx, blob.id);
    expect((await blobOf(id)).takenAt).toBe('2025-12-24 20:00:00');
  });

  it.skipIf(!hasFfmpeg)('reads when and where a video was recorded', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fc-media-'));
    const out = path.join(dir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=64x64:rate=10',
      '-metadata',
      'creation_time=2026-08-13T07:15:00.000000Z',
      '-metadata',
      'location=+15.4917+073.8200/',
      '-movflags',
      'use_metadata_tags',
      '-y',
      out,
    ]);
    const id = (
      await uploadFile(dad, dadRoot, 'clip.mp4', readFileSync(out), { mimeType: 'video/mp4' })
    ).final!.body.node.id;
    const blob = await blobOf(id);
    await readMediaInfo(env.ctx, blob.id);
    const after = await blobOf(id);
    expect(after.takenAt).toBe('2026-08-13 07:15:00');
    expect(after.latitude).toBeCloseTo(15.4917, 3);
  });
});
