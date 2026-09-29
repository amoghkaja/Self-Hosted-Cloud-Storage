import { PgBoss } from 'pg-boss';

export const JOBS = {
  thumbnail: 'thumbnail',
  videoStream: 'video-stream',
  hash: 'hash',
  drainVolume: 'drain-volume',
  purgeTrash: 'purge-trash',
  reconcileUsage: 'reconcile-usage',
  expireUploads: 'expire-uploads',
  cleanupSessions: 'cleanup-sessions',
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobPayloads {
  thumbnail: { blobId: string };
  'video-stream': { blobId: string };
  hash: { blobId: string };
  'drain-volume': { volumeId: string };
  'purge-trash': Record<string, never>;
  'reconcile-usage': Record<string, never>;
  'expire-uploads': Record<string, never>;
  'cleanup-sessions': Record<string, never>;
}

export interface JobQueue {
  send<N extends JobName>(name: N, data: JobPayloads[N]): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Jobs about one blob or volume are de-duplicated per blob/volume id: a thumbnail or hash job
 * waiting in the queue already covers a second request, and a volume is drained by one job at a
 * time. Every job on these queues carries its key, since a keyless job would collide with all
 * the other keyless ones.
 */
const POLICY: Partial<Record<JobName, 'short' | 'exclusive'>> = {
  thumbnail: 'short',
  'video-stream': 'short',
  hash: 'short',
  'drain-volume': 'exclusive',
};

function singletonKey(data: object): string | undefined {
  const d = data as { blobId?: string; volumeId?: string };
  return d.blobId ?? d.volumeId;
}

/** Job queue backed by pg-boss: jobs live in Postgres, so no Redis is needed. */
export class PgBossQueue implements JobQueue {
  private constructor(readonly boss: PgBoss) {}

  static async connect(
    connectionString: string,
    opts: { worker: boolean; onError: (err: unknown) => void },
  ): Promise<PgBossQueue> {
    const boss = new PgBoss({
      connectionString,
      max: opts.worker ? 6 : 2,
      supervise: opts.worker,
      schedule: opts.worker,
      application_name: opts.worker ? 'familycloud-worker' : 'familycloud-api-producer',
    });
    boss.on('error', opts.onError);
    await boss.start();
    for (const name of Object.values(JOBS)) {
      if (!(await boss.getQueue(name))) {
        await boss.createQueue(name, {
          policy: POLICY[name] ?? 'standard',
          retryLimit: name === JOBS.drainVolume || name === JOBS.videoStream ? 1 : 3,
          retryBackoff: true,
          // Drains move whole disks; a long film takes a while to convert.
          expireInSeconds:
            name === JOBS.drainVolume ? 24 * 3600 : name === JOBS.videoStream ? 6 * 3600 : 30 * 60,
        });
      }
    }
    return new PgBossQueue(boss);
  }

  async send<N extends JobName>(name: N, data: JobPayloads[N]) {
    const key = POLICY[name] ? singletonKey(data) : undefined;
    await this.boss.send(name, data, key ? { singletonKey: key } : {});
  }

  async stop() {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

/** In-process queue for tests: records jobs so tests can run handlers explicitly. */
export class MemoryQueue implements JobQueue {
  readonly sent: { name: JobName; data: unknown }[] = [];
  async send<N extends JobName>(name: N, data: JobPayloads[N]) {
    this.sent.push({ name, data });
  }
  take(name: JobName) {
    const matching = this.sent.filter((j) => j.name === name);
    this.sent.splice(0, this.sent.length, ...this.sent.filter((j) => j.name !== name));
    return matching;
  }
  async stop() {}
}
