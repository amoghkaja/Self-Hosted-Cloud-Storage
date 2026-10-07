import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, nodes } from '../src/db/schema';
import { exportFiles } from '../src/modules/admin/export';
import { type Client, createTestEnv, setupAdmin, type TestEnv, uploadFile } from './helpers';

let env: TestEnv;
let client: Client;
let root: string;
beforeAll(async () => {
  env = await createTestEnv();
  const admin = await setupAdmin(env);
  client = admin.client;
  root = admin.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

async function upload(name: string, text: string) {
  const { final } = await uploadFile(client, root, name, Buffer.from(text));
  return final!.body.node as { id: string };
}

describe('cli export (disaster recovery)', () => {
  it('can be re-run into the same folder without touching the live files', async () => {
    const out = path.join(env.dataDir, 'export');
    const first = await upload('a.txt', 'original contents');
    expect(await exportFiles(env.ctx, out)).toEqual({ files: 1, failed: [] });

    // a.txt is renamed and a different a.txt appears. The old export's a.txt is a hard link to
    // the renamed file's blob; copying the new file over it used to overwrite that blob.
    expect((await client.patch(`/nodes/${first.id}`, { name: 'b.txt' })).status).toBe(200);
    await upload('a.txt', 'brand new a');
    expect(await exportFiles(env.ctx, out)).toEqual({ files: 2, failed: [] });

    const dir = path.join(out, 'admin@example.com');
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('brand new a');
    expect(await readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('original contents');
    const live = await client.get(`/nodes/${first.id}/content`);
    expect(Buffer.from(live.body as Buffer).toString('utf8')).toBe('original contents');
  });

  it('keeps going past a file whose blob is missing and reports it', async () => {
    const lost = await upload('lost.txt', 'gone');
    const [row] = await env.ctx.db
      .select({ id: blobs.id, volumeId: blobs.volumeId })
      .from(nodes)
      .innerJoin(blobs, eq(blobs.id, nodes.blobId))
      .where(eq(nodes.id, lost.id));
    await rm(await env.ctx.volumes.blobFile(row!));
    const res = await exportFiles(env.ctx, path.join(env.dataDir, 'export2'));
    expect(res.files).toBe(2);
    expect(res.failed.map((f) => f.path)).toEqual([path.join('admin@example.com', 'lost.txt')]);
  });

  it('includes files still waiting for their virus check, but not infected ones', async () => {
    const blobOf = async (id: string) =>
      (await env.ctx.db.select().from(nodes).where(eq(nodes.id, id)))[0]!.blobId!;
    const waiting = await upload('waiting.txt', 'scanner was down');
    const bad = await upload('bad.txt', 'infected');
    await env.ctx.db
      .update(blobs)
      .set({ scanStatus: 'held' })
      .where(eq(blobs.id, await blobOf(waiting.id)));
    await env.ctx.db
      .update(blobs)
      .set({ scanStatus: 'infected' })
      .where(eq(blobs.id, await blobOf(bad.id)));
    const out = path.join(env.dataDir, 'export3');
    await exportFiles(env.ctx, out);
    const dir = path.join(out, 'admin@example.com');
    expect(await readFile(path.join(dir, 'waiting.txt'), 'utf8')).toBe('scanner was down');
    await expect(readFile(path.join(dir, 'bad.txt'))).rejects.toThrow();
  });
});
