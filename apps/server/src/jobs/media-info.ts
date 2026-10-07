import { execFile } from 'node:child_process';
import { eq } from 'drizzle-orm';
import exifr from 'exifr';
import type { AppContext } from '../context';
import { blobs, nodes } from '../db/schema';
import { UPLOADED_VIDEO_INPUT } from './video';

const PROBE_TIMEOUT_MS = 60_000;

export interface MediaInfo {
  /** Camera clock, "YYYY-MM-DD HH:MM:SS". */
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * A camera's "YYYY:MM:DD HH:MM:SS" (EXIF) or "YYYY-MM-DDTHH:MM:SS…" (video) as wall-clock time.
 * Cameras with an unset clock write 0000 or 1970 dates, and those are worse than no date.
 */
export function wallClock(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const t = Date.parse(iso);
  // Date.parse accepts 31 February; the round trip doesn't.
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 19) !== iso.slice(0, 19)) return null;
  if (Number(y) < 1980 || t > Date.now() + 2 * 86_400_000) return null;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function place(lat: unknown, lon: unknown): Pick<MediaInfo, 'latitude' | 'longitude'> {
  const ok =
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    // 0,0 is a phone that had no fix, not the Gulf of Guinea.
    !(lat === 0 && lon === 0);
  return ok ? { latitude: lat, longitude: lon } : { latitude: null, longitude: null };
}

async function photoInfo(file: string): Promise<MediaInfo> {
  const tags = (await exifr.parse(file, {
    pick: [
      'DateTimeOriginal',
      'CreateDate',
      'GPSLatitude',
      'GPSLatitudeRef',
      'GPSLongitude',
      'GPSLongitudeRef',
    ],
    reviveValues: false,
  })) as Record<string, unknown> | undefined;
  if (!tags) return { takenAt: null, latitude: null, longitude: null };
  return {
    takenAt: wallClock(tags.DateTimeOriginal) ?? wallClock(tags.CreateDate),
    ...place(tags.latitude, tags.longitude),
  };
}

async function videoInfo(file: string): Promise<MediaInfo> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', ...UPLOADED_VIDEO_INPUT, '-print_format', 'json', '-show_format', file],
      { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  const tags = (JSON.parse(out) as { format?: { tags?: Record<string, string> } }).format?.tags;
  if (!tags) return { takenAt: null, latitude: null, longitude: null };
  // iPhones record local time with its offset; creation_time is UTC, the best other phones give.
  const takenAt =
    wallClock(tags['com.apple.quicktime.creationdate']) ?? wallClock(tags.creation_time);
  // ISO 6709, e.g. "+48.1374+011.5755+519.000/".
  const loc = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(
    tags['com.apple.quicktime.location.ISO6709'] ?? tags.location ?? '',
  );
  return { takenAt, ...place(Number(loc?.[1] ?? Number.NaN), Number(loc?.[2] ?? Number.NaN)) };
}

/**
 * Reads when and where a photo or video was taken, so trip albums sort by when photos were taken
 * rather than when each person got round to uploading them. The file itself is never changed.
 */
export async function readMediaInfo(ctx: AppContext, blobId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ blob: blobs, mime: nodes.mimeType })
    .from(blobs)
    .innerJoin(nodes, eq(nodes.blobId, blobs.id))
    .where(eq(blobs.id, blobId))
    .limit(1);
  // Gone, or already read by an earlier run of the same job.
  if (row?.blob.infoStatus !== 'pending') return;
  const mime = row.mime ?? '';
  let info: MediaInfo = { takenAt: null, latitude: null, longitude: null };
  let infoStatus: 'ready' | 'failed' = 'ready';
  // Outside the try: a disk that's offline is retried, not recorded as a bad file.
  const file = await ctx.volumes.blobFile(row.blob);
  try {
    if (mime.startsWith('video/')) info = await videoInfo(file);
    else if (mime.startsWith('image/') && mime !== 'image/svg+xml') info = await photoInfo(file);
  } catch (err) {
    // Not worth retrying: the same bytes fail the same way. The photo sorts by upload time.
    ctx.log.warn({ err, blobId }, 'could not read photo date and place');
    infoStatus = 'failed';
  }
  await ctx.db
    .update(blobs)
    .set({ ...info, infoStatus })
    .where(eq(blobs.id, blobId));
}
