import { execFile } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { splitExtension } from '@familycloud/shared/all';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { AppContext } from '../context';
import { blobs, nodes } from '../db/schema';
import { thumbPath } from '../storage/thumbs';

// Long-running worker: no libvips operation cache, and bounded threads per image.
sharp.cache(false);

const TOOL_TIMEOUT_MS = 60_000;
/** ~268 MP: refuses decompression bombs while allowing any real camera photo. */
const MAX_PIXELS = 16_384 * 16_384;

class ToolMissing extends Error {}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: TOOL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (err) => {
        if (!err) return resolve();
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new ToolMissing(cmd));
        reject(err);
      },
    );
  });
}

type Kind = 'image' | 'heic' | 'video' | 'pdf' | null;

function kindOf(mime: string | null, name: string): Kind {
  const m = (mime ?? '').toLowerCase();
  const ext = splitExtension(name)[1].toLowerCase();
  if (m === 'image/heic' || m === 'image/heif' || ext === '.heic' || ext === '.heif') return 'heic';
  if (m === 'image/svg+xml') return null;
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  return null;
}

/** Converts the source into something sharp can read (a still frame, a page, a JPEG). */
async function toRaster(kind: Kind, src: string, work: string): Promise<string> {
  const out = path.join(work, 'frame.jpg');
  switch (kind) {
    case 'image':
      return src;
    case 'heic':
      // Prebuilt sharp lacks the HEVC decoder iPhone photos need; libheif's CLI has it.
      try {
        await run('heif-dec', [src, out]);
      } catch (err) {
        if (!(err instanceof ToolMissing)) throw err;
        await run('heif-convert', [src, out]);
      }
      return out;
    case 'video':
      try {
        await run('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          '1',
          '-i',
          src,
          '-frames:v',
          '1',
          '-y',
          out,
        ]);
      } catch (err) {
        if (err instanceof ToolMissing) throw err;
        // Clips shorter than a second: take the very first frame.
        await run('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          src,
          '-frames:v',
          '1',
          '-y',
          out,
        ]);
      }
      return out;
    case 'pdf': {
      const prefix = path.join(work, 'page');
      await run('pdftoppm', [
        '-jpeg',
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-scale-to',
        '1600',
        src,
        prefix,
      ]);
      return `${prefix}.jpg`;
    }
    default:
      throw new Error('unsupported');
  }
}

export function configureSharp(workerConcurrency: number) {
  sharp.concurrency(Math.max(1, Math.floor(cpus().length / workerConcurrency)));
}

/** Renders 1600px (preview) and 256px (grid) WebP thumbnails for a blob. */
export async function generateThumbnail(ctx: AppContext, blobId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ blob: blobs, name: nodes.name, mime: nodes.mimeType })
    .from(blobs)
    .innerJoin(nodes, eq(nodes.blobId, blobs.id))
    .where(eq(blobs.id, blobId))
    .limit(1);
  if (!row) return; // deleted before we got to it
  const kind = kindOf(row.mime, row.name);
  const setStatus = (thumbStatus: 'ready' | 'failed' | 'unsupported') =>
    ctx.db.update(blobs).set({ thumbStatus }).where(eq(blobs.id, blobId));
  if (!kind) {
    await setStatus('unsupported');
    return;
  }

  const src = await ctx.volumes.blobFile(row.blob);
  const work = path.join(tmpdir(), `fc-thumb-${blobId}`);
  const big = thumbPath(ctx.config.cacheDir, blobId, 1600);
  const small = thumbPath(ctx.config.cacheDir, blobId, 256);
  try {
    await mkdir(work, { recursive: true });
    await mkdir(path.dirname(big), { recursive: true });
    const raster = await toRaster(kind, src, work);
    await sharp(raster, { limitInputPixels: MAX_PIXELS, failOn: 'none', sequentialRead: true })
      .rotate() // honour EXIF orientation from phones
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(`${big}.tmp`);
    await rename(`${big}.tmp`, big);
    await sharp(big)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(`${small}.tmp`);
    await rename(`${small}.tmp`, small);
    await setStatus('ready');
  } catch (err) {
    if (err instanceof ToolMissing) {
      ctx.log.warn({ tool: err.message, blobId }, 'thumbnail tool not installed');
      await setStatus('unsupported');
    } else {
      ctx.log.warn({ err, blobId, kind }, 'thumbnail generation failed');
      await setStatus('failed');
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
