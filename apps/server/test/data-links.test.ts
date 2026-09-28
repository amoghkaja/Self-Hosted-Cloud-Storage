import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestEnv, setupAdmin, type TestEnv, uploadFile } from './helpers';

let env: TestEnv;
let owner: Client;
let folder: string;
let doc: string;
let text: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  owner = a.client;
  folder = (await owner.post('/folders', { parentId: a.me.rootNodeId, name: 'Shared' })).body.id;
  doc = (await uploadFile(owner, folder, 'report.docx', Buffer.from('PK docx'))).final!.body.node
    .id;
  text = (await uploadFile(owner, folder, 'notes.txt', Buffer.from('hello'))).final!.body.node.id;
});
afterAll(async () => {
  await env.close();
});

const tokenOf = (url: string) => url.split('/s/')[1]!;

describe('view-only links', () => {
  it('?inline=1 cannot be used to download a file that has no preview', async () => {
    const link = await owner.post(`/nodes/${folder}/links`, { allowDownload: false });
    const token = tokenOf(link.body.url);
    const guest = new Client(env.app);
    // A .docx can't be shown inline, so "inline" would have been served as an attachment.
    const res = await guest.get(`/public/links/${token}/content/${doc}?inline=1`);
    expect(res.status).toBe(403);
    expect((await guest.get(`/public/links/${token}/content/${text}?inline=1`)).status).toBe(200);
  });
});

describe('link management', () => {
  it('links whose token no longer decrypts (SECRET_KEY rotated) can still be listed and revoked', async () => {
    const link = await owner.post(`/nodes/${folder}/links`, {});
    await env.ctx.db.execute(
      sql`update share_links set token_enc = 'written-with-an-old-key' where id = ${link.body.id}`,
    );
    const list = await owner.get(`/nodes/${folder}/links`);
    expect(list.status).toBe(200);
    const listed = list.body.items.find((l: { id: string }) => l.id === link.body.id);
    expect(listed).toMatchObject({ id: link.body.id, url: null });
    expect((await owner.del(`/links/${link.body.id}`)).status).toBe(200);
    const after = await owner.get(`/nodes/${folder}/links`);
    expect(after.body.items.some((l: { id: string }) => l.id === link.body.id)).toBe(false);
  });
});
