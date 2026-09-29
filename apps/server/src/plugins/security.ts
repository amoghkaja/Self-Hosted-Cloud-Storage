import { ErrorCode } from '@familycloud/shared/all';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rateLimitKey } from '../lib/client-ip';
import { AppError } from '../lib/errors';
import { sessionCookieName } from './auth';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function registerSecurity(app: FastifyInstance) {
  const { config } = app.ctx;

  await app.register(helmet, {
    // Strict CSP for the SPA. File responses set their own sandboxed CSP (see send-blob.ts).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // wasm-unsafe-eval allows compiling WebAssembly only (the file checksum used for instant
        // uploads), not eval() or inline scripts.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        // Radix/sonner inject small <style> tags at runtime; styles cannot execute script.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: config.cookieSecure
      ? { maxAge: 31_536_000, includeSubDomains: false }
      : false,
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // A family's private cloud (and its share links) should never show up in search engines.
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  });

  app.get('/robots.txt', { config: { rateLimit: false } }, async (_req, reply) =>
    reply
      .type('text/plain')
      .header('Cache-Control', 'public, max-age=86400')
      .send('User-agent: *\nDisallow: /\n'),
  );

  // CSRF: state-changing API calls must come from our own origin. Browsers always send Origin on
  // non-GET requests, and SameSite=Lax cookies already block most cross-site sends; this is the
  // belt to that pair of braces. Non-browser clients without cookies are unaffected.
  const cookie = sessionCookieName(app.ctx);
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;
    const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
    if (origin) {
      if (origin !== config.publicOrigin) {
        throw new AppError(403, ErrorCode.CSRF, 'Cross-site request rejected');
      }
    } else if (req.cookies[cookie]) {
      throw new AppError(403, ErrorCode.CSRF, 'Missing Origin header');
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: Math.round(1200 * config.rateLimitScale),
    timeWindow: '1 minute',
    keyGenerator: (req) => rateLimitKey(req.clientIp),
    errorResponseBuilder: (_req, context) =>
      new AppError(
        429,
        ErrorCode.RATE_LIMITED,
        `Too many requests. Try again in ${context.after}.`,
      ) as unknown as object,
  });
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/** Per-route limit for credential endpoints (login, unlock, setup, invites). */
export const strictLimit = (max = 10) => ({
  rateLimit: {
    max: (req: FastifyRequest) => Math.round(max * req.server.ctx.config.rateLimitScale),
    timeWindow: '1 minute',
  },
});
