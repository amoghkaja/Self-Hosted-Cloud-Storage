import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, blobTexts, nodes } from '../src/db/schema';
import { recoverPendingWork } from '../src/jobs/maintenance';
import { extractText, textSource, tidyText } from '../src/jobs/text';
import { wordQuery } from '../src/lib/search';
import {
  addMember,
  type Client,
  createTestEnv,
  setupAdmin,
  type TestEnv,
  uploadFile,
} from './helpers';

const hasPdftotext = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let env: TestEnv;
let mom: Client;
let kid: Client;
let momRoot: string;
let kidRoot: string;
let momId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  mom = a.client;
  momRoot = a.me.rootNodeId;
  momId = a.me.id;
  const k = await addMember(env, mom, 'kid@example.com');
  kid = k.client;
  kidRoot = k.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

async function blobOf(nodeId: string) {
  const [row] = await env.ctx.db
    .select({ blob: blobs })
    .from(nodes)
    .innerJoin(blobs, eq(blobs.id, nodes.blobId))
    .where(eq(nodes.id, nodeId));
  return row!.blob;
}

/** Uploads a file and reads its words, as the worker would. */
async function add(c: Client, parentId: string, name: string, data: Buffer, mimeType?: string) {
  const node = (await uploadFile(c, parentId, name, data, mimeType ? { mimeType } : {})).final!.body
    .node;
  for (const j of env.jobs.take('extract-text')) {
    await extractText(env.ctx, (j.data as { blobId: string }).blobId);
  }
  return node as { id: string };
}

const search = async (c: Client, q: string) =>
  (await c.get(`/search?q=${encodeURIComponent(q)}`)).body.items as {
    id: string;
    name: string;
    snippet?: string;
  }[];

