import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uploadSessions } from '../src/db/schema';
import { expireUploads, reconcileUsage } from '../src/jobs/maintenance';
import { releaseUpload, writeChunk } from '../src/modules/uploads/service';
import { VOLUME_MARKER } from '../src/storage/volume-manager';
import {
  addMember,
  bytes,
  CHUNK,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
} from './helpers';

let env: TestEnv;
let admin: Client;
let c: Client;
let root: string;
let userId: string;
let email: string;

beforeAll(async () => {
  env = await createTestEnv();
  admin = (await setupAdmin(env)).client;
  const m = await addMember(env, admin, 'uploader@example.com', { quotaBytes: 50 * CHUNK });
  c = m.client;
  root = m.me.rootNodeId;
  userId = m.me.id;
  email = m.me.email;
});
afterAll(async () => {
  await env.close();
});

const originalPathOf = () => Object.getPrototypeOf(env.ctx.volumes).pathOf;
afterEach(() => {
  env.ctx.volumes.pathOf = originalPathOf();
});

async function usage() {
  const [u] = (await env.ctx.db.execute(
    sql`select used_bytes AS used, reserved_bytes AS reserved from users where id = ${userId}`,
  )) as unknown as { used: number; reserved: number }[];
  return { used: Number(u!.used), reserved: Number(u!.reserved) };
}

