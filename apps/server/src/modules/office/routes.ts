import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import {
  EditSession,
  ErrorCode,
  IdParams,
  isEditableOffice,
  OfficeInfo,
  OfficeStatus,
  SetOfficeBody,
} from '@familycloud/shared/all';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { requireAdmin, requireUser } from '../../plugins/auth';
import { requireAccess } from '../files/access';
import { refuseUnsafe } from '../files/serve';
import { dropRequest, leaveRequest, readHost, toUpdateStatus } from '../updates/host';
import {
  createOfficeSession,
  discovery,
  editingEnabled,
  editorAvailable,
  editPage,
  openDocuments,
  setEditingEnabled,
} from './editor';

/**
 * Editing Word, Excel and PowerPoint files in the browser. Optional twice over: the editor is
 * set up on the server (./scripts/office.sh on), and the admin switches it on and off here.
 * Off also asks the update helper to remove the editor's container, which gives its memory back.
 */
export const officeRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;
  const hostDir = path.join(ctx.config.cacheDir, 'updates');

  app.get('/office', { schema: { response: { 200: OfficeInfo } } }, async (req) => {
    requireUser(req);
    return { available: await editorAvailable(ctx) };
  });

  app.post(
    '/nodes/:id/edit',
    { schema: { params: IdParams, response: { 200: EditSession } } },
    async (req) => {
      const auth = requireUser(req);
      const a = await requireAccess(db, auth.user.id, req.params.id, 'edit');
      if (a.node.type !== 'file' || !a.node.blobId) throw notFound('File');
      if (!isEditableOffice(a.node.name)) {
        throw badRequest("This kind of file can't be edited here.", ErrorCode.OFFICE_UNAVAILABLE);
      }
      const page = await editPage(ctx, a.node.name);
      await refuseUnsafe(ctx, a.node.blobId);
      const office = ctx.config.office!;
      const { token, expiresAt } = await createOfficeSession(ctx, {
        userId: auth.user.id,
        sessionId: auth.sessionId,
        nodeId: a.node.id,
      });
      const wopiSrc = encodeURIComponent(`${office.wopiUrl}/wopi/files/${a.node.id}`);
      return {
        url: `${office.publicOrigin}${page}${page.endsWith('?') ? '' : '&'}WOPISrc=${wopiSrc}&closebutton=1`,
        origin: office.publicOrigin,
        accessToken: token,
        accessTokenTtl: expiresAt.getTime(),
      };
    },
  );

  async function status(): Promise<OfficeStatus> {
    const host = await readHost(hostDir);
    const updater = toUpdateStatus(ctx.config.version, host).updater;
    const at = (name: string) => host.requests.find((r) => r.name === name)?.at;
    const on = at('request-office-on');
    const off = at('request-office-off');
    return {
      configured: ctx.config.office !== null,
      publicUrl: ctx.config.office?.publicOrigin ?? null,
      enabled: await editingEnabled(ctx),
      running: ctx.config.office ? (await discovery(ctx, { fresh: true })) !== null : null,
      pending: on !== undefined && (off === undefined || on >= off) ? 'on' : off ? 'off' : null,
      helper: updater === 'ok' ? 'ok' : updater === 'not-responding' ? 'not-responding' : 'missing',
      openDocuments: await openDocuments(ctx),
      memory: { totalBytes: totalmem(), availableBytes: freemem() },
    };
  }

  app.get('/admin/office', { schema: { response: { 200: OfficeStatus } } }, async (req) => {
    requireAdmin(req);
    return status();
  });

  // The switch. It takes effect in the app at once; the update helper then starts or removes the
  // editor's container within a minute (without the helper, ./scripts/office.sh does that).
  app.put(
    '/admin/office',
    { schema: { body: SetOfficeBody, response: { 200: OfficeStatus } } },
    async (req) => {
      const { user } = requireAdmin(req);
      if (!ctx.config.office) {
        throw conflict(
          "The document editor isn't set up on this server yet. Run ./scripts/office.sh on there.",
          ErrorCode.OFFICE_UNAVAILABLE,
        );
      }
      const { enabled } = req.body;
      await setEditingEnabled(ctx, enabled);
      const before = await status();
      if (before.helper === 'ok') {
        const [want, other] = enabled
          ? ['request-office-on', 'request-office-off']
          : ['request-office-off', 'request-office-on'];
        await dropRequest(hostDir, other);
        await leaveRequest(hostDir, want);
      }
      await audit(db, {
        actorId: user.id,
        action: 'admin.office_changed',
        ip: req.clientIp,
        meta: { enabled },
      });
      return status();
    },
  );
};
