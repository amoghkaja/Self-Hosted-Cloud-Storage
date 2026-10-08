import path from 'node:path';
import {
  AutoUpdateBody,
  ErrorCode,
  InstallUpdateBody,
  UpdateStatus,
} from '@familycloud/shared/all';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { audit } from '../../lib/audit';
import { conflict } from '../../lib/errors';
import { requireAdmin } from '../../plugins/auth';
import { dropRequest, leaveRequest, readHost, toUpdateStatus } from './host';

/**
 * Updates in Admin → Overview. The app can't update itself: it shows what the update helper on
 * the server found, and leaves it requests (check now, install the newest version, automatic
 * updates on or off), which the helper answers within a minute.
 */
export const updateRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const dir = path.join(ctx.config.cacheDir, 'updates');
  const status = async () => toUpdateStatus(ctx.config.version, await readHost(dir));
  const helperNeeded = (s: UpdateStatus) => {
    if (s.updater === 'missing') {
      return conflict(
        'Updates from here need the update helper on the server: run ./scripts/update.sh --updates notify there to set it up.',
        ErrorCode.UPDATER_MISSING,
      );
    }
    if (s.updater === 'off') {
      return conflict(
        'Updates on this server are set to be done by hand. To install them from here, run ./scripts/update.sh --updates notify on the server.',
        ErrorCode.UPDATER_MISSING,
      );
    }
    return conflict(
      "The update helper on the server isn't answering. Run ./scripts/update.sh there to see why.",
      ErrorCode.UPDATER_MISSING,
    );
  };

  app.addHook('preHandler', async (req) => {
    requireAdmin(req);
  });

  app.get('/admin/updates', { schema: { response: { 200: UpdateStatus } } }, () => status());

  app.post('/admin/updates/check', { schema: { response: { 200: UpdateStatus } } }, async () => {
    const s = await status();
    if (s.updater === 'missing' || s.updater === 'off') throw helperNeeded(s);
    await leaveRequest(dir, 'request-check');
    return status();
  });

  app.post(
    '/admin/updates/install',
    { schema: { body: InstallUpdateBody, response: { 200: UpdateStatus } } },
    async (req) => {
      const { user } = requireAdmin(req);
      const s = await status();
      if (s.updater !== 'ok') throw helperNeeded(s);
      if (s.last?.state === 'updating' || s.pending.install) {
        throw conflict('An update is already under way.', ErrorCode.UPDATE_IN_PROGRESS);
      }
      const a = s.available;
      const refuse = (why: string) => conflict(why, ErrorCode.UPDATE_UNAVAILABLE);
      if (!a || a.version !== req.body.version) {
        throw refuse("That isn't the newest version any more: check for updates again.");
      }
      if (a.manualSteps) {
        throw refuse(
          `${a.version} needs you to do something on the server first (see "Before you update"), then run ./scripts/update.sh there.`,
        );
      }
      if (!a.ready) {
        throw refuse(`${a.version} is still being published. Try again in a few minutes.`);
      }
      if (s.problem === 'local-changes') {
        throw refuse(
          "Files in the Family Cloud folder on the server were changed, so it can't update. Run ./scripts/update.sh there to see which.",
        );
      }
      await leaveRequest(dir, `request-update-${a.version}`);
      await audit(ctx.db, {
        actorId: user.id,
        action: 'admin.update_requested',
        ip: req.clientIp,
        meta: { version: a.version },
      });
      return status();
    },
  );

  app.put(
    '/admin/updates/auto',
    { schema: { body: AutoUpdateBody, response: { 200: UpdateStatus } } },
    async (req) => {
      const { user } = requireAdmin(req);
      const s = await status();
      if (s.updater !== 'ok') throw helperNeeded(s);
      const [want, other] = req.body.enabled
        ? ['request-auto-on', 'request-auto-off']
        : ['request-auto-off', 'request-auto-on'];
      await dropRequest(dir, other);
      await leaveRequest(dir, want);
      await audit(ctx.db, {
        actorId: user.id,
        action: 'admin.auto_update_changed',
        ip: req.clientIp,
        meta: { enabled: req.body.enabled },
      });
      return status();
    },
  );
};
