import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, options: { max?: number; appName?: string } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 60,
    connection: { TimeZone: 'UTC', application_name: options.appName ?? 'familycloud' },
    onnotice: () => {},
    // int8 -> JS number. Byte counts stay far below 2^53 (8 PiB).
    types: {
      int8: {
        to: 20,
        from: [20],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
    },
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Executor = Db | Tx;
export type SqlClient = ReturnType<typeof createDb>['client'];

function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/db/migrations in dev; dist/migrations in the bundled build.
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')];
  const found = candidates.find((c) => existsSync(path.join(c, 'meta', '_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

const MIGRATION_LOCK = 727_001;

/** Runs pending migrations. Safe to call from several processes at once (advisory lock). */
export async function runMigrations(db: Db, client: SqlClient): Promise<void> {
  const conn = await client.reserve();
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(db, { migrationsFolder: migrationsFolder() });
  } finally {
    await conn`select pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => {});
    conn.release();
  }
}
