import { describe, expect, it } from 'vitest';
import { CloudflareError, setupTunnel } from '../src/lib/cloudflare';

/** A tiny in-memory Cloudflare API: one account, the zones given, and whatever gets created. */
function fakeCloudflare(opts: {
  zones?: string[];
  tunnels?: { id: string; name: string; ingress?: unknown[] }[];
  records?: { name: string; type: string; content: string }[];
  status?: number;
}) {
  const zones = (opts.zones ?? ['example.com']).map((name, i) => ({
    id: `zone${i}`,
    name,
    account: { id: 'acct' },
  }));
  const tunnels = opts.tunnels ?? [];
  const records = opts.records ?? [];
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace('/client/v4', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path: `${path}${u.search}`,
      body,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    if (opts.status) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
        }),
        { status: opts.status },
      );
    }
    if (path === '/zones') return ok(zones.filter((z) => z.name === u.searchParams.get('name')));
    if (path === '/accounts/acct/cfd_tunnel' && method === 'GET') {
      return ok(tunnels.filter((t) => t.name === u.searchParams.get('name')));
    }
    if (path === '/accounts/acct/cfd_tunnel' && method === 'POST') {
      const t = { id: 'new-tunnel', name: body.name };
      tunnels.push(t);
      return ok(t);
    }
    const m = /^\/accounts\/acct\/cfd_tunnel\/([^/]+)\/(configurations|token)$/.exec(path);
    if (m) {
      const t = tunnels.find((x) => x.id === m[1])!;
      if (m[2] === 'token') return ok(`token-for-${t.id}`);
      if (method === 'PUT') {
        t.ingress = body.config.ingress;
        return ok({});
      }
      return ok(t.ingress ? { config: { ingress: t.ingress } } : null);
    }
    const d = /^\/zones\/([^/]+)\/dns_records$/.exec(path);
    if (d && method === 'GET')
      return ok(records.filter((r) => r.name === u.searchParams.get('name')));
    if (d && method === 'POST') {
      records.push(body);
      return ok({ id: 'rec' });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls, tunnels, records };
}

describe('Cloudflare Tunnel setup', () => {
  it('creates the tunnel, routes the address to the app and adds the DNS record', async () => {
    const cf = fakeCloudflare({ zones: ['smith.family'] });
    const log: string[] = [];
    const r = await setupTunnel({
      apiToken: 'api-token',
      hostname: 'Cloud.Smith.Family',
      fetch: cf.fetch,
      log: (l) => log.push(l),
    });
    expect(r).toEqual({ tunnelId: 'new-tunnel', token: 'token-for-new-tunnel' });
    expect(cf.calls.every((c) => c.auth === 'Bearer api-token')).toBe(true);
    // Found the zone by trying the full name, then its parent.
    expect(cf.calls.slice(0, 2).map((c) => c.path)).toEqual([
      '/zones?name=cloud.smith.family',
      '/zones?name=smith.family',
    ]);
    expect(cf.tunnels[0]!.ingress).toEqual([
      { hostname: 'cloud.smith.family', service: 'http://app:3000' },
      { service: 'http_status:404' },
    ]);
    expect(cf.records).toEqual([
      expect.objectContaining({
        type: 'CNAME',
        name: 'cloud.smith.family',
        content: 'new-tunnel.cfargotunnel.com',
        proxied: true,
      }),
    ]);
    expect(log.join('\n')).toMatch(/Created the tunnel/);
  });

  it('reuses an existing tunnel and keeps its other routes, and is safe to run again', async () => {
    const cf = fakeCloudflare({
      tunnels: [
        {
          id: 't1',
          name: 'familycloud',
          ingress: [
            { hostname: 'photos.example.com', service: 'http://other:80' },
            { hostname: 'cloud.example.com', service: 'http://old:1' },
            { service: 'http_status:404' },
          ],
        },
      ],
    });
    for (let i = 0; i < 2; i++) {
      const r = await setupTunnel({
        apiToken: 't',
        hostname: 'cloud.example.com',
        fetch: cf.fetch,
      });
      expect(r.token).toBe('token-for-t1');
    }
    expect(cf.calls.some((c) => c.method === 'POST' && c.path.endsWith('/cfd_tunnel'))).toBe(false);
    expect(cf.tunnels[0]!.ingress).toEqual([
      { hostname: 'photos.example.com', service: 'http://other:80' },
      { hostname: 'cloud.example.com', service: 'http://app:3000' },
      { service: 'http_status:404' },
    ]);
    // The record was added once, then found in place.
    expect(cf.records).toHaveLength(1);
  });

  it('never replaces a DNS record that points somewhere else', async () => {
    const cf = fakeCloudflare({
      records: [{ name: 'cloud.example.com', type: 'A', content: '203.0.113.7' }],
    });
    await expect(
      setupTunnel({ apiToken: 't', hostname: 'cloud.example.com', fetch: cf.fetch }),
    ).rejects.toThrow(/already has a DNS record \(A → 203\.0\.113\.7\)/);
    expect(cf.records).toHaveLength(1);
  });

  it('explains a domain that is not on the account, a token without permission, and bad names', async () => {
    const cf = fakeCloudflare({ zones: ['other.org'] });
    await expect(
      setupTunnel({ apiToken: 't', hostname: 'cloud.example.com', fetch: cf.fetch }),
    ).rejects.toThrow(/None of cloud\.example\.com's domains are on this Cloudflare account/);
    // It never asks about the bare top-level domain.
    expect(cf.calls.map((c) => c.path)).not.toContain('/zones?name=com');

    const denied = fakeCloudflare({ status: 403 });
    await expect(
      setupTunnel({ apiToken: 't', hostname: 'cloud.example.com', fetch: denied.fetch }),
    ).rejects.toThrow(/refused the API token.*Cloudflare Tunnel · Edit/);

    // Cloudflare's answer to a mistyped or revoked token.
    const bogus = async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 9109, message: 'Invalid access token' }],
        }),
        { status: 400 },
      );
    await expect(
      setupTunnel({ apiToken: 'x', hostname: 'cloud.example.com', fetch: bogus }),
    ).rejects.toThrow(/isn't a working Cloudflare API token/);

    await expect(
      setupTunnel({ apiToken: 't', hostname: 'https://cloud.example.com/' }),
    ).rejects.toThrow(CloudflareError);
  });
});
