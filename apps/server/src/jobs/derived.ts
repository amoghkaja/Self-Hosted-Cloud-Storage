import { isOfficeDocument } from '@familycloud/shared/all';
import type { AppContext } from '../context';
import type { BlobRow } from '../db/schema';
import { isThumbnailable, isVideo } from '../storage/thumbs';
import type { JobPayloads } from './queue';
import { textSource } from './text';

type BlobJob = {
  [N in keyof JobPayloads]: JobPayloads[N] extends { blobId: string } ? N : never;
}[keyof JobPayloads];

/** What the worker makes or reads from a newly stored file, as the blob's starting statuses. */
export function derivedWork(mimeType: string | null, name: string) {
  const media = !!mimeType && (mimeType.startsWith('image/') || isVideo(mimeType));
  return {
    thumbStatus: isThumbnailable(mimeType) ? 'pending' : 'unsupported',
    streamStatus: isVideo(mimeType) ? 'pending' : 'none',
    previewStatus: isOfficeDocument(mimeType, name) ? 'pending' : 'none',
    infoStatus: media ? 'pending' : 'none',
    textStatus: textSource(mimeType, name) ? 'pending' : 'none',
  } as const;
}
export type DerivedWork = ReturnType<typeof derivedWork>;

/**
 * Queues the background work for a file whose bytes were just committed. Best effort: a job lost
 * here is picked up by the hourly recovery, which looks for blobs still marked 'pending'.
 */
export async function queueDerivedWork(ctx: AppContext, blobId: string, work: DerivedWork) {
  const send = (name: BlobJob) => ctx.jobs.send(name, { blobId }).catch(() => {});
  await send('hash');
  if (ctx.config.clamav) await send('scan');
  if (work.thumbStatus === 'pending') await send('thumbnail');
  if (work.streamStatus === 'pending') await send('video-stream');
  if (work.previewStatus === 'pending') await send('office-preview');
  if (work.infoStatus === 'pending') await send('media-info');
  if (work.textStatus === 'pending') await send('extract-text');
}

/**
 * Queues whatever never finished for an existing blob, e.g. one replaced before the worker got to
 * it and now restored from a version. The jobs skip anything already done.
 */
export async function queueUnfinishedWork(ctx: AppContext, blob: BlobRow) {
  const send = (name: BlobJob) => ctx.jobs.send(name, { blobId: blob.id });
  if (!blob.sha256) await send('hash');
  if (blob.thumbStatus === 'pending') await send('thumbnail');
  if (blob.streamStatus === 'pending') await send('video-stream');
  if (blob.previewStatus === 'pending') await send('office-preview');
  if (blob.infoStatus === 'pending') await send('media-info');
  if (blob.textStatus === 'pending') await send('extract-text');
}
