import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodes } from '../src/db/schema';
import {
  addMember,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let mom: Client;
let kid: Client;
let momRoot: string;
let kidId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  mom = a.client;
  momRoot = a.me.rootNodeId;
  const k = await addMember(env, mom, 'kid@example.com');
  kid = k.client;
  kidId = k.me.id;
});
afterAll(async () => {
  await env.close();
});

const put = async (parentId: string, name: string, text: string) =>
  (await uploadFile(mom, parentId, name, Buffer.from(text), { onConflict: 'replace' })).final!.body
    .node.id as string;
const read = async (id: string) =>
  Buffer.from((await mom.get(`/nodes/${id}/content`)).body).toString();
const parentOf = async (id: string) =>
  (await env.ctx.db.select().from(nodes).where(eq(nodes.id, id)))[0]!;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('rewind a folder', () => {
  it('puts back what was deleted and what files held, and keeps what was added', async () => {
    const taxes = (await mom.post('/folders', { parentId: momRoot, name: 'Taxes' })).body.id;
    const year = (await mom.post('/folders', { parentId: taxes, name: '2024' })).body.id;
    const a = await put(taxes, 'a.txt', 'A');
    const b = await put(taxes, 'b.txt', 'B1');
    const c = await put(year, 'c.txt', 'C');
    const e = await put(taxes, 'e.txt', 'E');
    // All of that two hours ago; e.txt was deleted 90 minutes ago, before the moment we go back to.
    await env.ctx.db.execute(
      sql`UPDATE nodes SET created_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE owner_id = (SELECT owner_id FROM nodes WHERE id = ${taxes})`,
    );
    await mom.del(`/nodes/${e}`);
    await env.ctx.db.execute(
      sql`UPDATE nodes SET deleted_at = now() - interval '90 minutes' WHERE id = ${e}`,
    );
    const at = ago(60);

    // Since then: b.txt saved over twice, a.txt deleted, c.txt deleted and then its folder,
    // and a new file added.
    await put(taxes, 'b.txt', 'B2');
    await put(taxes, 'b.txt', 'B3');
    await mom.del(`/nodes/${a}`);
    await mom.del(`/nodes/${c}`);
    await mom.del(`/nodes/${year}`);
    const d = await put(taxes, 'd.txt', 'D');

    const preview = await mom.get(`/nodes/${taxes}/rewind?at=${encodeURIComponent(at)}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      restore: { count: 3 },
      revert: { count: 1, names: ['b.txt'] },
      added: 1,
    });
    // The newest deletion first: the folder, then what was deleted from it before.
    expect(preview.body.restore.names).toEqual(['2024', 'c.txt', 'a.txt']);

    const done = await mom.post(`/nodes/${taxes}/rewind`, { at });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ restored: 3, reverted: 1, added: 1 });

    expect(await read(b)).toBe('B1');
    expect(await read(a)).toBe('A');
    // c.txt is back inside its folder, not at the top of My Files.
    expect((await parentOf(c)).parentId).toBe(year);
    expect((await parentOf(c)).deletedAt).toBeNull();
    expect((await parentOf(d)).deletedAt).toBeNull();
    // Deleted before that moment: still in the trash.
    expect((await parentOf(e)).deletedAt).not.toBeNull();
    // And it can be undone: what b.txt held until now is a version.
    const versions = (await mom.get(`/nodes/${b}/versions`)).body.items as { size: number }[];
    expect(versions.map((v) => v.size)).toContain(2);
    expect(versions).toHaveLength(2);

    // Doing it again changes nothing.
    expect((await mom.post(`/nodes/${taxes}/rewind`, { at })).body).toEqual({
      restored: 0,
      reverted: 0,
      added: 1,
    });
  });

  it('leaves in the trash what was added and deleted since', async () => {
    const notes = (await mom.post('/folders', { parentId: momRoot, name: 'Notes' })).body.id;
    const kept = await put(notes, 'kept.txt', 'K');
    await env.ctx.db.execute(
      sql`UPDATE nodes SET created_at = now() - interval '2 hours' WHERE id IN (${notes}, ${kept})`,
    );
    const at = ago(60);
    const junk = await put(notes, 'junk.txt', 'J');
    const scratch = (await mom.post('/folders', { parentId: notes, name: 'Scratch' })).body.id;
    await put(scratch, 'draft.txt', 'D');
    await mom.del(`/nodes/${junk}`);
    await mom.del(`/nodes/${scratch}`);
    await mom.del(`/nodes/${kept}`);

    const preview = await mom.get(`/nodes/${notes}/rewind?at=${encodeURIComponent(at)}`);
    expect(preview.body.restore).toEqual({ count: 1, names: ['kept.txt'] });
    expect((await mom.post(`/nodes/${notes}/rewind`, { at })).body.restored).toBe(1);
    expect((await parentOf(kept)).deletedAt).toBeNull();
    expect((await parentOf(junk)).deletedAt).not.toBeNull();
    expect((await parentOf(scratch)).deletedAt).not.toBeNull();
  });

  it('brings back a file that existed then, even inside a folder made since', async () => {
    const trip = (await mom.post('/folders', { parentId: momRoot, name: 'Trip' })).body.id;
    const photo = await put(trip, 'beach.jpg', 'B');
    await env.ctx.db.execute(
      sql`UPDATE nodes SET created_at = now() - interval '2 hours' WHERE id IN (${trip}, ${photo})`,
    );
    const at = ago(60);
    // Since then: a new folder, the photo moved into it, and the new folder deleted.
    const sorted = (await mom.post('/folders', { parentId: trip, name: 'Sorted' })).body.id;
    expect((await mom.patch(`/nodes/${photo}`, { parentId: sorted })).status).toBe(200);
    await mom.del(`/nodes/${sorted}`);

    const preview = await mom.get(`/nodes/${trip}/rewind?at=${encodeURIComponent(at)}`);
    expect(preview.body.restore).toEqual({ count: 1, names: ['Sorted'] });
    await mom.post(`/nodes/${trip}/rewind`, { at });
    // Moves aren't recorded, so it comes back where it was deleted from.
    expect(await parentOf(photo)).toMatchObject({ parentId: sorted, deletedAt: null });
  });

  it('only lets the owner rewind, and only as far back as the trash goes', async () => {
    const shared = (await mom.post('/folders', { parentId: momRoot, name: 'Shared' })).body.id;
    expect(
      (await mom.post(`/nodes/${shared}/shares`, { userId: kidId, permission: 'edit' })).status,
    ).toBe(200);
    const at = ago(5);
    expect((await kid.post(`/nodes/${shared}/rewind`, { at })).status).toBe(403);
    const priv = (await mom.post('/folders', { parentId: momRoot, name: 'Private' })).body.id;
    expect((await kid.post(`/nodes/${priv}/rewind`, { at })).status).toBe(404);
    expect((await kid.get(`/nodes/${priv}/rewind?at=${encodeURIComponent(at)}`)).status).toBe(404);

    expect((await mom.post(`/nodes/${shared}/rewind`, { at: ago(-5) })).status).toBe(400);
    expect((await mom.post(`/nodes/${shared}/rewind`, { at: ago(31 * 24 * 60) })).status).toBe(400);
    const file = await put(momRoot, 'x.txt', 'x');
    expect((await mom.post(`/nodes/${file}/rewind`, { at })).status).toBe(404);
    // My Files itself can be rewound.
    expect((await mom.post(`/nodes/${momRoot}/rewind`, { at })).status).toBe(200);
  });
});
