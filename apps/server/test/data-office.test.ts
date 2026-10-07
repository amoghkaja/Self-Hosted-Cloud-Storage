import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { blobs, nodes } from '../src/db/schema';
import { makeOfficePreview, runSoffice } from '../src/jobs/office';
import {
  addMember,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

const hasSoffice = (() => {
  try {
    execFileSync(process.env.SOFFICE_BIN ?? 'soffice', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let env: TestEnv;
let c: Client;
let root: string;

const RTF = Buffer.from('{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs28 Trip packing list\\par}');

async function upload(name: string, data: Buffer, mimeType: string) {
  const node = (await uploadFile(c, root, name, data, { mimeType })).final!.body.node;
  const [row] = await env.ctx.db
    .select({ blobId: nodes.blobId })
    .from(nodes)
    .where(eq(nodes.id, node.id));
  return { node, blobId: row!.blobId! };
}

const blobRow = async (blobId: string) =>
  (await env.ctx.db.select().from(blobs).where(eq(blobs.id, blobId)))[0]!;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  c = a.client;
  root = a.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

describe('office previews', () => {
  it('queues a preview for Office documents only, and says when it is not ready', async () => {
    const { node, blobId } = await upload('packing.rtf', RTF, 'application/rtf');
    expect((await blobRow(blobId)).previewStatus).toBe('pending');
    expect(env.jobs.take('office-preview')).toEqual([
      expect.objectContaining({ data: { blobId } }),
    ]);
    const res = await c.get(`/nodes/${node.id}/preview`);
    expect(res.status).toBe(404);
    expect(res.headers['x-preview-status']).toBe('pending');

    const photo = await upload('notes.txt', Buffer.from('hello'), 'text/plain');
    expect((await blobRow(photo.blobId)).previewStatus).toBe('none');
    expect(env.jobs.take('office-preview')).toHaveLength(0);
  });

  it('also queues a preview for documents saved from the network drive', async () => {
    const created = await c.post('/auth/app-passwords', { name: 'Laptop', password: c.password });
    const auth = `Basic ${Buffer.from(`${created.body.username}:${created.body.password}`).toString('base64')}`;
    const put = await env.app.inject({
      method: 'PUT',
      url: '/dav/My%20Files/minutes.rtf',
      headers: { authorization: auth, 'content-type': 'application/rtf' },
      payload: RTF,
    });
    expect(put.statusCode).toBe(201);
    const [row] = await env.ctx.db
      .select({ blobId: nodes.blobId })
      .from(nodes)
      .where(eq(nodes.name, 'minutes.rtf'));
    expect((await blobRow(row!.blobId!)).previewStatus).toBe('pending');
    expect(env.jobs.take('office-preview')).toEqual([
      expect.objectContaining({ data: { blobId: row!.blobId } }),
    ]);
  });

  it('a second run of the same job does nothing (the hourly recovery may queue it again)', async () => {
    const { blobId } = await upload('twice.rtf', RTF, 'application/rtf');
    await env.ctx.db.update(blobs).set({ previewStatus: 'ready' }).where(eq(blobs.id, blobId));
    await makeOfficePreview(env.ctx, blobId);
    expect((await blobRow(blobId)).previewStatus).toBe('ready');
  });

  it('hides previews of files the user cannot see', async () => {
    const { node } = await upload('private.rtf', RTF, 'application/rtf');
    const other = await addMember(env, c, 'cousin@example.com');
    expect((await other.client.get(`/nodes/${node.id}/preview`)).status).toBe(404);
  });

  it.skipIf(hasSoffice)('marks the preview failed when LibreOffice is missing', async () => {
    const { node, blobId } = await upload('report.rtf', RTF, 'application/rtf');
    await makeOfficePreview(env.ctx, blobId);
    const row = await blobRow(blobId);
    expect(row.previewStatus).toBe('failed');
    expect(row.thumbStatus).toBe('unsupported');
    const res = await c.get(`/nodes/${node.id}/preview`);
    expect(res.headers['x-preview-status']).toBe('failed');
  });

  it.skipIf(!hasSoffice)('renders a document to PDF and thumbnails it', async () => {
    const { node, blobId } = await upload('letter.rtf', RTF, 'application/rtf');
    await makeOfficePreview(env.ctx, blobId);
    expect((await blobRow(blobId)).previewStatus).toBe('ready');
    expect(env.jobs.take('thumbnail')).toEqual(
      expect.arrayContaining([expect.objectContaining({ data: { blobId } })]),
    );
    const res = await c.get(`/nodes/${node.id}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(res.raw.rawPayload).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it.skipIf(!hasSoffice)('stops all of LibreOffice when a document takes too long', async () => {
    const work = await mkdtemp(path.join(env.dataDir, 'slow-'));
    const input = path.join(work, 'huge.csv');
    await writeFile(
      input,
      Array.from({ length: 400_000 }, (_, i) => `${i},row ${i},some words,${i * 7}\n`).join(''),
    );
    const args = [
      '--headless',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=file://${path.join(work, 'profile')}`,
      '--convert-to',
      'pdf',
      '--outdir',
      work,
      input,
    ];
    await expect(runSoffice(args, 1500)).rejects.toThrow();
    // The converter is a child of LibreOffice's launcher: it must not go on running on its own.
    const running = () => {
      try {
        return execFileSync('pgrep', ['-f', work]).toString().trim();
      } catch {
        return '';
      }
    };
    await vi.waitFor(() => expect(running()).toBe(''), { timeout: 3000 });
  });
});

describe.skipIf(!hasSoffice)('spreadsheet previews', () => {
  it('renders a spreadsheet to HTML sheets, served only as an attachment', async () => {
    const csv = Buffer.from('Trip,Cost\nGoa,46000\nमुंबई,1200\n');
    const { node, blobId } = await upload('trips.csv', csv, 'text/csv');
    await makeOfficePreview(env.ctx, blobId);
    expect((await blobRow(blobId)).previewStatus).toBe('ready');
    const res = await c.get(`/nodes/${node.id}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    const html = Buffer.from(res.raw.rawPayload).toString();
    expect(html).toContain('<table');
    expect(html).toContain('मुंबई');
  });
});
