import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { API_PREFIX, ErrorCode } from '@familycloud/shared/all';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AppContext } from './context';
import { storageVolumes } from './db/schema';
import { createClientIpResolver } from './lib/client-ip';
import { renderShell } from './lib/shell';
import { brandingRoutes, loadBranding } from './modules/admin/branding';
import { adminRoutes } from './modules/admin/routes';
import { passkeyRoutes } from './modules/auth/passkeys';
import { authRoutes } from './modules/auth/routes';
import { fileRoutes } from './modules/files/routes';
import { photoRoutes } from './modules/photos/routes';
import { linkRoutes } from './modules/sharing/links';
import { requestRoutes } from './modules/sharing/requests';
import { sharingRoutes } from './modules/sharing/routes';
import { uploadRoutes } from './modules/uploads/routes';
import { versionRoutes } from './modules/versions/routes';
import { appPasswordRoutes } from './modules/webdav/app-passwords';
import { DAV_METHODS, davRoutes } from './modules/webdav/routes';
import { registerAuth } from './plugins/auth';
import { registerErrorHandling, sendProblem } from './plugins/errors';
import { registerSecurity } from './plugins/security';

export async function buildApp(
  ctx: AppContext,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.logger === false ? undefined : (ctx.log as unknown as FastifyBaseLogger),
    trustProxy: ctx.config.trustedProxies,
    bodyLimit: 1024 * 1024, // JSON bodies only; upload chunks bypass the parser
    routerOptions: { maxParamLength: 4096 }, // deep WebDAV paths travel in the wildcard param
    // Generous (1 h) for big WebDAV uploads on slow links, but bounded so slow-body clients
    // can't pin connections forever. Chunked web uploads finish each request in minutes.
    requestTimeout: 60 * 60 * 1000,
  });

  for (const method of DAV_METHODS) {
    app.addHttpMethod(method, { hasBody: method !== 'UNLOCK' });
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('ctx', ctx);

  const clientIp = createClientIpResolver(ctx.config.trustedProxies);
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (req) => {
    req.clientIp = clientIp(req);
  });

  // API and WebDAV answers are per-person: no browser or Cloudflare edge may store them. Routes
  // that serve file bytes set their own policy (ETag revalidation, immutable thumbnails).
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('cache-control') && /^\/(api|dav)(\/|\?|$)/.test(req.url)) {
      reply.header('Cache-Control', 'private, no-store');
    }
    return payload;
  });

  // Only JSON (and raw chunks, registered in the uploads module) are accepted as bodies.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie);
  registerErrorHandling(app);
  registerAuth(app);
  await registerSecurity(app);

  if (ctx.config.enableApiDocs) {
    const swagger = (await import('@fastify/swagger')).default;
    const swaggerUi = (await import('@fastify/swagger-ui')).default;
    await app.register(swagger, {
      openapi: {
        info: { title: `${ctx.config.appName} API`, version: '1.0.0' },
        components: {
          securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'fc_session' } },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/api/docs' });
  }

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(passkeyRoutes);
      await api.register(fileRoutes);
      await api.register(uploadRoutes);
      await api.register(versionRoutes);
      await api.register(sharingRoutes);
      await api.register(linkRoutes);
      await api.register(requestRoutes);
      await api.register(adminRoutes);
      await api.register(photoRoutes);
      await api.register(brandingRoutes);
      await api.register(appPasswordRoutes);
    },
    { prefix: API_PREFIX },
  );

  // Network drive (WebDAV) for Finder, Windows and iPhone/iPad Files-app helpers.
  await app.register(davRoutes);

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { rateLimit: false } }, async (req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await ctx.db.execute(sql`select 1`);
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
    }
    const vols = await ctx.db
      .select()
      .from(storageVolumes)
      .catch(() => []);
    for (const v of vols) {
      if (v.status === 'retired') continue;
      checks[`volume:${v.name}`] = (await ctx.volumes.status(v)).online ? 'ok' : 'offline';
    }
    const healthy = Object.values(checks).every((c) => c === 'ok');
    // Details (disk names) only for the machine itself / the LAN; the internet sees ok/not ok.
    const local =
      /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])/i.test(
        req.clientIp,
      );
    return reply
      .status(healthy ? 200 : 503)
      .send(local ? { ok: healthy, checks } : { ok: healthy });
  });

  const webDist = ctx.config.webDistDir;
  const hasWeb = !!webDist && existsSync(path.join(webDist, 'index.html'));
  const shellHtml = hasWeb ? readFileSync(path.join(webDist, 'index.html'), 'utf8') : '';
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      preCompressed: true, // serves .br/.gz siblings produced by the build
      setHeaders(res, filePath) {
        // Hashed assets never change; everything else must revalidate.
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  // Browsers and link previewers ask for this without reading the page.
  app.get('/favicon.ico', { config: { rateLimit: false } }, async (_req, reply) => {
    const logo = (await loadBranding(ctx)).logo;
    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .redirect(
        logo
          ? `${API_PREFIX}/brand/icon/192?v=${encodeURIComponent(logo.version)}`
          : '/icon-192.png',
      );
  });

  // Web-app manifest built from APP_NAME, so "Add to Home Screen" shows the family's name.
  app.get('/manifest.webmanifest', { config: { rateLimit: false } }, async (_req, reply) => {
    const name = ctx.config.appName;
    const logo = (await loadBranding(ctx)).logo;
    const icon = (size: string) => `${API_PREFIX}/brand/icon/${size}?v=${logo?.version}`;
    reply.header('Cache-Control', 'no-cache').type('application/manifest+json');
    return {
      name,
      short_name:
        name.length > 12 ? name.replace(/\s*cloud$/i, '').slice(0, 12) || name.slice(0, 12) : name,
      description: `${name}: your family's private cloud storage.`,
      start_url: '/files',
      scope: '/',
      display: 'standalone',
      background_color: '#f6f1e7',
      theme_color: '#f6f1e7',
      icons: logo
        ? [
            { src: icon('192'), sizes: '192x192', type: 'image/png' },
            { src: icon('512'), sizes: '512x512', type: 'image/png' },
            { src: icon('maskable'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ]
        : [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
    };
  });

  app.setNotFoundHandler(async (req, reply) => {
    const accept = req.headers.accept ?? '';
    // Link previewers (WhatsApp and others) often ask for */* rather than HTML; a page address
    // has no file extension, a missing asset does.
    const wantsPage =
      accept.includes('text/html') ||
      (accept.includes('*/*') && !path.extname(req.url.split('?')[0] ?? ''));
    if (
      hasWeb &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.url.startsWith('/api/') &&
      wantsPage
    ) {
      // Client-side routes (/files/…, /s/<token>) all render the SPA shell.
      const logo = (await loadBranding(ctx)).logo;
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(
          renderShell(shellHtml, {
            appName: ctx.config.appName,
            publicUrl: ctx.config.publicUrl,
            logoVersion: logo?.version ?? null,
            sharePage: req.url.startsWith('/s/'),
          }),
        );
    }
    return sendProblem(reply, 404, ErrorCode.NOT_FOUND, 'Not found');
  });

  return app;
}
