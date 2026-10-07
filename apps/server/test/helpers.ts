import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Me, UploadSession } from '@familycloud/shared/all';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import postgres from 'postgres';
import { inject } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { type AppContext, createContext } from '../src/context';
import { MemoryQueue } from '../src/jobs/queue';

export const ORIGIN = 'http://localhost:5173';
export const SETUP_TOKEN = 'test-setup-token-0123456789';
export const CHUNK = 1024 * 1024;

export interface TestEnv {
  app: FastifyInstance;
  ctx: AppContext;
  jobs: MemoryQueue;
  dataDir: string;
  close(): Promise<void>;
}

export async function createTestEnv(env: Record<string, string> = {}): Promise<TestEnv> {
  const base = inject('pgBase');
  const dbName = `t_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName} TEMPLATE fc_template`);
  await admin.end();

  const dataDir = await mkdtemp(path.join(tmpdir(), 'fc-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: `${base}/${dbName}`,
    DATA_DIR: dataDir,
    SECRET_KEY: 'test-secret-key-that-is-at-least-32-chars',
    PUBLIC_URL: ORIGIN,
    LOG_LEVEL: 'silent',
    UPLOAD_CHUNK_SIZE: String(CHUNK),
    SETUP_TOKEN,
    DB_POOL_SIZE: '5',
    RATE_LIMIT_SCALE: '1000',
    ...env,
  });
  const jobs = new MemoryQueue();
  const ctx = await createContext(config, {
    role: 'api',
    jobs,
    log: pino({ level: 'silent' }),
    migrate: false,
  });
  const app = await buildApp(ctx, { logger: false });
  await app.ready();
  return {
    app,
    ctx,
    jobs,
    dataDir,
    async close() {
      await app.close();
      await ctx.close();
      const a = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

type Json = Record<string, unknown> | unknown[];

export interface Res<T = any> {
  status: number;
  body: T;
  headers: LightMyRequestResponse['headers'];
  raw: LightMyRequestResponse;
}

/** A browser-like client: keeps cookies and sends our Origin header. */
export class Client {
  cookies = new Map<string, string>();
  /** The account's password, for steps that ask for it again (setupAdmin and addMember set it). */
  password?: string;
  constructor(private readonly app: FastifyInstance) {}

  async req<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD',
    url: string,
    opts: { json?: Json; body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { origin: ORIGIN, ...opts.headers };
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (opts.json !== undefined) headers['content-type'] = 'application/json';
    if (opts.body !== undefined) headers['content-type'] ??= 'application/octet-stream';
    const raw = await this.app.inject({
      method,
      url: /^\/(api|healthz|readyz)/.test(url) ? url : `/api/v1${url}`,
      headers,
      payload: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    });
    for (const c of raw.cookies as {
      name: string;
      value: string;
      expires?: Date;
      maxAge?: number;
    }[]) {
      const expired =
        (c.expires && c.expires.getTime() < Date.now()) || c.maxAge === 0 || c.value === '';
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const type = String(raw.headers['content-type'] ?? '');
    const body = type.includes('json') ? raw.json() : (raw.rawPayload as unknown);
    return { status: raw.statusCode, body: body as T, headers: raw.headers, raw };
  }

  get<T = any>(url: string, headers?: Record<string, string>) {
    return this.req<T>('GET', url, headers ? { headers } : {});
  }
  post<T = any>(url: string, json: Json = {}) {
    return this.req<T>('POST', url, { json });
  }
  patch<T = any>(url: string, json: Json) {
    return this.req<T>('PATCH', url, { json });
  }
  del<T = any>(url: string) {
    return this.req<T>('DELETE', url);
  }
}

export const ADMIN_PASSWORD = 'correct horse battery';
export const MEMBER_PASSWORD = 'another long password';

export async function setupAdmin(env: TestEnv, email = 'admin@example.com') {
  const client = new Client(env.app);
  const res = await client.post<Me>('/auth/setup', {
    setupToken: SETUP_TOKEN,
    email,
    displayName: 'Admin',
    password: ADMIN_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
  client.password = ADMIN_PASSWORD;
  return { client, me: res.body };
}

export async function addMember(
  env: TestEnv,
  admin: Client,
  email: string,
  opts: { quotaBytes?: number | null; role?: 'admin' | 'member' } = {},
) {
  const inv = await admin.post('/admin/invites', {
    email,
    role: opts.role ?? 'member',
    quotaBytes: opts.quotaBytes === undefined ? null : opts.quotaBytes,
  });
  if (inv.status !== 200) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const token = String(inv.body.url).split('/invite/')[1]!;
  const client = new Client(env.app);
  const res = await client.post<Me>(`/invites/${token}/accept`, {
    email,
    displayName: email.split('@')[0],
    password: MEMBER_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`accept failed: ${JSON.stringify(res.body)}`);
  client.password = MEMBER_PASSWORD;
  return { client, me: res.body };
}

/** Uploads `data` through the chunked API (optionally out of order / in parallel). */
export async function uploadFile(
  client: Client,
  parentId: string,
  name: string,
  data: Buffer,
  opts: {
    mimeType?: string;
    order?: 'forward' | 'reverse' | 'parallel';
    onConflict?: 'rename' | 'replace';
  } = {},
) {
  const created = await client.post<UploadSession>('/uploads', {
    parentId,
    name,
    size: data.length,
    ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
    ...(opts.onConflict ? { onConflict: opts.onConflict } : {}),
  });
  if (created.status !== 200) return { created, final: null };
  const s = created.body;
  const indexes = Array.from({ length: s.totalChunks }, (_, i) => i);
  if (opts.order === 'reverse') indexes.reverse();
  const send = (i: number) =>
    client.req('PUT', `/uploads/${s.id}/chunks/${i}`, {
      body: data.subarray(i * s.chunkSize, Math.min(data.length, (i + 1) * s.chunkSize)),
    });
  let final: Res | null = null;
  if (opts.order === 'parallel') {
    const results = await Promise.all(indexes.map(send));
    final = results.find((r) => r.body?.node) ?? results[results.length - 1]!;
  } else {
    for (const i of indexes) final = await send(i);
  }
  return { created, final, session: s };
}

export function bytes(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x & 0xff;
  }
  return b;
}
