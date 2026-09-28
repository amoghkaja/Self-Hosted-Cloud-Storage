import { cpus } from 'node:os';
import path from 'node:path';
import { DEFAULT_CHUNK_SIZE, MiB } from '@familycloud/shared/all';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** The URL family members type in the browser. Used for Origin checks, cookies and links. */
  PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: 'PUBLIC_URL must be an http:// or https:// URL' })
    // Links, cookies and the web app all assume the site root; a path would be silently dropped.
    .refine((u) => ['', '/'].includes(new URL(u).pathname), {
      error: 'PUBLIC_URL must not contain a path (e.g. https://cloud.example.com)',
    })
    .default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Root for volumes (<DATA_DIR>/volumes/*) and derived data such as thumbnails (<DATA_DIR>/cache). */
  DATA_DIR: z.string().default('./.dev-data'),
  /** 32+ random bytes (hex/base64). Signs short-lived tokens and encrypts TOTP secrets at rest. */
  SECRET_KEY: z
    .string()
    .min(32, 'SECRET_KEY must be at least 32 characters (use: openssl rand -hex 32)'),
  APP_NAME: z.string().min(1).max(60).default('Family Cloud'),
  /**
   * Domain passkeys belong to. Defaults to PUBLIC_URL's host; set the parent domain
   * (e.g. example.com for cloud.example.com) to share passkeys across its subdomains.
   */
  PASSKEY_RP_ID: z
    .string()
    .regex(/^[a-z0-9.-]+$/i)
    .optional(),
  /** proxy-addr trust list: which peers may set X-Forwarded-For / CF-Connecting-IP. */
  TRUSTED_PROXIES: z.string().default('loopback,uniquelocal'),
  /** Directory with the built web app. When unset the API runs headless (dev uses Vite). */
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  UPLOAD_CHUNK_SIZE: z.coerce
    .number()
    .int()
    .min(1 * MiB)
    .max(95 * 1000 * 1000)
    .default(DEFAULT_CHUNK_SIZE),
  /** Optional fixed first-run setup token; otherwise one is generated and logged. */
  SETUP_TOKEN: z.string().min(16).optional(),
  ENABLE_API_DOCS: bool,
  /** Multiplies every rate limit (tests raise it; keep 1 in production). */
  RATE_LIMIT_SCALE: z.coerce.number().min(0.1).max(10_000).default(1),
  WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(Math.max(1, Math.floor(cpus().length / 2))),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const publicUrl = new URL(e.PUBLIC_URL);
  if (
    e.PASSKEY_RP_ID &&
    publicUrl.hostname !== e.PASSKEY_RP_ID &&
    !publicUrl.hostname.endsWith(`.${e.PASSKEY_RP_ID}`)
  ) {
    throw new Error(
      `Invalid environment configuration:\n  PASSKEY_RP_ID: must be ${publicUrl.hostname} or a parent domain of it`,
    );
  }
  const dataDir = path.resolve(e.DATA_DIR);
  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    host: e.HOST,
    port: e.PORT,
    publicUrl: publicUrl.origin,
    publicOrigin: publicUrl.origin,
    cookieSecure: publicUrl.protocol === 'https:',
    databaseUrl: e.DATABASE_URL,
    dbPoolSize: e.DB_POOL_SIZE,
    dataDir,
    volumesRoot: path.join(dataDir, 'volumes'),
    cacheDir: path.join(dataDir, 'cache'),
    secretKey: e.SECRET_KEY,
    appName: e.APP_NAME,
    passkeyRpId: e.PASSKEY_RP_ID ?? publicUrl.hostname,
    trustedProxies: e.TRUSTED_PROXIES.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webDistDir: e.WEB_DIST_DIR ? path.resolve(e.WEB_DIST_DIR) : null,
    logLevel: e.LOG_LEVEL,
    chunkSize: e.UPLOAD_CHUNK_SIZE,
    setupToken: e.SETUP_TOKEN ?? null,
    enableApiDocs: e.ENABLE_API_DOCS ?? e.NODE_ENV !== 'production',
    workerConcurrency: e.WORKER_CONCURRENCY,
    rateLimitScale: e.RATE_LIMIT_SCALE,
  };
}
