import { readFile } from 'node:fs/promises';
import { About, type ReleaseNotes } from '@familycloud/shared/all';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { parseChangelog } from '../../lib/changelog';
import { requireUser } from '../../plugins/auth';

/** Steps for whoever runs the server; nothing a family member can act on. */
const ADMIN_ONLY = 'Before you update';

/** The running version and what changed in each release, for the What's new page. */
export const aboutRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  // The file ships with the build, so it is read once. A build without it has no notes.
  let notes: Promise<ReleaseNotes[]> | undefined;
  const load = () =>
    (notes ??= readFile(ctx.config.changelogPath, 'utf8').then(parseChangelog, () => []));

  app.get('/about', { schema: { response: { 200: About } } }, async (req) => {
    const { user } = requireUser(req);
    const releases = await load();
    return {
      version: ctx.config.version,
      releases:
        user.role === 'admin'
          ? releases
          : releases
              .map((r) => ({ ...r, groups: r.groups.filter((g) => g.title !== ADMIN_ONLY) }))
              .filter((r) => r.groups.length > 0),
    };
  });
};
