import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { blobs } from '../db/schema';
import { streamPath } from '../storage/thumbs';

const PROBE_TIMEOUT_MS = 60_000;
/** Generous: a long 4K film on a small machine. The job expires after 6 hours anyway. */
const TRANSCODE_TIMEOUT_MS = 5 * 3600 * 1000;
/** Streams at or below this already play well on a phone abroad. */
const MAX_DIRECT_BITRATE = 4_000_000;
const TARGET_HEIGHT = 720;

/**
 * Input options for every ffmpeg and ffprobe run on an uploaded file: read it only as a real
 * video container, from the local disk. ffmpeg picks the format from the contents, and a
 * streaming manifest or playlist (DASH, HLS, ffconcat) dressed up as a video would otherwise make
 * the worker fetch addresses of the uploader's choosing.
 */
export const UPLOADED_VIDEO_INPUT = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,matroska,avi,mpegts,mpeg,flv,asf,ogg,dv,mxf,rm',
];

function exec(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

interface Probe {
  codec: string | null;
  height: number;
  bitrate: number;
  container: string;
}

async function probe(file: string): Promise<Probe> {
  const out = await exec(
    'ffprobe',
    [
      '-v',
      'error',
      ...UPLOADED_VIDEO_INPUT,
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ],
    PROBE_TIMEOUT_MS,
  );
  const info = JSON.parse(out) as {
    streams?: { codec_type?: string; codec_name?: string; height?: number }[];
    format?: { format_name?: string; bit_rate?: string };
  };
  const video = info.streams?.find((s) => s.codec_type === 'video');
  return {
    codec: video?.codec_name ?? null,
    height: video?.height ?? 0,
    bitrate: Number(info.format?.bit_rate ?? 0),
    container: info.format?.format_name ?? '',
  };
}

/**
 * Makes a 720p H.264/AAC MP4 of a video for streaming, with the index at the front so playback
 * starts at once and seeking works over a slow link. Family abroad then pulls a few MB a minute
 * instead of a 4K original, and iPhone HEVC videos play in every browser. Videos that are
 * already small H.264 MP4s are streamed as they are ('original').
 */
export async function makeVideoStream(ctx: AppContext, blobId: string): Promise<void> {
  const [blob] = await ctx.db.select().from(blobs).where(eq(blobs.id, blobId));
  // Gone, or already converted by an earlier run of the same job.
  if (blob?.streamStatus !== 'pending') return;
  const setStatus = (streamStatus: 'ready' | 'original' | 'failed') =>
    ctx.db.update(blobs).set({ streamStatus }).where(eq(blobs.id, blobId));

  const src = await ctx.volumes.blobFile(blob);
  let info: Probe;
  try {
    info = await probe(src);
  } catch (err) {
    ctx.log.warn({ err, blobId }, 'could not read video');
    await setStatus('failed');
    return;
  }
  if (!info.codec) {
    await setStatus('failed');
    return;
  }
  const alreadyFine =
    info.codec === 'h264' &&
    info.height <= TARGET_HEIGHT + 60 &&
    info.bitrate > 0 &&
    info.bitrate <= MAX_DIRECT_BITRATE &&
    /mp4|mov/.test(info.container);
  if (alreadyFine) {
    await setStatus('original');
    return;
  }

  const out = streamPath(ctx.config.cacheDir, blobId);
  const tmp = `${out}.${randomUUID()}.tmp.mp4`;
  await mkdir(path.dirname(out), { recursive: true });
  try {
    await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...UPLOADED_VIDEO_INPUT,
        '-i',
        src,
        // Never upscale; keep the aspect ratio (even width for H.264).
        '-vf',
        `scale=-2:'min(${TARGET_HEIGHT},ih)'`,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-maxrate',
        '3M',
        '-bufsize',
        '6M',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-y',
        tmp,
      ],
      TRANSCODE_TIMEOUT_MS,
    );
    await rename(tmp, out);
    const [still] = await setStatus('ready').returning({ id: blobs.id });
    // Deleted while converting: don't leave the copy behind.
    if (!still) await rm(out, { force: true });
  } catch (err) {
    ctx.log.warn({ err, blobId }, 'video streaming copy failed');
    await setStatus('failed');
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
