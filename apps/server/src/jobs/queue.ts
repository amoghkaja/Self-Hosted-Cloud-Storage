import { PgBoss } from 'pg-boss';

export const JOBS = {
  thumbnail: 'thumbnail',
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
  hash: { blobId: string };
  'drain-volume': { volumeId: string };
  'purge-trash': Record<string, never>;
  'reconcile-usage': Record<string, never>;
  'expire-uploads': Record<string, never>;
  'cleanup-sessions': Record<string, never>;
}

export interface JobQueue {
  send<N extends JobName>(
    name: N,
    data: JobPayloads[N],
    opts?: { singletonKey?: string },
  ): Promise<void>;
  stop(): Promise<void>;
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
          retryLimit: name === JOBS.drainVolume ? 1 : 3,
          retryBackoff: true,
          expireInSeconds: name === JOBS.drainVolume ? 24 * 3600 : 30 * 60,
        });
      }
    }
    return new PgBossQueue(boss);
  }

  async send<N extends JobName>(name: N, data: JobPayloads[N], opts?: { singletonKey?: string }) {
    await this.boss.send(name, data, opts?.singletonKey ? { singletonKey: opts.singletonKey } : {});
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
