import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitExtension } from '@familycloud/shared/all';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { blobs, nodes } from '../db/schema';
import { previewPath } from '../storage/thumbs';

const CONVERT_TIMEOUT_MS = 3 * 60_000;

/**
 * Renders an Office document (Word, Excel, PowerPoint, OpenDocument, RTF) to PDF with
 * LibreOffice, so it can be read in the browser without downloading it, and queues a thumbnail
 * made from its first page.
 *
 * Runs in the worker, which has no internet access (so linked content in a document can't be
 * fetched), with a throwaway LibreOffice profile per run (macros stay off, runs can't clash).
 */
export async function makeOfficePreview(ctx: AppContext, blobId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ blob: blobs, name: nodes.name })
    .from(blobs)
    .innerJoin(nodes, eq(nodes.blobId, blobs.id))
    .where(eq(blobs.id, blobId))
    .limit(1);
  if (!row) return;
  const setStatus = (previewStatus: 'ready' | 'failed') =>
    ctx.db
      .update(blobs)
      .set({ previewStatus })
      .where(eq(blobs.id, blobId))
      .returning({ id: blobs.id });

  const src = await ctx.volumes.blobFile(row.blob);
  const ext = splitExtension(row.name)[1].toLowerCase() || '.bin';
  let work: string | null = null;
  try {
    work = await mkdtemp(path.join(tmpdir(), `fc-office-${blobId}-`));
    // LibreOffice picks the import filter partly from the extension; blobs have none.
    const input = path.join(work, `document${ext}`);
    await symlink(src, input).catch(() => copyFile(src, input));
    await run([
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      `-env:UserInstallation=file://${path.join(work, 'profile')}`,
      '--convert-to',
      'pdf',
      '--outdir',
      work,
      input,
    ]);
    const pdf = path.join(work, 'document.pdf');
    if (!(await stat(pdf).catch(() => null))) throw new Error('LibreOffice produced no PDF');
    const out = previewPath(ctx.config.cacheDir, blobId);
    await mkdir(path.dirname(out), { recursive: true });
    // /tmp and the cache are usually different filesystems: copy, then swap in atomically.
    const tmp = `${out}.${randomUUID()}.tmp`;
    await copyFile(pdf, tmp);
    await rename(tmp, out);
    const [still] = await setStatus('ready');
    if (!still) {
      await rm(out, { force: true });
      return;
    }
    await ctx.jobs.send('thumbnail', { blobId }).catch(() => {});
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    ctx.log.warn(
      { err: missing ? undefined : err, blobId },
      missing ? 'LibreOffice is not installed' : 'office preview failed',
    );
    await setStatus('failed');
    await ctx.db.update(blobs).set({ thumbStatus: 'unsupported' }).where(eq(blobs.id, blobId));
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.SOFFICE_BIN ?? 'soffice',
      args,
      {
        timeout: CONVERT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}
