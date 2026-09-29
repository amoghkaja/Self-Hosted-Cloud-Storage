import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ PUBLIC_URL: 'https://cloud.example.test' });
});
afterAll(async () => {
  await env.close();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'GET', url, headers });

describe('https only', () => {
  it('sends visitors who came in over http to the https address', async () => {
    const res = await get('/files/abc?x=1', { 'x-forwarded-proto': 'http' });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe('https://cloud.example.test/files/abc?x=1');
  });

  it('never redirects to the Host the request claims', async () => {
    const res = await get('/login', { 'x-forwarded-proto': 'http', host: 'evil.example' });
    expect(res.headers.location).toBe('https://cloud.example.test/login');
  });

  it('keeps POSTs (and their method) on the way over', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-proto': 'http', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(308);
  });

  it('leaves https and direct (health check, LAN) requests alone', async () => {
    expect((await get('/healthz', { 'x-forwarded-proto': 'https' })).statusCode).toBe(200);
    expect((await get('/healthz')).statusCode).toBe(200);
    expect((await get('/api/v1/auth/setup-status')).headers['strict-transport-security']).toMatch(
      /max-age=31536000/,
    );
  });
});
