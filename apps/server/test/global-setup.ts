import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { createDb, runMigrations } from '../src/db/client';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Postgres server URL without a database name, e.g. postgres://u:p@127.0.0.1:5432 */
    pgBase: string;
  }
}

export const TEMPLATE_DB = 'fc_template';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Starts a throwaway Postgres (or uses TEST_DATABASE_URL in CI) and builds a migrated template
 * database. Each test file clones the template, so files run in parallel in isolation.
 */
export default async function setup(project: TestProject) {
  let base = process.env.TEST_DATABASE_URL?.replace(/\/[^/]*$/, '');
  let stop = async () => {};
  if (!base) {
    const known = new Set(process.listeners('beforeExit'));
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    // Its exit hook calls process.exit(0) on `beforeExit`, which turns a failing run green. The
    // teardown below stops the cluster instead.
    for (const listener of process.listeners('beforeExit')) {
      if (!known.has(listener)) process.off('beforeExit', listener);
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'fc-pg-'));
    const port = await freePort();
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      // Postgres refuses to run as root, so under root (a dev container) it runs as the `postgres`
      // user, which needs to own the data directory.
      createPostgresUser: process.getuid?.() === 0,
      // The natural-sort ICU collation needs UTF-8; a C/POSIX locale would make initdb pick SQL_ASCII.
      initdbFlags: ['--encoding=UTF8', '--locale=C.UTF-8'],
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    base = `postgres://postgres:postgres@127.0.0.1:${port}`;
    stop = async () => {
      await pg.stop();
      await rm(dir, { recursive: true, force: true });
    };
  }

  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
  await admin.unsafe(`CREATE DATABASE ${TEMPLATE_DB}`);
  const { db, client } = createDb(`${base}/${TEMPLATE_DB}`, { max: 2 });
  await runMigrations(db, client);
  await client.end();
  await admin.end();

  project.provide('pgBase', base);
  return stop;
}
