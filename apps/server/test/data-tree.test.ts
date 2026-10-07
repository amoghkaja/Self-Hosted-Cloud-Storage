import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockWriteAccess } from '../src/modules/files/access';
import { insertNode, moveNode, trashSubtree } from '../src/modules/files/tree';
import {
  addMember,
  bytes,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let c: Client;
let root: string;
let userId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  c = a.client;
  root = a.me.rootNodeId;
  userId = a.me.id;
});
afterAll(async () => {
  await env.close();
});

const folder = async (parentId: string, name: string) =>
  (await c.post('/folders', { parentId, name })).body.id as string;

describe('trash', () => {
  it('deleting a folder forever keeps items that were trashed separately before it', async () => {
    const album = await folder(root, 'Album');
    const keep = (await uploadFile(c, album, 'keep.jpg', bytes(300, 1))).final!.body.node.id;
    await uploadFile(c, album, 'other.jpg', bytes(100, 2));
    const before = (await c.get('/auth/me')).body.usedBytes;

    expect((await c.del(`/nodes/${keep}`)).status).toBe(200); // trashed on its own first
    expect((await c.del(`/nodes/${album}`)).status).toBe(200);
    expect((await c.del(`/trash/${album}`)).status).toBe(200);

    // Only the folder's own contents are gone (and uncounted); keep.jpg is still in the trash.
    expect((await c.get('/auth/me')).body.usedBytes).toBe(before - 100);
    const trash = await c.get('/trash');
    expect(trash.body.items.map((i: { id: string }) => i.id)).toContain(keep);
    const restored = await c.post(`/trash/${keep}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.node.parentId).toBe(root);
    const dl = await c.get(`/nodes/${keep}/content`);
    expect(Buffer.compare(dl.raw.rawPayload, bytes(300, 1))).toBe(0);
  });

  it('an item committed into a folder while it is being trashed goes to the trash with it', async () => {
    const target = await folder(root, 'Racing');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => {
      locked = r;
    });
    // An upload's commit: holds the folder (lockWriteAccess), adds its item, commits.
    const commit = env.ctx.db.transaction(async (tx) => {
      await lockWriteAccess(tx, userId, target);
      locked();
      await held;
      return insertNode(
        tx,
        { ownerId: userId, parentId: target, type: 'folder', name: 'late', createdBy: userId },
        'fail',
      );
    });
    await lockTaken;
    const trash = trashSubtree(env.ctx.db, target);
    await new Promise((r) => setTimeout(r, 100)); // the trash is now waiting on the folder
    release();
    const late = await commit;
    await trash;

    const [row] = (await env.ctx.db.execute(
      sql`select deleted_at IS NOT NULL AS deleted, trash_root_id AS "trashRootId" from nodes where id = ${late.id}`,
    )) as unknown as { deleted: boolean; trashRootId: string | null }[];
    expect(row).toEqual({ deleted: true, trashRootId: target });
  });

  /** Trashes a folder in a transaction that stays open until `commit()`. */
  async function trashUncommitted(folderId: string) {
    let commit!: () => void;
    const held = new Promise<void>((r) => {
      commit = r;
    });
    let ran!: () => void;
    const trashRan = new Promise<void>((r) => {
      ran = r;
    });
    const done = env.ctx.db.transaction(async (tx) => {
      await trashSubtree(tx, folderId);
      ran();
      await held;
    });
    await trashRan;
    return { commit, done };
  }

  it('restoring into a folder while it is being trashed puts the item in My Files', async () => {
    const kitchen = await folder(root, 'Kitchen');
    const recipe = (await uploadFile(c, kitchen, 'recipe.txt', Buffer.from('dal'))).final!.body.node
      .id;
    expect((await c.del(`/nodes/${recipe}`)).status).toBe(200);
    const trash = await trashUncommitted(kitchen);
    const restore = c.post(`/trash/${recipe}/restore`);
    await new Promise((r) => setTimeout(r, 100)); // the restore is now waiting on the folder
    trash.commit();
    await trash.done;

    const res = await restore;
    expect(res.status).toBe(200);
    // Not left live inside the trashed folder, where nobody would see it.
    expect(res.body.node.parentId).toBe(root);
  });

  it('a folder made in a folder while it is being trashed is refused', async () => {
    const trip = await folder(root, 'Trip');
    const trash = await trashUncommitted(trip);
    const create = c.post('/folders', { parentId: trip, name: 'Day 1' });
    await new Promise((r) => setTimeout(r, 100)); // the new folder is now waiting on its parent
    trash.commit();
    await trash.done;

    expect((await create).status).toBe(409);
    const live = (await env.ctx.db.execute(
      sql`select id from nodes where parent_id = ${trip} and deleted_at is null`,
    )) as unknown as unknown[];
    expect(live).toHaveLength(0);
  });
});

describe('moves', () => {
  it('a file moved out of a folder while it is being trashed stays where it went', async () => {
    const old = await folder(root, 'Old stuff');
    const keep = await folder(root, 'Keep');
    const doc = (await uploadFile(c, old, 'passport.pdf', Buffer.from('p'))).final!.body.node.id;
    let commit!: () => void;
    const held = new Promise<void>((r) => {
      commit = r;
    });
    let ran!: () => void;
    const moveRan = new Promise<void>((r) => {
      ran = r;
    });
    // The move has run but not committed yet.
    const move = env.ctx.db.transaction(async (tx) => {
      await moveNode(tx, { id: doc, ownerId: userId, parentId: old }, { parentId: keep });
      ran();
      await held;
    });
    await moveRan;
    const trash = trashSubtree(env.ctx.db, old);
    await new Promise((r) => setTimeout(r, 100)); // the trash is now waiting on the move
    commit();
    await move;
    await trash;

    // Not trashed along with the folder it left (where no trash entry would ever show it).
    const [row] = (await env.ctx.db.execute(
      sql`select deleted_at IS NOT NULL AS deleted, parent_id AS "parentId" from nodes where id = ${doc}`,
    )) as unknown as { deleted: boolean; parentId: string }[];
    expect(row).toEqual({ deleted: false, parentId: keep });
  });

  it('two opposite moves at once cannot detach folders into a cycle', async () => {
    for (let i = 0; i < 8; i++) {
      const a = await folder(root, `A${i}`);
      const b = await folder(root, `B${i}`);
      const results = await Promise.all([
        c.patch(`/nodes/${a}`, { parentId: b }),
        c.patch(`/nodes/${b}`, { parentId: a }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      for (const id of [a, b]) {
        const detail = await c.get(`/nodes/${id}`);
        expect(detail.status).toBe(200);
        expect(detail.body.breadcrumbs[0].id).toBe(root);
      }
    }
  });
});

describe('listing order', () => {
  it('sorts names naturally and case-insensitively, across page boundaries', async () => {
    const dir = await folder(root, 'Photos');
    for (const name of ['IMG_10', 'img_2', 'IMG_1', 'Img_100', 'IMG_9']) await folder(dir, name);
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&cursor=${cursor}` : '';
      const page = await c.get(`/nodes/${dir}/children?limit=2${q}`);
      names.push(...page.body.items.map((i: { name: string }) => i.name));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(names).toEqual(['IMG_1', 'img_2', 'IMG_9', 'IMG_10', 'Img_100']);

    const desc = await c.get(`/nodes/${dir}/children?dir=desc`);
    expect(desc.body.items.map((i: { name: string }) => i.name)).toEqual(names.toReversed());
  });

  it('pages by size and date, and refuses a cursor that does not fit the sort', async () => {
    const dir = await folder(root, 'Paged');
    for (const [i, n] of ['a', 'b', 'c'].entries()) {
      await uploadFile(c, dir, `${n}.txt`, Buffer.alloc(i + 1));
    }
    for (const sort of ['size', 'updated']) {
      const names: string[] = [];
      let cursor: string | null = null;
      do {
        const q: string = cursor ? `&cursor=${cursor}` : '';
        const page = await c.get(`/nodes/${dir}/children?limit=1&sort=${sort}${q}`);
        expect(page.status).toBe(200);
        names.push(...page.body.items.map((i: { name: string }) => i.name));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(names.toSorted()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    }

    const byName = (await c.get(`/nodes/${dir}/children?limit=1`)).body.nextCursor;
    const forge = (parts: unknown[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
    const cases: [string, string][] = [
      ['size', byName],
      ['updated', byName],
      ['name', forge(['file', 'a.txt', 'not-an-id'])],
      ['name', forge(['file', 'a\u0000', dir])],
      ['updated', forge(['file', '2026-13-01T00:00:00.000Z', dir])],
      ['size', forge(['file', 1.5, dir])],
    ];
    for (const [sort, cursor] of cases) {
      const res = await c.get(`/nodes/${dir}/children?limit=1&sort=${sort}&cursor=${cursor}`);
      expect(res.status).toBe(400);
    }
  });
});

describe('names Postgres lowercases differently from JavaScript', () => {
  // lower() gives "διακοπεσ" and "izmir"; toLowerCase() gives "διακοπες" (final sigma) and "i̇zmir".
  it('still finds a free name, and sees the name is taken', async () => {
    const dir = await folder(root, 'Ταξίδια');
    const trip = await folder(dir, 'ΔΙΑΚΟΠΕΣ');
    const again = await c.post('/folders', {
      parentId: dir,
      name: 'ΔΙΑΚΟΠΕΣ',
      renameIfTaken: true,
    });
    expect(again.status).toBe(200);
    expect(again.body.name).toBe('ΔΙΑΚΟΠΕΣ (1)');
    const copy = await c.post(`/nodes/${trip}/copy`, { parentId: dir });
    expect(copy.status).toBe(200);
    expect(copy.body.name).toBe('ΔΙΑΚΟΠΕΣ (copy)');

    await uploadFile(c, dir, 'İzmir.jpg', Buffer.from('1'));
    const check = await c.post(`/nodes/${dir}/name-check`, { names: ['İzmir.jpg', 'ΔΙΑΚΟΠΕΣ'] });
    expect(check.body).toMatchObject({ files: ['İzmir.jpg'], folders: ['ΔΙΑΚΟΠΕΣ'] });
    const second = await uploadFile(c, dir, 'İzmir.jpg', Buffer.from('2'));
    expect(second.final!.status).toBe(200);
    expect(second.final!.body.node.name).toBe('İzmir (1).jpg');

    // Restoring next to a newer item of the same name.
    await c.del(`/nodes/${trip}`);
    await folder(dir, 'ΔΙΑΚΟΠΕΣ');
    const restored = await c.post(`/trash/${trip}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.node.name).toBe('ΔΙΑΚΟΠΕΣ (restored)');
  });
});

describe('changes through a share', () => {
  it('re-checks the edit share under lock, so a revoke that lands first stops them', async () => {
    const cousin = await addMember(env, c, 'cousin-tree@example.com');
    const shared = await folder(root, 'Shared recipes');
    const doc = (await uploadFile(c, shared, 'dal.txt', Buffer.from('dal'))).final!.body.node;
    const grant = await c.post(`/nodes/${shared}/shares`, {
      userId: cousin.me.id,
      permission: 'edit',
    });
    const node = { id: doc.id, ownerId: userId, parentId: shared };

    // With the share, the change goes through.
    const renamed = await moveNode(
      env.ctx.db,
      node,
      { name: 'dal (mum).txt' },
      {
        actorId: cousin.me.id,
      },
    );
    expect(renamed.name).toBe('dal (mum).txt');

    // The route already checked access, then the owner revokes before the write commits.
    await c.del(`/shares/${grant.body.id}`);
    await expect(
      moveNode(env.ctx.db, node, { name: 'mine now.txt' }, { actorId: cousin.me.id }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(trashSubtree(env.ctx.db, doc.id, { actorId: cousin.me.id })).rejects.toMatchObject(
      { status: 403 },
    );
    const still = await c.get(`/nodes/${doc.id}`);
    expect(still.body.node.name).toBe('dal (mum).txt');

    // The owner themself isn't affected by the check.
    await trashSubtree(env.ctx.db, doc.id, { actorId: userId });
    expect((await c.get(`/nodes/${doc.id}`)).status).toBe(404);
  });

  it('does not follow an item the owner moved somewhere private meanwhile', async () => {
    const cousin = await addMember(env, c, 'cousin-moved@example.com');
    const shared = await folder(root, 'Shared plans');
    const inbox = await folder(shared, 'Inbox');
    const priv = await folder(root, 'Private plans');
    const doc = (await uploadFile(c, shared, 'plan.txt', Buffer.from('p'))).final!.body.node;
    await c.post(`/nodes/${shared}/shares`, { userId: cousin.me.id, permission: 'edit' });
    // Where the cousin's request saw it, before the owner moved it into a private folder.
    const seen = { id: doc.id, ownerId: userId, parentId: shared };
    expect((await c.patch(`/nodes/${doc.id}`, { parentId: priv })).status).toBe(200);

    const as = { actorId: cousin.me.id };
    await expect(moveNode(env.ctx.db, seen, { parentId: inbox }, as)).rejects.toMatchObject({
      status: 404,
    });
    await expect(moveNode(env.ctx.db, seen, { name: 'mine.txt' }, as)).rejects.toMatchObject({
      status: 404,
    });
    expect((await c.get(`/nodes/${doc.id}`)).body.node).toMatchObject({
      parentId: priv,
      name: 'plan.txt',
    });
    expect((await cousin.client.get(`/nodes/${doc.id}`)).status).toBe(404);
  });
});
