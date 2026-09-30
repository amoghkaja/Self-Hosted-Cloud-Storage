import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, GiB } from '@familycloud/shared/all';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import { blobs, storageVolumes, uploadSessions, type VolumeRow } from '../db/schema';
import { AppError, badRequest, conflict } from '../lib/errors';

export const VOLUME_MARKER = '.familycloud-volume';
const STATUS_TTL_MS = 10_000;

export interface VolumeRuntime {
  online: boolean;
  disk: { totalBytes: number; freeBytes: number } | null;
  /** st_dev of the volume directory; two volumes with the same dev share one filesystem. */
  dev: number | null;
  error: string | null;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/**
 * Owns the set of storage volumes (directories under <DATA_DIR>/volumes, usually one per disk).
 * Every volume carries a marker file with its id so an unmounted disk (empty mount point) is
 * detected as offline instead of silently filling the root filesystem.
 */
export class VolumeManager {
  private readonly runtime = new Map<string, { at: number; value: Promise<VolumeRuntime> }>();
  private readonly paths = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly volumesRoot: string,
    private readonly log: Logger,
  ) {}

  blobPath(volumePath: string, blobId: string): string {
    // uuidv7 starts with a timestamp, so fan out on the random tail for an even spread.
    return path.join(volumePath, 'blobs', blobId.slice(-2), blobId.slice(-4, -2), blobId);
  }

  tmpPath(volumePath: string, uploadId: string): string {
    return path.join(volumePath, 'tmp', uploadId);
  }

  async pathOf(volumeId: string): Promise<string> {
    const cached = this.paths.get(volumeId);
    if (cached) return cached;
    const [row] = await this.db
      .select({ path: storageVolumes.path })
      .from(storageVolumes)
      .where(eq(storageVolumes.id, volumeId));
    if (!row) throw new AppError(500, ErrorCode.INTERNAL, `Unknown volume ${volumeId}`);
    this.paths.set(volumeId, row.path);
    return row.path;
  }

  async blobFile(blob: { id: string; volumeId: string }): Promise<string> {
    return this.blobPath(await this.pathOf(blob.volumeId), blob.id);
  }

  /** Health + capacity of one volume, cached for a few seconds (statfs on every request is wasteful). */
  status(volume: Pick<VolumeRow, 'id' | 'path'>, fresh = false): Promise<VolumeRuntime> {
    const hit = this.runtime.get(volume.id);
    if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
    const value = this.probe(volume);
    this.runtime.set(volume.id, { at: Date.now(), value });
    return value;
  }

  /**
   * Re-probes the marker right before writing: placement uses a status cached for 10 s, and a
   * disk unmounted in that window leaves an empty mount point on the root filesystem that
   * would otherwise quietly receive the file (hidden again once the disk is remounted).
   */
  async assertOnline(volume: Pick<VolumeRow, 'id' | 'path'>): Promise<void> {
    if (!(await this.status(volume, true)).online) {
      throw new AppError(
        503,
        ErrorCode.VOLUME_OFFLINE,
        'Storage is offline. Ask your admin to check the disks.',
      );
    }
  }

  invalidate(volumeId?: string): void {
    if (volumeId) this.runtime.delete(volumeId);
    else this.runtime.clear();
  }

