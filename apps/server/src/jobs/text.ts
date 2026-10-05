import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileKind, isOfficeDocument, splitExtension } from '@familycloud/shared/all';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { blobs, blobTexts, nodes } from '../db/schema';
import { previewPath } from '../storage/thumbs';

/** Enough for a few hundred pages; search only needs to know which words a file has. */
const MAX_CHARS = 1_000_000;
const PLAIN_BYTES = 2 * 1024 * 1024;
const PDF_PAGES = 500;
const PDF_TIMEOUT_MS = 2 * 60_000;

type Source = 'pdf' | 'office' | 'plain';

/** Where a file's words come from, or null for files that have none to search. */
export function textSource(mimeType: string | null, name: string): Source | null {
  const kind = fileKind(mimeType, name);
  if (kind === 'pdf') return 'pdf';
  if (kind === 'text' || kind === 'code') return 'plain';
  // Read as it is: faster and more faithful than LibreOffice's rendering of it.
  if (splitExtension(name)[1].toLowerCase() === '.csv') return 'plain';
  // From the PDF the office job renders.
  if (isOfficeDocument(mimeType, name)) return 'office';
  return null;
}

function pdfText(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftotext',
      ['-q', '-enc', 'UTF-8', '-l', String(PDF_PAGES), file, '-'],
      { timeout: PDF_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** The start of a text file, or null when it turns out to be binary. */
async function plainText(file: string): Promise<string | null> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(PLAIN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PLAIN_BYTES, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.includes(0)) return null;
    return new TextDecoder('utf-8').decode(head);
  } finally {
    await fh.close();
  }
}

/** Postgres text can't hold NUL; runs of spaces and blank lines carry nothing for search. */
export function tidyText(raw: string): string {
  return raw
    .replaceAll('\0', '')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, MAX_CHARS);
}

/**
 * Reads the words of a document so search finds files by what's in them, not just their names.
 * Office files wait for their PDF preview (the office job queues this again once it exists).
 */
export async function extractText(ctx: AppContext, blobId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ blob: blobs, name: nodes.name, mime: nodes.mimeType })
    .from(blobs)
    .innerJoin(nodes, eq(nodes.blobId, blobs.id))
    .where(eq(blobs.id, blobId))
    .limit(1);
  // Gone, or already read by an earlier run of the same job.
  if (row?.blob.textStatus !== 'pending') return;
  const setStatus = (textStatus: 'ready' | 'failed' | 'none') =>
    ctx.db.update(blobs).set({ textStatus }).where(eq(blobs.id, blobId));

  const source = textSource(row.mime, row.name);
  if (!source) return void (await setStatus('none'));
  if (source === 'office' && row.blob.previewStatus === 'pending') return;
  if (source === 'office' && row.blob.previewStatus !== 'ready')
    return void (await setStatus('failed'));

  // Outside the try: a disk that's offline is retried, not recorded as a bad file.
  const file =
    source === 'office'
      ? previewPath(ctx.config.cacheDir, blobId, 'pdf')
      : await ctx.volumes.blobFile(row.blob);
  let content: string | null;
  try {
    content = source === 'plain' ? await plainText(file) : await pdfText(file);
  } catch (err) {
    // Not worth retrying: a damaged or password-protected PDF fails the same way every time.
    ctx.log.warn({ err, blobId }, 'could not read the words in a document');
    return void (await setStatus('failed'));
  }
  if (content === null) return void (await setStatus('none'));
  const text = tidyText(content);
  try {
    await ctx.db.transaction(async (tx) => {
      // Deleted while we read it: nothing to store.
      const [live] = await tx
        .select({ id: blobs.id })
        .from(blobs)
        .where(eq(blobs.id, blobId))
        .for('update');
      if (!live) return;
      if (text) {
        await tx
          .insert(blobTexts)
          .values({ blobId, content: text })
          .onConflictDoUpdate({ target: blobTexts.blobId, set: { content: text } });
      }
      await tx.update(blobs).set({ textStatus: 'ready' }).where(eq(blobs.id, blobId));
    });
  } catch (err) {
    // E.g. more distinct words than a search index holds: the file is still found by name.
    ctx.log.warn({ err, blobId }, 'could not store the words in a document');
    await setStatus('failed');
  }
}
