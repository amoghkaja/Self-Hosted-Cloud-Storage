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
