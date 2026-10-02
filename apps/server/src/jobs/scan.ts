import { and, eq, lt } from 'drizzle-orm';
import type { AppContext } from '../context';
import { blobs, nodes } from '../db/schema';
import { audit } from '../lib/audit';
import { MAX_SCAN_BYTES, scanFile } from '../lib/clamav';

/** Is scanning both installed (CLAMAV_HOST) and switched on in Admin → Settings? */
export async function scanningOn(ctx: AppContext): Promise<boolean> {
  return ctx.config.clamav !== null && (await ctx.settings.get()).virusScan;
}

/**
 * Checks one blob for viruses. An infected blob stays where it is (so its owner sees what
 * happened and deletes it) but is never served again. Throws when the scanner can't be reached,
 * so the queue retries; the hourly sweep picks up whatever is still waiting after that.
 */
export async function scanBlob(ctx: AppContext, blobId: string): Promise<void> {
  if (!ctx.config.clamav || !(await scanningOn(ctx))) return;
  const [blob] = await ctx.db.select().from(blobs).where(eq(blobs.id, blobId));
  if (blob?.scanStatus !== 'pending') return;
  const result =
    blob.size > MAX_SCAN_BYTES
      ? ({ status: 'too-large' } as const)
      : await scanFile(ctx.config.clamav, await ctx.volumes.blobFile(blob));
  if (result.status !== 'infected') {
    await ctx.db
      .update(blobs)
      .set({ scanStatus: result.status === 'clean' ? 'clean' : 'skipped' })
      .where(eq(blobs.id, blobId));
    return;
  }
  await ctx.db
    .update(blobs)
    .set({ scanStatus: 'infected', scanSignature: result.signature })
    .where(eq(blobs.id, blobId));
  const files = await ctx.db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(eq(nodes.blobId, blobId));
  ctx.log.warn({ blobId, signature: result.signature }, 'virus found; file blocked');
  await audit(ctx.db, {
    actorId: null,
    action: 'scan.infected',
    targetType: 'node',
    targetId: files[0]?.id,
    meta: { signature: result.signature, names: files.map((f) => f.name).slice(0, 20) },
  });
}

/** Queues everything still waiting: uploads from while the scanner was off or unreachable. */
export async function queuePendingScans(ctx: AppContext): Promise<void> {
  if (!(await scanningOn(ctx))) return;
  const waiting = await ctx.db
    .select({ id: blobs.id })
    .from(blobs)
    .where(
      and(eq(blobs.scanStatus, 'pending'), lt(blobs.createdAt, new Date(Date.now() - 10 * 60_000))),
    )
    .limit(2000);
  for (const b of waiting) await ctx.jobs.send('scan', { blobId: b.id });
}
