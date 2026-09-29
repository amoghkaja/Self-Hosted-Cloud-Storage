import { randomUUID } from 'node:crypto';
import {
  BRAND_LOGO_MAX_BYTES,
  Branding,
  ErrorCode,
  UpdateBrandingBody,
  UploadLogoBody,
} from '@familycloud/shared/all';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import sharp from 'sharp';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { audit } from '../../lib/audit';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { requireAdmin } from '../../plugins/auth';

/**
 * The family's own look: a logo (stored in the database so it's part of every backup), the
 * word beside it, and a link back to their main website. Everything is optional; without it
 * the app shows the built-in cloud mark and APP_NAME.
 */
interface StoredBranding {
  wordmark?: string | null;
  homeUrl?: string | null;
  logo?: { mimeType: string; data: string; version: string } | null;
}

const KEY = 'branding';
const CACHE_MS = 5_000;
const cache = new WeakMap<AppContext, { at: number; value: Promise<StoredBranding> }>();

/**
 * Every page load, favicon and manifest request needs this, and the logo makes it up to a few
 * hundred KB, so it's cached briefly (saving here clears it at once).
 */
export function loadBranding(ctx: AppContext): Promise<StoredBranding> {
  const hit = cache.get(ctx);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = ctx.settings.getRaw<StoredBranding>(KEY).then((b) => b ?? {});
  cache.set(ctx, { at: Date.now(), value });
  value.catch(() => cache.delete(ctx));
  return value;
}

async function saveBranding(ctx: AppContext, next: StoredBranding): Promise<void> {
  await ctx.settings.setRaw(KEY, next);
  cache.delete(ctx);
}

export function publicBranding(ctx: AppContext, b: StoredBranding) {
  return {
    wordmark: b.wordmark ?? ctx.config.appName,
    logoVersion: b.logo?.version ?? null,
    homeUrl: b.homeUrl ?? null,
  };
}

function toDto(b: StoredBranding): Branding {
  return { wordmark: b.wordmark ?? null, homeUrl: b.homeUrl ?? null, hasLogo: !!b.logo };
}

/** Accepts only files that really are what they claim; SVGs must not carry script. */
function checkLogo(mimeType: string, bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > BRAND_LOGO_MAX_BYTES) {
    throw new AppError(413, ErrorCode.VALIDATION, 'The logo must be at most 256 KB');
  }
  if (
    mimeType === 'image/png' &&
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    throw badRequest('That file is not a PNG image');
  }
  if (
    mimeType === 'image/webp' &&
    !(bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
  ) {
    throw badRequest('That file is not a WebP image');
  }
  if (mimeType === 'image/svg+xml') {
    const text = bytes.toString('utf8');
    if (!/<svg[\s>]/i.test(text)) throw badRequest('That file is not an SVG image');
    // Served with a sandbox CSP anyway; refusing active content keeps a downloaded copy safe too.
    if (/<script|<foreignObject|\bon[a-z]+\s*=|javascript:/i.test(text)) {
      throw badRequest('The SVG contains scripts or event handlers; export it as a plain image');
    }
  }
}

/** Home-screen icon sizes: favicon/PWA icons, the iOS touch icon, and a maskable variant. */
const ICONS = { '180': 180, '192': 192, '512': 512, maskable: 512 } as const;
const ICON_BG = '#f6f1e7';
const iconCache = new Map<string, Buffer>();

/** The logo centred on a plain square: it's small and cached per logo version. */
async function renderIcon(logo: NonNullable<StoredBranding['logo']>, key: keyof typeof ICONS) {
  const cacheKey = `${logo.version}:${key}`;
  const hit = iconCache.get(cacheKey);
  if (hit) return hit;
  const size = ICONS[key];
  // Maskable icons get cropped to a circle by some launchers, so keep the logo in the safe zone.
  const inner = Math.round(size * (key === 'maskable' ? 0.6 : 0.8));
  const mark = await sharp(Buffer.from(logo.data, 'base64'), {
    density: 300,
    limitInputPixels: 4096 * 4096,
  })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const png = await sharp({
    create: { width: size, height: size, channels: 4, background: ICON_BG },
  })
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toBuffer();
  if (iconCache.size > 32) iconCache.clear();
  iconCache.set(cacheKey, png);
  return png;
}

export const brandingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  app.get(
    '/brand/icon/:size',
    {
      config: { rateLimit: false },
      schema: { params: z.object({ size: z.enum(['180', '192', '512', 'maskable']) }) },
    },
    async (req, reply) => {
      const logo = (await loadBranding(ctx)).logo;
      if (!logo) throw notFound('Icon');
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(await renderIcon(logo, req.params.size));
    },
  );

  // Public: the sign-in page shows the logo before anyone is signed in.
  app.get('/brand/logo', { config: { rateLimit: false } }, async (_req, reply) => {
    const logo = (await loadBranding(ctx)).logo;
    if (!logo) throw notFound('Logo');
    return reply
      .header('Content-Type', logo.mimeType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .send(Buffer.from(logo.data, 'base64'));
  });

  app.get('/admin/branding', { schema: { response: { 200: Branding } } }, async (req) => {
    requireAdmin(req);
    return toDto(await loadBranding(ctx));
  });

  app.patch(
    '/admin/branding',
    { schema: { body: UpdateBrandingBody, response: { 200: Branding } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const next = { ...(await loadBranding(ctx)), ...req.body };
      await saveBranding(ctx, next);
      await audit(ctx.db, {
        actorId: admin.id,
        action: 'admin.branding_updated',
        ip: req.clientIp,
      });
      return toDto(next);
    },
  );

  app.post(
    '/admin/branding/logo',
    { bodyLimit: 512 * 1024, schema: { body: UploadLogoBody, response: { 200: Branding } } },
    async (req) => {
      const { user: admin } = requireAdmin(req);
      const bytes = Buffer.from(req.body.data, 'base64');
      checkLogo(req.body.mimeType, bytes);
      const next: StoredBranding = {
        ...(await loadBranding(ctx)),
        logo: {
          mimeType: req.body.mimeType,
          data: bytes.toString('base64'),
          version: randomUUID(),
        },
      };
      await saveBranding(ctx, next);
      await audit(ctx.db, {
        actorId: admin.id,
        action: 'admin.branding_logo_set',
        ip: req.clientIp,
      });
      return toDto(next);
    },
  );

  app.delete('/admin/branding/logo', { schema: { response: { 200: Branding } } }, async (req) => {
    const { user: admin } = requireAdmin(req);
    const next: StoredBranding = { ...(await loadBranding(ctx)), logo: null };
    await saveBranding(ctx, next);
    await audit(ctx.db, {
      actorId: admin.id,
      action: 'admin.branding_logo_removed',
      ip: req.clientIp,
    });
    return toDto(next);
  });
};
