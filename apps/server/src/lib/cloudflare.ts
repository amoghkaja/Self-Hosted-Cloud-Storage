import { randomBytes } from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4';

/** What the API token needs, in the words of Cloudflare's "Create Custom Token" page. */
export const TUNNEL_TOKEN_PERMISSIONS = [
  'Account · Cloudflare Tunnel · Edit',
  'Zone · DNS · Edit',
  'Zone · Zone · Read',
];

export class CloudflareError extends Error {}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Envelope<T> {
  success?: boolean;
  errors?: { code: number; message: string }[];
  result?: T;
}

interface Zone {
  id: string;
  name: string;
  account: { id: string };
}
interface Ingress {
  hostname?: string;
  service: string;
  [k: string]: unknown;
}
interface DnsRecord {
  id: string;
  type: string;
  content: string;
}

export interface TunnelOptions {
  /** A Cloudflare API token (see TUNNEL_TOKEN_PERMISSIONS). Used once; never stored. */
  apiToken: string;
  /** The address the family will use, e.g. cloud.example.com. */
  hostname: string;
  /** Where cloudflared sends visitors: the app container on the compose network. */
  service?: string;
  /** The tunnel's name in the dashboard; an existing tunnel of that name is reused. */
  name?: string;
  fetch?: Fetch;
  log?: (line: string) => void;
}

/**
 * Sets up a Cloudflare Tunnel for Family Cloud end to end, as the dashboard steps in
 * docs/cloudflare-tunnel.md would: finds the hostname's zone, creates (or reuses) the tunnel,
 * routes the hostname to the app and adds the DNS record. Returns the token cloudflared runs
 * with. Safe to run again: everything it finds already in place is kept.
 */
export async function setupTunnel(o: TunnelOptions): Promise<{ tunnelId: string; token: string }> {
  const f = o.fetch ?? fetch;
  const log = o.log ?? (() => {});
  const name = o.name ?? 'familycloud';
  const service = o.service ?? 'http://app:3000';
  const hostname = o.hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
    throw new CloudflareError(`"${o.hostname}" isn't a host name like cloud.example.com`);
  }

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await f(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${o.apiToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CloudflareError(
        "Couldn't reach Cloudflare. Check this computer's internet connection.",
      );
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (res.ok && json?.success) return json.result as T;
    const detail = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    // 6003: the header itself is malformed (not a token at all); 9109: unknown or revoked token.
    if (json?.errors?.some((e) => e.code === 6003 || e.code === 9109)) {
      throw new CloudflareError(
        "That isn't a working Cloudflare API token. Copy it again from dash.cloudflare.com/profile/api-tokens (it's shown only once when created).",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new CloudflareError(
        `Cloudflare refused the API token (${detail}). It needs: ${TUNNEL_TOKEN_PERMISSIONS.join(', ')}.`,
      );
    }
    throw new CloudflareError(`Cloudflare said: ${detail}`);
  };

  // The zone is the longest suffix of the hostname that's a domain on this account.
  const labels = hostname.split('.');
  let zone: Zone | undefined;
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const candidate = labels.slice(i).join('.');
    [zone] = await call<Zone[]>('GET', `/zones?name=${encodeURIComponent(candidate)}`);
  }
  if (!zone) {
    throw new CloudflareError(
      `None of ${hostname}'s domains are on this Cloudflare account, or the token can't see them. ` +
        'Add the domain to Cloudflare first, and give the token access to it.',
    );
  }
  const account = zone.account.id;
  log(`Domain ${zone.name} found on Cloudflare.`);

  const [existing] = await call<{ id: string }[]>(
    'GET',
    `/accounts/${account}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
  );
  let tunnelId = existing?.id;
  if (tunnelId) {
    log(`Using the existing tunnel "${name}".`);
  } else {
    const made = await call<{ id: string }>('POST', `/accounts/${account}/cfd_tunnel`, {
      name,
      config_src: 'cloudflare',
      tunnel_secret: randomBytes(32).toString('base64'),
    });
    tunnelId = made.id;
    log(`Created the tunnel "${name}".`);
  }

  // Route the hostname to the app, keeping any other routes the tunnel already has.
  const current = await call<{ config?: { ingress?: Ingress[] } } | null>(
    'GET',
    `/accounts/${account}/cfd_tunnel/${tunnelId}/configurations`,
  );
  const others = (current?.config?.ingress ?? []).filter(
    (r) => r.hostname && r.hostname !== hostname,
  );
  await call('PUT', `/accounts/${account}/cfd_tunnel/${tunnelId}/configurations`, {
    config: {
      ...current?.config,
      ingress: [...others, { hostname, service }, { service: 'http_status:404' }],
    },
  });
  log(`${hostname} goes to Family Cloud.`);

  // The DNS record: never replace one that points somewhere else (it may be the family's email
  // or website).
  const target = `${tunnelId}.cfargotunnel.com`;
  const records = await call<DnsRecord[]>(
    'GET',
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`,
  );
  if (records.length === 0) {
    await call('POST', `/zones/${zone.id}/dns_records`, {
      type: 'CNAME',
      name: hostname,
      content: target,
      proxied: true,
      comment: 'Family Cloud tunnel',
    });
    log(`Added the DNS record for ${hostname}.`);
  } else if (!records.some((r) => r.type === 'CNAME' && r.content === target)) {
    const r = records[0]!;
    throw new CloudflareError(
      `${hostname} already has a DNS record (${r.type} → ${r.content}). Delete it in the ` +
        'Cloudflare dashboard if nothing else uses it, or choose another address, then try again.',
    );
  }

  const token = await call<string>('GET', `/accounts/${account}/cfd_tunnel/${tunnelId}/token`);
  return { tunnelId, token };
}
