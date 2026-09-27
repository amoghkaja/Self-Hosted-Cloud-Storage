/**
 * Local Postgres for development without Docker: `pnpm dev:db`.
 * Data persists in <repo>/.dev-data/pg. Stop with Ctrl+C.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

const root = path.resolve(import.meta.dirname, '../../..');
const dir = path.join(root, '.dev-data', 'pg');
const port = Number(process.env.DEV_DB_PORT ?? 54320);

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
});

if (!existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
const admin = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
  max: 1,
  onnotice: () => {},
});
const [exists] = await admin`select 1 from pg_database where datname = 'familycloud'`;
if (!exists) await admin.unsafe('CREATE DATABASE familycloud');
await admin.end();

console.info(
  `Postgres ready: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/familycloud`,
);
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
