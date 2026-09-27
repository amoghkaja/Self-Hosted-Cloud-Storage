import { existsSync } from 'node:fs';
import path from 'node:path';
import { API_PREFIX, ErrorCode } from '@familycloud/shared';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { type AppContext, scrubUrl } from './context';
import { storageVolumes } from './db/schema';
import { createClientIpResolver } from './lib/client-ip';
import { adminRoutes } from './modules/admin/routes';
import { authRoutes } from './modules/auth/routes';
import { fileRoutes } from './modules/files/routes';
import { linkRoutes } from './modules/sharing/links';
import { sharingRoutes } from './modules/sharing/routes';
import { uploadRoutes } from './modules/uploads/routes';
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
    requestTimeout: 0, // large uploads/downloads may legitimately take long
    disableRequestLogging: false,
  });

  if (opts.logger !== false) {
    // Log URLs with share/invite tokens scrubbed.
    app.addHook('onRequest', async (req) => {
      req.log = req.log.child({ url: scrubUrl(req.url) });
    });
  }

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
      await api.register(fileRoutes);
      await api.register(uploadRoutes);
      await api.register(sharingRoutes);
      await api.register(linkRoutes);
      await api.register(adminRoutes);
      await api.register(appPasswordRoutes);
    },
    { prefix: API_PREFIX },
  );

  // Network drive (WebDAV) for Finder, Windows and iPhone/iPad Files-app helpers.
  await app.register(davRoutes);

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
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
    return reply.status(healthy ? 200 : 503).send({ ok: healthy, checks });
  });

  const webDist = ctx.config.webDistDir;
  const hasWeb = !!webDist && existsSync(path.join(webDist, 'index.html'));
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

  app.setNotFoundHandler(async (req, reply) => {
    const accept = req.headers.accept ?? '';
    if (
      hasWeb &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.url.startsWith('/api/') &&
      accept.includes('text/html')
    ) {
      // Client-side routes (/files/…, /s/<token>) all render the SPA shell.
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return sendProblem(reply, 404, ErrorCode.NOT_FOUND, 'Not found');
  });

  return app;
}
