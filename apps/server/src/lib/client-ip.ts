import { isIPv6 } from 'node:net';
import type { FastifyRequest } from 'fastify';
import proxyaddr from 'proxy-addr';

/**
 * Resolves the real client IP. `CF-Connecting-IP` (set by Cloudflare) and `X-Forwarded-For` are
 * only honoured when the TCP peer is a trusted proxy (cloudflared/caddy on the Docker network);
 * otherwise anyone could spoof their IP and dodge rate limits.
 */
export function createClientIpResolver(trusted: string[]) {
  const isTrusted = proxyaddr.compile(trusted);
  return (req: FastifyRequest): string => {
    const peer = req.socket.remoteAddress ?? '';
    if (peer && isTrusted(peer, 0)) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && cf.length > 0 && cf.length <= 64) return cf.trim();
    }
    // Fastify's trustProxy (same list) already resolved X-Forwarded-For hops into req.ip.
    return req.ip || peer;
  };
}

/**
 * Rate-limit bucket for a client IP. An IPv6 connection comes with at least a /64 of its own,
 * so keying by the full address would let one client rotate through billions of "different"
 * IPs and ignore per-IP limits. IPv6 is bucketed by /64; IPv4 (and IPv4-mapped IPv6) by address.
 */
export function rateLimitKey(ip: string): string {
  const addr = ip.split('%')[0]!.toLowerCase(); // drop a zone index (fe80::1%eth0)
  if (!isIPv6(addr)) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;
  const [head = '', tail] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded dotted IPv4 tail (64:ff9b::1.2.3.4) stands for two groups.
  const groups = left.length + right.length + (right.at(-1)?.includes('.') ? 1 : 0);
  const full = [...left, ...Array<string>(Math.max(0, 8 - groups)).fill('0'), ...right];
  const prefix = full.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}
