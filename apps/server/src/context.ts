import { mkdir } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import type { Config } from './config';
import { createDb, type Db, runMigrations, type SqlClient } from './db/client';
import { users } from './db/schema';
import { type JobQueue, PgBossQueue } from './jobs/queue';
import { Keyring, randomToken } from './lib/crypto';
import { SessionService } from './lib/sessions';
import { SettingsStore } from './lib/settings';
import { VolumeManager } from './storage/volume-manager';

export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  sqlClient: SqlClient;
  volumes: VolumeManager;
  jobs: JobQueue;
  keys: Keyring;
  settings: SettingsStore;
  sessions: SessionService;
  close(): Promise<void>;
}

/** Scrubs bearer-like tokens out of URLs before they reach the logs. */
export function scrubUrl(url: string): string {
  return url
    .replace(/(\/public\/links\/)[^/?#]+/g, '$1[token]')
    .replace(/(\/invites\/)[^/?#]+/g, '$1[token]')
    .replace(/(\/s\/)[^/?#]+/g, '$1[token]');
}

export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        '*.password',
        '*.newPassword',
        '*.currentPassword',
      ],
      censor: '[redacted]',
    },
    transport:
      config.env === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
  });
}

export async function createContext(
  config: Config,
  opts: { role: 'api' | 'worker' | 'cli'; jobs?: JobQueue; log?: Logger; migrate?: boolean },
): Promise<AppContext> {
  const log = opts.log ?? createLogger(config);
  const { db, client } = createDb(config.databaseUrl, {
    max: opts.role === 'cli' ? 2 : config.dbPoolSize,
    appName: `familycloud-${opts.role}`,
  });
  if (opts.migrate !== false) await runMigrations(db, client);

  await mkdir(config.volumesRoot, { recursive: true });
  await mkdir(config.cacheDir, { recursive: true });
  const volumes = new VolumeManager(db, config.volumesRoot, log);
  if (opts.role !== 'cli') await volumes.ensureDefaultVolume();

  const jobs =
    opts.jobs ??
    (await PgBossQueue.connect(config.databaseUrl, {
      worker: opts.role === 'worker',
      onError: (err) => log.error({ err }, 'job queue error'),
    }));

  return {
    config,
    log,
    db,
    sqlClient: client,
    volumes,
    jobs,
    keys: new Keyring(config.secretKey),
    settings: new SettingsStore(db),
    sessions: new SessionService(db),
    async close() {
      await jobs.stop();
      await client.end({ timeout: 5 });
    },
  };
}

/**
 * First-run setup: until an admin exists, account creation requires a one-time token that only
 * someone with server access can read (logs or `cli setup-token`). This stops a stranger who
 * finds the URL first from claiming the admin account.
 */
export async function ensureSetupToken(ctx: AppContext): Promise<string | null> {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users);
  if ((row?.n ?? 0) > 0) return null;
  if (ctx.config.setupToken) return ctx.config.setupToken;
  let token = await ctx.settings.getRaw<string>('setupToken');
  if (!token) {
    token = randomToken(18);
    await ctx.settings.setRaw('setupToken', token);
  }
  return token;
}
