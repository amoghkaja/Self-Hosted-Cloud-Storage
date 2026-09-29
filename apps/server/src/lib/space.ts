import type { StorageInfo } from '@familycloud/shared/all';
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { storageVolumes, type UserRow, users } from '../db/schema';

/**
 * How much family data a volume can hold, honouring both its "always keep free" reserve and its
 * optional capacity limit. `totalBytes` includes what is already stored there.
 */
export function volumeSpace(
  v: { capacityLimitBytes: number | null; reserveBytes: number },
  disk: { freeBytes: number } | null,
  storedBytes: number,
): { totalBytes: number; freeBytes: number } | null {
  if (!disk) return null;
  let free = Math.max(0, disk.freeBytes - v.reserveBytes);
  if (v.capacityLimitBytes !== null) {
    free = Math.min(free, Math.max(0, v.capacityLimitBytes - storedBytes));
  }
  return { totalBytes: storedBytes + free, freeBytes: free };
}

/** Free space across active, online volumes (each filesystem counted once). */
export async function usableFreeBytes(ctx: AppContext): Promise<number> {
  const vols = await ctx.db
    .select()
    .from(storageVolumes)
    .where(eq(storageVolumes.status, 'active'));
  const limited = vols.filter((v) => v.capacityLimitBytes !== null).map((v) => v.id);
  const stored = limited.length ? await ctx.volumes.usage(ctx.db, limited) : new Map();
  const seen = new Set<number>();
  let free = 0;
  for (const v of vols) {
    const rt = await ctx.volumes.status(v);
    if (!rt.online) continue;
    if (rt.dev !== null) {
      if (seen.has(rt.dev)) continue;
      seen.add(rt.dev);
    }
    free += volumeSpace(v, rt.disk, stored.get(v.id)?.bytes ?? 0)?.freeBytes ?? 0;
  }
  return free;
}

/**
 * What a person can still upload right now: the tightest of their quota, the family limit and
 * the free space on the disks. The web app, sidebar and network drive all show this number.
 */
export async function storageFor(ctx: AppContext, u: UserRow): Promise<StorageInfo> {
  const [settings, [family], disks, [versions]] = await Promise.all([
    ctx.settings.get(),
    ctx.db
      .select({
        used: sql<number>`coalesce(sum(${users.usedBytes} + ${users.reservedBytes}), 0)::bigint`,
      })
      .from(users),
    usableFreeBytes(ctx),
    ctx.db.execute(sql`
      SELECT coalesce(sum(v.size), 0)::bigint AS total
      FROM file_versions v JOIN nodes n ON n.id = v.node_id
      WHERE n.owner_id = ${u.id}
    `) as unknown as Promise<{ total: number }[]>,
  ]);
  let available = disks;
  if (u.quotaBytes !== null) {
    available = Math.min(available, u.quotaBytes - u.usedBytes - u.reservedBytes);
  }
  if (settings.globalCapacityBytes !== null) {
    available = Math.min(available, settings.globalCapacityBytes - Number(family?.used ?? 0));
  }
  return {
    usedBytes: u.usedBytes,
    versionsBytes: Math.min(u.usedBytes, Number(versions?.total ?? 0)),
    quotaBytes: u.quotaBytes,
    availableBytes: Math.max(0, available),
  };
}
