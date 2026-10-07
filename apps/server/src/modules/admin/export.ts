import { constants } from 'node:fs';
import { copyFile, link, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { users } from '../../db/schema';
import { listTree } from '../files/serve';

export interface ExportResult {
  files: number;
  failed: { path: string; error: string }[];
}

/**
 * Disaster recovery: rebuilds each person's folders as `<out>/<email>/…` from the blob store.
 * Files are hard-linked when on the same filesystem and copied otherwise. Safe to re-run into
 * the same directory, and one unreadable file (offline disk, missing blob) doesn't stop the rest.
 */
export async function exportFiles(
  ctx: AppContext,
  outDir: string,
  opts: { email?: string } = {},
): Promise<ExportResult> {
  const out = path.resolve(outDir);
  const people = await ctx.db
    .select()
    .from(users)
    .where(opts.email ? eq(users.email, opts.email) : undefined);
  const result: ExportResult = { files: 0, failed: [] };
  for (const person of people) {
    if (!person.rootNodeId) continue;
    const base = path.join(out, person.email);
    await mkdir(base, { recursive: true });
    // Files still waiting for their virus check are theirs too (the scanner may be the thing
    // that's down); only infected ones stay out.
    for (const entry of await listTree(ctx.db, person.rootNodeId, 10_000_000, ['infected'])) {
      const dest = path.join(base, entry.path);
      if (!dest.startsWith(base + path.sep)) continue; // defensive: names never contain separators
      try {
        if (entry.type === 'folder') {
          await mkdir(dest, { recursive: true });
          continue;
        }
        if (!entry.blobId || !entry.volumeId) continue;
        await mkdir(path.dirname(dest), { recursive: true });
        const src = await ctx.volumes.blobFile({ id: entry.blobId, volumeId: entry.volumeId });
        // Never write through an existing file: after an earlier export it may be a hard link to
        // another blob (the file was since renamed or replaced), and copying over it would
        // overwrite that blob's bytes in the live store.
        await rm(dest, { force: true });
        await link(src, dest).catch(() => copyFile(src, dest, constants.COPYFILE_EXCL));
        result.files++;
      } catch (err) {
        result.failed.push({
          path: path.relative(out, dest),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}
