import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgBossQueue } from '../src/jobs/queue';

let queue: PgBossQueue;
let drop: () => Promise<void>;

beforeAll(async () => {
  const base = inject('pgBase');
  const dbName = `q_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  queue = await PgBossQueue.connect(`${base}/${dbName}`, { worker: false, onError: () => {} });
  drop = async () => {
    await queue.stop();
    await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  };
});
afterAll(async () => {
  await drop();
});

const queued = async (name: string) => (await queue.boss.findJobs(name)).length;

describe('job queue', () => {
  it('keeps one waiting thumbnail/hash job per blob and one drain job per volume', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
      await queue.send('thumbnail', { blobId: a });
      await queue.send('hash', { blobId: a });
      await queue.send('drain-volume', { volumeId: a });
    }
    await queue.send('thumbnail', { blobId: b });
    await queue.send('hash', { blobId: b });
    expect(await queued('thumbnail')).toBe(2);
    expect(await queued('hash')).toBe(2);
    expect(await queued('drain-volume')).toBe(1);
  });

  it('does not de-duplicate jobs that have no subject', async () => {
    await queue.send('purge-trash', {});
    await queue.send('purge-trash', {});
    expect(await queued('purge-trash')).toBe(2);
  });
});
