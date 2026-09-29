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
import { DavAuthenticator } from './modules/webdav/auth';
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
  davAuth: DavAuthenticator;
  close(): Promise<void>;
}

/** Scrubs bearer-like tokens out of URLs before they reach the logs. */
export function scrubUrl(url: string): string {
  return url
    .replace(/(\/public\/links\/)[^/?#]+/g, '$1[token]')
    .replace(/(\/invites?\/)[^/?#]+/g, '$1[token]') // API /invites/… and the web page /invite/…
    .replace(/(\/(?:password-resets|reset)\/)[^/?#]+/g, '$1[token]') // API, and the web page
    .replace(/(\/s\/)[^/?#]+/g, '$1[token]');
}

export function createLogger(config: Config, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
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
    // Fastify logs every request with this serializer before any hook runs, so scrubbing must
    // happen here: share-link and invite tokens travel in URLs and must never reach the logs.
    serializers: {
      req: (req: { method?: string; url?: string; id?: string; ip?: string }) => ({
        method: req.method,
        url: req.url ? scrubUrl(req.url) : undefined,
        reqId: req.id,
      }),
    },
    transport:
      config.env === 'development' && !destination
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
  };
  return destination ? pino(options, destination) : pino(options);
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

  const settings = new SettingsStore(db);
  return {
    config,
    log,
    db,
    sqlClient: client,
    volumes,
    jobs,
    keys: new Keyring(config.secretKey),
    settings,
    sessions: new SessionService(db),
    davAuth: new DavAuthenticator(db, settings),
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
  // The app, a second replica and `cli setup-token` may all get here at once: the first insert
  // wins and everyone returns the stored token, so the one printed is always the one that works.
  return (
    (await ctx.settings.getRaw<string>('setupToken')) ??
    (await ctx.settings.initRaw('setupToken', randomToken(18)))
  );
}
