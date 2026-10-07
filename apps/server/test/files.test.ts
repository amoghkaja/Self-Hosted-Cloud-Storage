import type { NodePage } from '@familycloud/shared/all';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredTrash } from '../src/jobs/maintenance';
import {
  bytes,
  type Client,
  createTestEnv,
  type Res,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let c: Client;
let root: string;

beforeAll(async () => {
  env = await createTestEnv();
  const admin = await setupAdmin(env);
  c = admin.client;
  root = admin.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

async function folder(parentId: string, name: string) {
  const res = await c.post('/folders', { parentId, name });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

describe('folders', () => {
  it('creates, rejects duplicates case-insensitively and can reuse existing', async () => {
    const id = await folder(root, 'Photos');
    const dup = await c.post('/folders', { parentId: root, name: 'photos' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('NAME_CONFLICT');
    const reuse = await c.post('/folders', { parentId: root, name: 'Photos', reuseExisting: true });
    expect(reuse.body.id).toBe(id);
  });

  it('validates names', async () => {
    for (const name of ['', '..', 'a/b', 'bad\u0000name', 'bad￿name']) {
      expect((await c.post('/folders', { parentId: root, name })).status).toBe(400);
    }
  });

  it('paginates folders first, then by name, with a stable cursor', async () => {
    const parent = await folder(root, 'Paging');
    for (let i = 0; i < 12; i++) await folder(parent, `f${String(i).padStart(2, '0')}`);
    for (let i = 0; i < 5; i++)
      await uploadFile(c, parent, `a-file-${i}.txt`, Buffer.from(`hello ${i}`));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Res<NodePage> = await c.get<NodePage>(
        `/nodes/${parent}/children?limit=5${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((n) => n.name));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(17);
    expect(seen.slice(0, 12)).toEqual(
      Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`),
    );
    expect(seen.slice(12)).toEqual([
      'a-file-0.txt',
      'a-file-1.txt',
      'a-file-2.txt',
      'a-file-3.txt',
      'a-file-4.txt',
    ]);

    const bySizeDesc = await c.get(`/nodes/${parent}/children?sort=size&dir=desc&limit=100`);
    expect(bySizeDesc.body.items[0].type).toBe('folder');
  });

  it('breadcrumbs show the path from My Files', async () => {
    const a = await folder(root, 'A');
    const b = await folder(a, 'B');
    const detail = await c.get(`/nodes/${b}`);
    expect(detail.body.breadcrumbs.map((x: { name: string }) => x.name)).toEqual([
      'My Files',
      'A',
      'B',
    ]);
    expect(detail.body.access).toBe('owner');
  });
});

describe('rename and move', () => {
  it('renames, moves and refuses cycles', async () => {
    const x = await folder(root, 'X');
    const y = await folder(x, 'Y');
    expect((await c.patch(`/nodes/${y}`, { name: 'Y2' })).body.name).toBe('Y2');
    const cycle = await c.patch(`/nodes/${x}`, { parentId: y });
    expect(cycle.status).toBe(400);
    expect(cycle.body.code).toBe('INVALID_MOVE');
    expect((await c.patch(`/nodes/${y}`, { parentId: root })).body.parentId).toBe(root);
  });

  it('protects the root folder', async () => {
    expect((await c.patch(`/nodes/${root}`, { name: 'Nope' })).status).toBe(403);
    expect((await c.del(`/nodes/${root}`)).status).toBe(403);
  });
});

describe('trash', () => {
  it('trashes a folder tree as one unit, restores it, and purges to free quota', async () => {
    const t = await folder(root, 'Trashable');
    const inner = await folder(t, 'Inner');
    await uploadFile(c, inner, 'data.bin', bytes(5000));
    const usedBefore = (await c.get('/auth/me')).body.usedBytes;

    expect((await c.del(`/nodes/${t}`)).status).toBe(200);
    expect((await c.get(`/nodes/${inner}`)).status).toBe(404);
    const trash = await c.get('/trash');
    const item = trash.body.items.find((i: { id: string }) => i.id === t);
    expect(item).toMatchObject({ type: 'folder', size: 5000 });
    expect(trash.body.items.some((i: { id: string }) => i.id === inner)).toBe(false);

    // A new folder with the same name must not block restore.
    await folder(root, 'Trashable');
    const restored = await c.post(`/trash/${t}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.node.name).toBe('Trashable (restored)');
    expect((await c.get(`/nodes/${inner}`)).status).toBe(200);

    await c.del(`/nodes/${t}`);
    expect((await c.del(`/trash/${t}`)).status).toBe(200);
    expect((await c.get('/auth/me')).body.usedBytes).toBe(usedBefore - 5000);
  });

  it('auto-purges items older than the retention window', async () => {
    const f = await folder(root, 'Old');
    await c.del(`/nodes/${f}`);
    await env.ctx.db.execute(
      (await import('drizzle-orm'))
        .sql`update nodes set deleted_at = now() - interval '40 days' where trash_root_id = ${f}`,
    );
    await purgeExpiredTrash(env.ctx);
    expect((await c.get('/trash')).body.items.some((i: { id: string }) => i.id === f)).toBe(false);
  });
});

describe('search', () => {
  it('finds my files by partial name and escapes wildcards', async () => {
    await uploadFile(c, root, 'Vacation 2024 beach.jpg', Buffer.from('x'));
    const res = await c.get('/search?q=beach');
    expect(res.body.items.map((n: { name: string }) => n.name)).toContain(
      'Vacation 2024 beach.jpg',
    );
    const wild = await c.get('/search?q=%25');
    expect(wild.body.items).toHaveLength(0);
  });
});