/** A one-page PDF with a line of text, small enough to write by hand. */
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('search inside files', () => {
  it('turns what was typed into a safe query of word beginnings', () => {
    expect(wordQuery('Tax 2024')).toBe("'tax':* & '2024':*");
    expect(wordQuery("o'brien & | ! :* (x)")).toBe("'o':* & 'brien':* & 'x':*");
    expect(wordQuery('Steuererklärung')).toBe("'steuererklärung':*");
    expect(wordQuery('a')).toBeNull();
    expect(wordQuery('!!')).toBeNull();
    expect(textSource('application/pdf', 'a.pdf')).toBe('pdf');
    expect(textSource('text/plain', 'notes.md')).toBe('plain');
    expect(textSource('text/csv', 'bank.csv')).toBe('plain');
    expect(
      textSource(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'cv.docx',
      ),
    ).toBe('office');
    expect(textSource('image/jpeg', 'a.jpg')).toBeNull();
    expect(textSource('application/zip', 'a.zip')).toBeNull();
    expect(tidyText('a\0b   c\n\n\n d')).toBe('ab c\nd');
  });

  it('finds a text file by the words in it, with a bit of the text', async () => {
    const doc = await add(
      mom,
      momRoot,
      'house.txt',
      Buffer.from('Notes\n\nInsurance policy number 4711 for the house in Bonn. Renews in March.'),
      'text/plain',
    );
    expect((await blobOf(doc.id)).textStatus).toBe('ready');
    const hits = await search(mom, 'policy 47');
    expect(hits.map((h) => h.id)).toEqual([doc.id]);
    expect(hits[0]!.snippet).toContain('Insurance policy number 4711');
    // A match by name comes first, and carries no snippet.
    const named = await add(
      mom,
      momRoot,
      'policy.txt',
      Buffer.from('nothing to see'),
      'text/plain',
    );
    const both = await search(mom, 'policy');
    expect(both.map((h) => h.id)).toEqual([named.id, doc.id]);
    expect(both[0]!.snippet).toBeUndefined();
  });

  it.skipIf(!hasPdftotext)('finds a PDF by its text', async () => {
    const doc = await add(
      mom,
      momRoot,
      'scan-0001.pdf',
      pdf('Kindergeld Bescheid 2026'),
      'application/pdf',
    );
    expect((await blobOf(doc.id)).textStatus).toBe('ready');
    expect((await search(mom, 'kindergeld')).map((h) => h.id)).toEqual([doc.id]);
  });

  it('never finds what is in someone else’s private files, until they share it', async () => {
    const secret = await add(
      kid,
      kidRoot,
      'diary.txt',
      Buffer.from('my crush is Zebediah'),
      'text/plain',
    );
    expect(await search(mom, 'zebediah')).toEqual([]);
    expect((await search(kid, 'zebediah')).map((h) => h.id)).toEqual([secret.id]);
    const shared = await add(
      kid,
      kidRoot,
      'packing.txt',
      Buffer.from('passport sunscreen Zebediah'),
      'text/plain',
    );
    expect(
      (await kid.post(`/nodes/${shared.id}/shares`, { userId: momId, permission: 'view' })).status,
    ).toBe(200);
    expect((await search(mom, 'zebediah')).map((h) => h.id)).toEqual([shared.id]);
  });

  it('leaves out files that are in the trash, infected or still waiting for their virus check', async () => {
    const doc = await add(
      mom,
      momRoot,
      'recipe.txt',
      Buffer.from('cardamom chai recipe'),
      'text/plain',
    );
    expect(await search(mom, 'cardamom')).toHaveLength(1);
    const blob = await blobOf(doc.id);
    for (const scanStatus of ['held', 'infected'] as const) {
      await env.ctx.db.update(blobs).set({ scanStatus }).where(eq(blobs.id, blob.id));
      expect(await search(mom, 'cardamom')).toEqual([]);
    }
    await env.ctx.db.update(blobs).set({ scanStatus: 'clean' }).where(eq(blobs.id, blob.id));
    await mom.del(`/nodes/${doc.id}`);
    expect(await search(mom, 'cardamom')).toEqual([]);
  });

  it('skips binary files, and waits for an Office file’s preview', async () => {
    const bin = await add(mom, momRoot, 'data.txt', Buffer.from([0x61, 0, 0x62]), 'text/plain');
    expect((await blobOf(bin.id)).textStatus).toBe('none');
    const docx = await add(
      mom,
      momRoot,
      'cv.docx',
      Buffer.from('PK fake docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const blob = await blobOf(docx.id);
    expect(blob.textStatus).toBe('pending');
    // LibreOffice couldn't read it: no words either.
    await env.ctx.db.update(blobs).set({ previewStatus: 'failed' }).where(eq(blobs.id, blob.id));
    await extractText(env.ctx, blob.id);
    expect((await blobOf(docx.id)).textStatus).toBe('failed');
  });

  it('reads documents stored before the update, and drops the words with the file', async () => {
    const doc = await add(
      mom,
      momRoot,
      'old.txt',
      Buffer.from('heirloom silverware list'),
      'text/plain',
    );
    const blob = await blobOf(doc.id);
    await env.ctx.db.delete(blobTexts).where(eq(blobTexts.blobId, blob.id));
    await env.ctx.db
      .update(blobs)
      .set({ textStatus: 'pending', createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(blobs.id, blob.id));
    expect(await search(mom, 'heirloom')).toEqual([]);
    await recoverPendingWork(env.ctx);
    const queued = env.jobs.take('extract-text').map((j) => (j.data as { blobId: string }).blobId);
    expect(queued).toContain(blob.id);
    await extractText(env.ctx, blob.id);
    expect((await search(mom, 'heirloom')).map((h) => h.id)).toEqual([doc.id]);

    await mom.del(`/nodes/${doc.id}`);
    expect((await mom.del('/trash')).status).toBe(200);
    expect(await env.ctx.db.select().from(blobTexts).where(eq(blobTexts.blobId, blob.id))).toEqual(
      [],
    );
  });
});
