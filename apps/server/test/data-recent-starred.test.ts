import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

let env: TestEnv;
let mum: Client;
let mumRoot: string;
let son: Awaited<ReturnType<typeof addMember>>;
let sharedFolder: string;
let shareId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  mum = a.client;
  mumRoot = a.me.rootNodeId;
  son = await addMember(env, mum, 'son@example.com');
  sharedFolder = (await mum.post('/folders', { parentId: mumRoot, name: 'Holiday plans' })).body.id;
  const sub = (await mum.post('/folders', { parentId: sharedFolder, name: 'Tickets' })).body.id;
  await uploadFile(mum, mumRoot, 'mum-private-diary.txt', Buffer.from('secret'));
  await uploadFile(mum, sub, 'flight-tickets.pdf', Buffer.from('tickets'));
  shareId = (
    await mum.post(`/nodes/${sharedFolder}/shares`, { userId: son.me.id, permission: 'view' })
  ).body.id;
  await uploadFile(son.client, son.me.rootNodeId, 'homework.docx', Buffer.from('essay'));
});
afterAll(async () => {
  await env.close();
});

const names = (res: { body: { items: { name: string }[] } }) => res.body.items.map((i) => i.name);

describe('recent', () => {
  it("shows your files and what's shared with you, newest first, never others' private files", async () => {
    const recent = await son.client.get('/recent');
    expect(recent.status).toBe(200);
    expect(names(recent)).toEqual(['homework.docx', 'flight-tickets.pdf']);
    const own = await mum.get('/recent');
    expect(names(own)).toContain('mum-private-diary.txt');
    expect(names(own)).not.toContain('homework.docx');
  });

  it('leaves out the trash', async () => {
    const doc = (await uploadFile(son.client, son.me.rootNodeId, 'draft.txt', Buffer.from('x')))
      .final!.body.node;
    expect(names(await son.client.get('/recent'))[0]).toBe('draft.txt');
    await son.client.del(`/nodes/${doc.id}`);
    expect(names(await son.client.get('/recent'))).not.toContain('draft.txt');
  });
});

describe('search', () => {
  it('finds files shared with you too, but not other people’s private ones', async () => {
    expect(names(await son.client.get('/search?q=tickets'))).toEqual(
      expect.arrayContaining(['Tickets', 'flight-tickets.pdf']),
    );
    expect(names(await son.client.get('/search?q=diary'))).toEqual([]);
    expect(names(await mum.get('/search?q=homework'))).toEqual([]);
  });
});

describe('starred', () => {
  it('stars what you can see, and a star never outlives the share', async () => {
    const mine = (await son.client.get(`/nodes/${son.me.rootNodeId}/children`)).body.items[0];
    expect((await son.client.req('PUT', `/nodes/${mine.id}/star`)).status).toBe(200);
    expect((await son.client.req('PUT', `/nodes/${sharedFolder}/star`)).status).toBe(200);
    // Starring twice is fine.
    expect((await son.client.req('PUT', `/nodes/${sharedFolder}/star`)).status).toBe(200);
    expect(names(await son.client.get('/starred'))).toEqual(['Holiday plans', mine.name]);

    // Something you can't see can't be starred, and nothing leaks.
    const diary = (await mum.get('/search?q=diary')).body.items[0];
    expect((await son.client.req('PUT', `/nodes/${diary.id}/star`)).status).toBe(404);

    await mum.del(`/shares/${shareId}`);
    expect(names(await son.client.get('/starred'))).toEqual([mine.name]);

    expect((await son.client.del(`/nodes/${mine.id}/star`)).status).toBe(200);
    expect(names(await son.client.get('/starred'))).toEqual([]);
    // Other people's stars are their own.
    expect(names(await mum.get('/starred'))).toEqual([]);
  });
});
