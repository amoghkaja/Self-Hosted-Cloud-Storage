import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { forbidden, unauthenticated } from '../lib/errors';
import type { AuthContext } from '../lib/sessions';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
    clientIp: string;
  }
}

export function sessionCookieName(ctx: AppContext): string {
  // __Host- cookies must be Secure, Path=/ and have no Domain: they cannot be set by subdomains.
  return ctx.config.cookieSecure ? '__Host-fc_session' : 'fc_session';
}

export function setSessionCookie(
  ctx: AppContext,
  reply: FastifyReply,
  token: string,
  expires: Date,
) {
  reply.setCookie(sessionCookieName(ctx), token, {
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply) {
  reply.clearCookie(sessionCookieName(ctx), {
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}

export function requestMeta(req: FastifyRequest) {
  const ua = req.headers['user-agent'];
  return { ip: req.clientIp, userAgent: typeof ua === 'string' ? ua : null };
}

/** Resolves the session cookie on every API request (before the body is read). */
export function registerAuth(app: FastifyInstance) {
  const ctx = app.ctx;
  const cookie = sessionCookieName(ctx);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[cookie];
    req.auth = token ? await ctx.sessions.resolve(token) : null;
  });
}

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}

export function requireAdmin(req: FastifyRequest): AuthContext {
  const auth = requireUser(req);
  if (auth.user.role !== 'admin') throw forbidden('Admins only');
  return auth;
}