  private async probe(volume: Pick<VolumeRow, 'id' | 'path'>): Promise<VolumeRuntime> {
    try {
      const marker = JSON.parse(await readFile(path.join(volume.path, VOLUME_MARKER), 'utf8')) as {
        id?: string;
      };
      if (marker.id !== volume.id) {
        return {
          online: false,
          disk: null,
          dev: null,
          error: 'Volume marker belongs to another volume',
        };
      }
      const [fs, st] = await Promise.all([statfs(volume.path), stat(volume.path)]);
      return {
        online: true,
        disk: { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize },
        dev: st.dev,
        error: null,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const error =
        code === 'ENOENT'
          ? 'Volume marker missing. Is the disk mounted?'
          : `Volume unavailable (${code ?? 'error'})`;
      return { online: false, disk: null, dev: null, error };
    }
  }

  /** Creates the first volume on a fresh install so the app works with zero configuration. */
  async ensureDefaultVolume(): Promise<void> {
    const existing = await this.db.select({ id: storageVolumes.id }).from(storageVolumes).limit(1);
    if (existing.length > 0) return;
    const dir = path.join(this.volumesRoot, 'disk1');
    await mkdir(dir, { recursive: true });
    const fs = await statfs(dir);
    const reserve = Math.min(10 * GiB, Math.floor(fs.blocks * fs.bsize * 0.05));
    await this.register({ name: 'disk1', path: dir, reserveBytes: reserve });
    this.log.info({ path: dir }, 'Created default storage volume');
  }

  /** Validates a path for a new volume: an existing directory directly under the volumes root. */
  async validateNewPath(input: string): Promise<string> {
    const rootReal = await realpath(this.volumesRoot).catch(() => this.volumesRoot);
    let real: string;
    try {
      real = await realpath(path.resolve(this.volumesRoot, input));
    } catch {
      throw badRequest(`Directory does not exist: ${input}`);
    }
    const rel = path.relative(rootReal, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw badRequest(`Volume must be a directory directly inside ${this.volumesRoot}`);
    }
    if (!(await stat(real)).isDirectory()) throw badRequest('Volume path is not a directory');
    const rows = await this.db
      .select({ id: storageVolumes.id, name: storageVolumes.name, path: storageVolumes.path })
      .from(storageVolumes);
    if (rows.some((r) => r.path === real)) throw conflict('That directory is already a volume');
    // A registered disk mounted at a new place: registering it again would overwrite its
    // marker, taking the original volume (and every file on it) offline.
    const marker = await readFile(path.join(real, VOLUME_MARKER), 'utf8')
      .then((m) => JSON.parse(m) as { id?: string })
      .catch(() => null);
    const owner = rows.find((r) => r.id === marker?.id);
    if (owner) {
      throw conflict(
        `This disk is already registered as "${owner.name}" (at ${owner.path}). Mount it there again instead.`,
      );
    }
    return real;
  }

  async register(input: {
    name: string;
    path: string;
    capacityLimitBytes?: number | null;
    reserveBytes?: number;
  }): Promise<VolumeRow> {
    await mkdir(path.join(input.path, 'blobs'), { recursive: true });
    await mkdir(path.join(input.path, 'tmp'), { recursive: true });
    const [row] = await this.db
      .insert(storageVolumes)
      .values({
        name: input.name,
        path: input.path,
        capacityLimitBytes: input.capacityLimitBytes ?? null,
        reserveBytes: input.reserveBytes ?? 0,
      })
      .returning();
    if (!row) throw new Error('insert failed');
    const marker = path.join(input.path, VOLUME_MARKER);
    const tmp = `${marker}.tmp`;
    await writeFile(
      tmp,
      `${JSON.stringify({ id: row.id, name: row.name, createdAt: row.createdAt }, null, 2)}\n`,
    );
    await rename(tmp, marker);
    return row;
  }

  /** Subdirectories of the volumes root that are not yet registered (e.g. freshly mounted disks). */
  async candidates(): Promise<{ path: string; name: string; runtime: VolumeRuntime }[]> {
    const registered = new Set(
      (await this.db.select({ path: storageVolumes.path }).from(storageVolumes)).map((r) => r.path),
    );
    const entries = await readdir(this.volumesRoot, { withFileTypes: true }).catch(() => []);
    const out: { path: string; name: string; runtime: VolumeRuntime }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(this.volumesRoot, e.name);
      const real = await realpath(p).catch(() => p);
      if (registered.has(real) || registered.has(p)) continue;
      const [fs, st] = await Promise.all([statfs(real), stat(real)]).catch(() => [null, null]);
      out.push({
        path: real,
        name: e.name,
        runtime: {
          online: !!fs,
          disk: fs ? { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize } : null,
          dev: st?.dev ?? null,
          error: null,
        },
      });
    }
    return out;
  }

  /** Bytes stored and blob count per volume (optionally only for `volumeIds`). */
  async usage(
    exec: Executor = this.db,
    volumeIds?: string[],
  ): Promise<Map<string, { bytes: number; count: number }>> {
    const rows = await exec
      .select({
        volumeId: blobs.volumeId,
        bytes: sql<number>`coalesce(sum(${blobs.size}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      })
      .from(blobs)
      .where(volumeIds ? inArray(blobs.volumeId, volumeIds) : undefined)
      .groupBy(blobs.volumeId);
    return new Map(rows.map((r) => [r.volumeId, { bytes: Number(r.bytes), count: r.count }]));
  }

  /**
   * Picks the active, online volume with the most usable space for `size` bytes, accounting for
   * the per-volume reserve, optional capacity limit and uploads already in flight.
   * Call inside the reservation transaction so concurrent uploads see each other's sessions.
   */
  async pickVolume(exec: Executor, size: number, excludeId?: string): Promise<VolumeRow> {
    const active = (
      await exec.select().from(storageVolumes).where(eq(storageVolumes.status, 'active'))
    ).filter((v) => v.id !== excludeId);
    if (active.length === 0) {
      throw new AppError(507, ErrorCode.STORAGE_FULL, 'No storage volume is accepting new files');
    }
    const ids = active.map((v) => v.id);
    const pendingRows = await exec
      .select({
        volumeId: uploadSessions.volumeId,
        bytes: sql<number>`coalesce(sum(${uploadSessions.size}), 0)::bigint`,
      })
      .from(uploadSessions)
      .where(
        sql`${uploadSessions.status} in ('uploading', 'finalizing') and ${inArray(uploadSessions.volumeId, ids)}`,
      )
      .groupBy(uploadSessions.volumeId);
    const pending = new Map(pendingRows.map((r) => [r.volumeId, Number(r.bytes)]));
    // Summing every blob is a full scan, run under the global quota lock: only when a limit needs it.
    const limited = active.filter((v) => v.capacityLimitBytes != null).map((v) => v.id);
    const used = limited.length
      ? await this.usage(exec, limited)
      : new Map<string, { bytes: number; count: number }>();

    let best: { volume: VolumeRow; avail: number } | null = null;
    let anyOnline = false;
    for (const volume of active) {
      const rt = await this.status(volume);
      if (!rt.online || !rt.disk) continue;
      anyOnline = true;
      const inflight = pending.get(volume.id) ?? 0;
      let avail = rt.disk.freeBytes - volume.reserveBytes - inflight;
      if (volume.capacityLimitBytes != null) {
        const stored = used.get(volume.id)?.bytes ?? 0;
        avail = Math.min(avail, volume.capacityLimitBytes - stored - inflight);
      }
      if (avail >= size && (!best || avail > best.avail)) best = { volume, avail };
    }
    if (best) return best.volume;
    if (!anyOnline) {
      throw new AppError(
        503,
        ErrorCode.VOLUME_OFFLINE,
        'Storage is offline. Ask your admin to check the disks.',
      );
    }
    throw new AppError(507, ErrorCode.STORAGE_FULL, 'Not enough free disk space for this file');
  }
}
