import { createServer, type Server } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, blobs, nodes } from '../src/db/schema';
import { queuePendingScans, scanBlob } from '../src/jobs/scan';
import { clamdVersion, scanFile } from '../src/lib/clamav';
import {
  addMember,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

/** The harmless string every scanner agrees to call a virus. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** A stand-in clamd: speaks VERSION and INSTREAM, and "finds" EICAR. */
function fakeClamd(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let body: Buffer | null = null;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!body) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        const command = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 1);
        if (command === 'zVERSION') return socket.end('ClamAV 1.4.2/27700/Thu Oct  1 2026\0');
        body = Buffer.alloc(0);
      }
      for (;;) {
        if (buf.length < 4) return;
        const size = buf.readUInt32BE(0);
        if (size === 0) {
          const hit = body.toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
          return socket.end(hit ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
        }
        if (buf.length < 4 + size) return;
        body = Buffer.concat([body, buf.subarray(4, 4 + size)]);
        buf = buf.subarray(4 + size);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    ),
  );
}

let env: TestEnv;
let admin: Client;
let root: string;
let clamd: { server: Server; port: number };

const blobOf = async (nodeId: string) =>
  (await env.ctx.db.select({ id: nodes.blobId }).from(nodes).where(eq(nodes.id, nodeId)))[0]!.id!;
const scanJobs = () => env.jobs.take('scan').map((j) => (j.data as { blobId: string }).blobId);

beforeAll(async () => {
  clamd = await fakeClamd();
  env = await createTestEnv({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port) });
  const a = await setupAdmin(env);
  admin = a.client;
  root = a.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
  clamd.server.close();
});

describe('virus scanning', () => {
  it('talks to clamd: version, clean and infected', async () => {
    const c = env.ctx.config.clamav!;
    expect(await clamdVersion(c)).toMatch(/^ClamAV 1\.4\.2/);
    const clean = (await uploadFile(admin, root, 'notes.txt', Buffer.from('hello'))).final!.body
      .node;
    expect(scanJobs()).toEqual([await blobOf(clean.id)]);
    const blob = (
      await env.ctx.db
        .select()
        .from(blobs)
        .where(eq(blobs.id, await blobOf(clean.id)))
    )[0]!;
    expect(await scanFile(c, await env.ctx.volumes.blobFile(blob))).toEqual({ status: 'clean' });
  });

  it('blocks an infected file everywhere, marks it, and tells the admin', async () => {
    const folder = (await admin.post('/folders', { parentId: root, name: 'Inbox' })).body.id;
    const bad = (await uploadFile(admin, folder, 'invoice.pdf', Buffer.from(EICAR))).final!.body
      .node;
    const good = (await uploadFile(admin, folder, 'photo.txt', Buffer.from('fine'))).final!.body
      .node;
    // Until the scan has run, it downloads like any other file.
    expect((await admin.get(`/nodes/${bad.id}/content`)).status).toBe(200);
    for (const id of scanJobs()) await scanBlob(env.ctx, id);

    const blocked = await admin.get(`/nodes/${bad.id}/content`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('FILE_INFECTED');
    expect((await admin.get(`/nodes/${good.id}/content`)).status).toBe(200);

    const listed = (await admin.get(`/nodes/${folder}/children`)).body.items;
    expect(listed.find((n: { id: string }) => n.id === bad.id).infected).toBe(true);
    expect(listed.find((n: { id: string }) => n.id === good.id).infected).toBeUndefined();

    // A zip of the folder leaves it out; a public link to it is refused too.
    const zip = await admin.get(`/zip?ids=${folder}`);
    expect(zip.status).toBe(200);
    expect(zip.raw.rawPayload.includes(Buffer.from('EICAR'))).toBe(false);
    expect(zip.raw.rawPayload.includes(Buffer.from('fine'))).toBe(true);
    const link = (await admin.post(`/nodes/${bad.id}/links`, { kind: 'view' })).body;
    const token = link.url.split('/s/')[1];
    expect((await admin.get(`/public/links/${token}/content/${bad.id}`)).status).toBe(403);

    const status = (await admin.get('/admin/scanner')).body;
    expect(status).toMatchObject({ installed: true, enabled: true, reachable: true });
    expect(status.infected).toEqual([
      { name: 'invoice.pdf', owner: expect.any(String), signature: 'Eicar-Signature' },
    ]);
    const log = await env.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'scan.infected'));
    expect(log).toHaveLength(1);

    const member = (await addMember(env, admin, 'kid@example.com')).client;
    expect((await member.get('/admin/scanner')).status).toBe(403);
  });

  it('does nothing while switched off, then catches up when switched on', async () => {
    await admin.patch('/admin/settings', { virusScan: false });
    const f = (await uploadFile(admin, root, 'later.txt', Buffer.from(`${EICAR} again`))).final!
      .body.node;
    const blobId = await blobOf(f.id);
    scanJobs();
    await scanBlob(env.ctx, blobId);
    expect((await admin.get(`/nodes/${f.id}/content`)).status).toBe(200);
    await queuePendingScans(env.ctx);
    expect(scanJobs()).toEqual([]);

    await admin.patch('/admin/settings', { virusScan: true });
    await env.ctx.db
      .update(blobs)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(blobs.id, blobId));
    await queuePendingScans(env.ctx);
    const queued = scanJobs();
    expect(queued).toContain(blobId);
    for (const id of queued) await scanBlob(env.ctx, id);
    expect((await admin.get(`/nodes/${f.id}/content`)).status).toBe(403);
  });

  it('leaves files waiting when the scanner is down, instead of calling them clean', async () => {
    const down = await createTestEnv({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' });
    try {
      const a = await setupAdmin(down);
      const f = (await uploadFile(a.client, a.me.rootNodeId, 'x.txt', Buffer.from('x'))).final!.body
        .node;
      const [n] = await down.ctx.db
        .select({ id: nodes.blobId })
        .from(nodes)
        .where(eq(nodes.id, f.id));
      await expect(scanBlob(down.ctx, n!.id!)).rejects.toThrow();
      const [b] = await down.ctx.db.select().from(blobs).where(eq(blobs.id, n!.id!));
      expect(b!.scanStatus).toBe('pending');
      expect((await a.client.get('/admin/scanner')).body).toMatchObject({
        installed: true,
        reachable: false,
      });
    } finally {
      await down.close();
    }
  });
});
