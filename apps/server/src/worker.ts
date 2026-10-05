import { loadConfig } from './config';
import { createContext } from './context';
import {
  cleanupSessions,
  drainVolume,
  expireUploads,
  hashBlob,
  purgeExpiredTrash,
  reconcileUsage,
  recoverPendingWork,
} from './jobs/maintenance';
import { readMediaInfo } from './jobs/media-info';
import { makeOfficePreview } from './jobs/office';
import { JOBS, type JobPayloads, type PgBossQueue } from './jobs/queue';
import { queuePendingScans, scanBlob } from './jobs/scan';
import { configureSharp, generateThumbnail } from './jobs/thumbnail';
import { makeVideoStream } from './jobs/video';
import { purgeExpiredVersions } from './modules/versions/service';

/**
 * Background worker: thumbnails, checksums, volume drains and scheduled maintenance.
 * Runs as a separate process so CPU-heavy media work never blocks the API event loop.
 */
async function main() {
  const config = loadConfig();
  const ctx = await createContext(config, { role: 'worker' });
  const queue = ctx.jobs as PgBossQueue;
  const boss = queue.boss;
  configureSharp(config.workerConcurrency);

  const handle =
    <N extends keyof JobPayloads>(name: N, fn: (data: JobPayloads[N]) => Promise<unknown>) =>
    async (jobs: { data: JobPayloads[N] }[]) => {
      for (const job of jobs) {
        try {
          await fn(job.data);
        } catch (err) {
          ctx.log.error({ err, job: name }, 'job failed');
          throw err; // let pg-boss retry with backoff
        }
      }
    };

  await boss.work(
    JOBS.thumbnail,
    { localConcurrency: config.workerConcurrency },
    handle('thumbnail', (d) => generateThumbnail(ctx, d.blobId)),
  );
  await boss.work(
    JOBS.videoStream,
    // One at a time: ffmpeg already uses every core for a single video.
    { localConcurrency: 1 },
    handle('video-stream', (d) => makeVideoStream(ctx, d.blobId)),
  );
  await boss.work(
    JOBS.officePreview,
    { localConcurrency: 2 },
    handle('office-preview', (d) => makeOfficePreview(ctx, d.blobId)),
  );
  await boss.work(
    JOBS.hash,
    { localConcurrency: 2 },
    handle('hash', (d) => hashBlob(ctx, d.blobId)),
  );
  await boss.work(
    JOBS.scan,
    { localConcurrency: 2 },
    handle('scan', (d) => scanBlob(ctx, d.blobId)),
  );
  await boss.work(
    JOBS.mediaInfo,
    { localConcurrency: 2 },
    handle('media-info', (d) => readMediaInfo(ctx, d.blobId)),
  );
  await boss.work(
    JOBS.drainVolume,
    { localConcurrency: 1 },
    handle('drain-volume', (d) => drainVolume(ctx, d.volumeId)),
  );
  await boss.work(
    JOBS.purgeTrash,
    handle('purge-trash', () => purgeExpiredTrash(ctx)),
  );
  await boss.work(
    JOBS.reconcileUsage,
    handle('reconcile-usage', () => reconcileUsage(ctx)),
  );
  await boss.work(
    JOBS.expireUploads,
    handle('expire-uploads', () => expireUploads(ctx)),
  );
  await boss.work(
    JOBS.cleanupSessions,
    handle('cleanup-sessions', () => cleanupSessions(ctx)),
  );
  await boss.work(
    JOBS.recoverWork,
    handle('recover-work', async () => {
      await recoverPendingWork(ctx);
      await queuePendingScans(ctx);
    }),
  );
  await boss.work(
    JOBS.purgeVersions,
    handle('purge-versions', () => purgeExpiredVersions(ctx)),
  );

  await boss.schedule(JOBS.purgeTrash, '17 3 * * *');
  await boss.schedule(JOBS.purgeVersions, '27 3 * * *');
  await boss.schedule(JOBS.reconcileUsage, '47 3 * * *');
  await boss.schedule(JOBS.expireUploads, '*/15 * * * *');
  await boss.schedule(JOBS.cleanupSessions, '5 4 * * *');
  // A job lost on the way (the database blinked while an upload finished) would otherwise wait
  // for the next worker restart, which on an always-on server can be months.
  await boss.schedule(JOBS.recoverWork, '23 * * * *');

  await recoverPendingWork(ctx);
  ctx.log.info({ concurrency: config.workerConcurrency }, 'worker started');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    ctx.log.info('worker shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    await ctx.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