async function session(id: string) {
  const [s] = (await env.ctx.db.execute(
    sql`select s.status, s.blob_id AS "blobId", v.path AS "volumePath", v.id AS "volumeId"
        from upload_sessions s join storage_volumes v on v.id = s.volume_id where s.id = ${id}`,
  )) as unknown as { status: string; blobId: string; volumePath: string; volumeId: string }[];
  return {
    ...s!,
    tmp: env.ctx.volumes.tmpPath(s!.volumePath, id),
    final: env.ctx.volumes.blobPath(s!.volumePath, s!.blobId),
  };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function start(name: string, size: number) {
  const res = await c.post('/uploads', { parentId: root, name, size });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

const chunk = (id: string, i: number, body: Buffer) =>
  c.req('PUT', `/uploads/${id}/chunks/${i}`, { body });

describe('chunked upload state machine', () => {
  it('a cancel that lands while finalizing wins: no file, no double-released reservation', async () => {
    const before = await usage();
    const id = await start('cancelled.bin', 100);
    // The commit transaction is the first one finalizing opens: cancel just before it.
    const db = env.ctx.db as { transaction: typeof env.ctx.db.transaction };
    const original = db.transaction;
    db.transaction = (async (...args: Parameters<typeof original>) => {
      db.transaction = original;
      expect(await releaseUpload(env.ctx, id, 'aborted')).toBe(true);
      return original.apply(env.ctx.db, args);
    }) as typeof original;
    const res = await chunk(id, 0, bytes(100));
    db.transaction = original;

    expect(res.status).toBe(409);
    expect(await usage()).toEqual(before);
    expect((await c.get(`/nodes/${root}/children`)).body.items).toHaveLength(0);
    const s = await session(id);
    expect(s.status).toBe('aborted');
    expect(await exists(s.final)).toBe(false);
  });

  it('a late duplicate chunk after finalizing moved the temp file does not abort the upload', async () => {
    const id = await start('dup.bin', CHUNK + 10);
    expect((await chunk(id, 0, bytes(CHUNK))).status).toBe(200);
    const before = await usage();
    // As if the last chunk just arrived and finalizing renamed the temp file.
    env.ctx.volumes.pathOf = async (volumeId: string) => {
      env.ctx.volumes.pathOf = originalPathOf();
      const s = await session(id);
      await env.ctx.db.execute(
        sql`update upload_sessions set status = 'finalizing' where id = ${id}`,
      );
      await mkdir(path.dirname(s.final), { recursive: true });
      await rename(s.tmp, s.final);
      return env.ctx.volumes.pathOf(volumeId);
    };
    const res = await chunk(id, 0, bytes(CHUNK));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('finalizing');
    expect((await session(id)).status).toBe('finalizing');
    expect(await usage()).toEqual(before);
    await releaseUpload(env.ctx, id, 'aborted');
  });

  it('a copy of a chunk still streaming when the upload finishes never writes into the stored file', async () => {
    const data = bytes(1000, 5);
    const id = await start('trickled.bin', data.length);
    const [row] = await env.ctx.db.select().from(uploadSessions).where(eq(uploadSessions.id, id));
    // A second copy of chunk 0 sends a little, then stalls (a slow retry, or a sender doing it
    // on purpose to change the file after it has been checked).
    const slow = new PassThrough();
    const late = writeChunk(env.ctx, row!, 0, slow, null).catch((err: unknown) => err);
    slow.write(Buffer.alloc(10, 0x58));
    const s = await session(id);
    await vi.waitFor(async () =>
      expect((await readFile(s.tmp)).subarray(0, 10)).toEqual(Buffer.alloc(10, 0x58)),
    );

    const res = await chunk(id, 0, data);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    if (!slow.destroyed) slow.end(Buffer.alloc(990, 0x5a));
    // The stopped copy is answered like any late chunk, not with an error.
    const outcome = (await late) as Awaited<ReturnType<typeof writeChunk>>;
    expect(['finalizing', 'completed']).toContain(outcome.session.status);
    expect(Buffer.compare(await readFile(s.final), data)).toBe(0);
    const download = await c.get(`/nodes/${res.body.node.id}/content`);
    expect(Buffer.compare(download.raw.rawPayload, data)).toBe(0);
  });

  it('a disk that is briefly unmounted answers 503 and the upload resumes afterwards', async () => {
    const data = bytes(CHUNK + 10, 3);
    const id = await start('usb.bin', data.length);
    expect((await chunk(id, 0, data.subarray(0, CHUNK))).status).toBe(200);
    const s = await session(id);
    const marker = path.join(s.volumePath, VOLUME_MARKER);
    const saved = await readFile(marker);
    // Unmounted: the marker and the temp file both vanish with the disk.
    await rm(marker);
    await rename(s.tmp, `${s.tmp}.away`);
    try {
      const res = await chunk(id, 1, data.subarray(CHUNK));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('VOLUME_OFFLINE');
      expect((await session(id)).status).toBe('uploading');
    } finally {
      await writeFile(marker, saved);
      await rename(`${s.tmp}.away`, s.tmp).catch(() => {});
      env.ctx.volumes.invalidate();
    }
    const done = await chunk(id, 1, data.subarray(CHUNK));
    expect(done.body.status).toBe('completed');
    const dl = await c.get(`/nodes/${done.body.node.id}/content`);
    expect(Buffer.compare(dl.raw.rawPayload, data)).toBe(0);
  });

  it('never creates an upload on a disk whose marker vanished within the status cache window', async () => {
    const s0 = await session(await start('prime.bin', 1)); // status now cached as online
    const marker = path.join(s0.volumePath, VOLUME_MARKER);
    const saved = await readFile(marker);
    const before = await usage();
    const tmpBefore = await readdir(path.dirname(s0.tmp));
    await rm(marker);
    try {
      const res = await c.post('/uploads', { parentId: root, name: 'nowhere.bin', size: 10 });
      expect(res.status).toBe(503);
      expect(await usage()).toEqual(before);
      expect(await readdir(path.dirname(s0.tmp))).toEqual(tmpBefore);
    } finally {
      await writeFile(marker, saved);
      env.ctx.volumes.invalidate();
    }
  });
});

describe('expiry', () => {
  it('releases uploads cut off mid-finalize by a crash, including the renamed file', async () => {
    const id = await start('crashed.bin', 10);
    const before = await usage();
    const s = await session(id);
    await mkdir(path.dirname(s.final), { recursive: true });
    await rename(s.tmp, s.final);
    await env.ctx.db.execute(
      sql`update upload_sessions set status = 'finalizing', expires_at = now() - interval '1 minute' where id = ${id}`,
    );
    await expireUploads(env.ctx);
    expect((await session(id)).status).toBe('expired');
    expect(await usage()).toEqual({ used: before.used, reserved: before.reserved - 10 });
    expect(await exists(s.final)).toBe(false);
  });

  it('sweeps temp files left behind by a crash, but not recent ones', async () => {
    const s = await session(await start('fresh.bin', 5));
    const stale = path.join(path.dirname(s.tmp), 'migrate-leftover');
    await writeFile(stale, 'x');
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await utimes(stale, old, old);
    await expireUploads(env.ctx);
    expect(await exists(stale)).toBe(false);
    expect(await exists(s.tmp)).toBe(true);
  });
});

describe('WebDAV uploads', () => {
  it('stay reserved while streaming, even across a usage reconciliation', async () => {
    const pw = (await c.post('/auth/app-passwords', { name: 'Laptop', password: c.password })).body
      .password;
    const auth = `Basic ${Buffer.from(`${email}:${pw}`).toString('base64')}`;
    await reconcileUsage(env.ctx); // start from exact counters
    const before = await usage();
    const body = new PassThrough();
    const put = env.app.inject({
      method: 'PUT',
      url: '/dav/My%20Files/streamed.bin',
      headers: { authorization: auth, 'content-length': '1000' },
      payload: body,
    });
    body.write(bytes(400));
    await new Promise((r) => setTimeout(r, 50));
    await reconcileUsage(env.ctx);
    // Before the fix the reservation was invisible to reconciliation and got wiped here.
    expect(await usage()).toEqual({ used: before.used, reserved: before.reserved + 1000 });
    body.end(bytes(600));
    expect((await put).statusCode).toBe(201);
    expect(await usage()).toEqual({ used: before.used + 1000, reserved: before.reserved });
  });
});
