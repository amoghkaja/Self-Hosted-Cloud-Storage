import {
  type Access,
  ContentQuery,
  FileNode,
  IdParams,
  Ok,
  splitExtension,
  VersionList,
  VersionParams,
} from '@familycloud/shared/all';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { blobs, fileVersions, nodes, users } from '../../db/schema';
import { queueUnfinishedWork } from '../../jobs/derived';
import { audit } from '../../lib/audit';
import { toFileNode } from '../../lib/dto';
import { conflict, notFound } from '../../lib/errors';
import { toIso } from '../../lib/time';
import { requireUser } from '../../plugins/auth';
import { lockWriteAccess, requireAccess } from '../files/access';
import { sendBlob } from '../files/serve';
import { deleteBlobFiles, QUOTA_LOCK } from '../files/tree';
import { deleteVersions, replaceContent } from './service';

/** "report.docx" saved 2026-09-20 14:03 UTC -> "report (2026-09-20 14.03).docx". */
function versionFileName(name: string, savedAt: Date): string {
  const [base, ext] = splitExtension(name);
  const stamp = savedAt.toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  return `${base} (${stamp})${ext}`;
}

/**
 * Version history. Anyone who may change a file may see, download and restore its older
 * versions (old contents can hold things the owner since removed, so view-only access isn't
 * enough); only the owner may delete them, so history can't be wiped through a share.
 */
export const versionRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  async function fileAccess(userId: string, id: string, need: Access) {
    const a = await requireAccess(db, userId, id, need);
    if (a.node.type !== 'file') throw notFound('File');
    return a;
  }

  async function names(ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (wanted.length === 0) return new Map<string, string>();
    const rows = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, wanted));
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  app.get(
    '/nodes/:id/versions',
    { schema: { params: IdParams, response: { 200: VersionList } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await fileAccess(user.id, req.params.id, 'edit');
      const rows = await db
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.nodeId, a.node.id))
        .orderBy(desc(fileVersions.createdAt), desc(fileVersions.id));
      const author = a.node.modifiedBy ?? a.node.createdBy;
      const who = await names([author, ...rows.map((r) => r.modifiedBy)]);
      const ref = (id: string | null) =>
        id && who.has(id) ? { id, displayName: who.get(id)! } : null;
      return {
        current: {
          size: a.node.size,
          modifiedAt: toIso(a.node.updatedAt),
          modifiedBy: ref(author),
        },
        items: rows.map((v) => ({
          id: v.id,
          size: v.size,
          mimeType: v.mimeType,
          modifiedAt: toIso(v.modifiedAt),
          modifiedBy: ref(v.modifiedBy),
          replacedAt: toIso(v.createdAt),
        })),
        retentionDays: (await ctx.settings.get()).versionRetentionDays,
        canDelete: a.access === 'owner',
      };
    },
  );

  async function versionOf(nodeId: string, versionId: string) {
    const [row] = await db
      .select({ version: fileVersions, volumeId: blobs.volumeId })
      .from(fileVersions)
      .innerJoin(blobs, eq(blobs.id, fileVersions.blobId))
      .where(and(eq(fileVersions.id, versionId), eq(fileVersions.nodeId, nodeId)));
    if (!row) throw notFound('Version');
    return row;
  }

  app.get(
    '/nodes/:id/versions/:versionId/content',
    { schema: { params: VersionParams, querystring: ContentQuery } },
    async (req, reply) => {
      const { user } = requireUser(req);
      const a = await fileAccess(user.id, req.params.id, 'edit');
      const { version: v, volumeId } = await versionOf(a.node.id, req.params.versionId);
      return sendBlob(
        ctx,
        req,
        reply,
        {
          blobId: v.blobId,
          volumeId,
          size: v.size,
          name: versionFileName(a.node.name, v.modifiedAt),
          mimeType: v.mimeType,
        },
        { inline: req.query.inline === '1' },
      );
    },
  );

  app.post(
    '/nodes/:id/versions/:versionId/restore',
    { schema: { params: VersionParams, response: { 200: z.object({ node: FileNode }) } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await fileAccess(user.id, req.params.id, 'edit');
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(${QUOTA_LOCK})`);
        // Through a share, the right to change the file is re-checked under lock (a share on
        // the file itself counts). Folder before file: the order uploads take them in.
        if (a.node.ownerId !== user.id) {
          await lockWriteAccess(tx, user.id, a.node.parentId!, a.node.id);
        }
        const [file] = await tx
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, a.node.id), isNull(nodes.deletedAt)))
          .for('update');
        if (!file || file.parentId !== a.node.parentId)
          throw conflict('The file changed meanwhile');
        const [version] = await tx
          .delete(fileVersions)
          .where(and(eq(fileVersions.id, req.params.versionId), eq(fileVersions.nodeId, file.id)))
          .returning();
        if (!version) throw notFound('Version');
        // What's there now becomes a version too, so restoring can itself be undone.
        const replaced = await replaceContent(
          tx,
          file,
          { blobId: version.blobId, size: version.size, mimeType: version.mimeType },
          { actorId: user.id, keepVersion: true },
        );
        // The restored bytes were counted as a version and now count as the file instead.
        const delta = replaced.usageDelta - version.size;
        if (delta !== 0) {
          await tx
            .update(users)
            .set({ usedBytes: sql`greatest(${users.usedBytes} + ${delta}, 0)` })
            .where(eq(users.id, file.ownerId));
        }
        const [blob] = await tx.select().from(blobs).where(eq(blobs.id, version.blobId));
        return { node: replaced.node, orphans: replaced.orphans, blob: blob! };
      });
      await deleteBlobFiles(ctx, result.orphans);
      // Work that never finished while these bytes were a version (replaced before the worker
      // got to them); the jobs skip anything already done.
      const { blob } = result;
      await queueUnfinishedWork(ctx, blob);
      await audit(db, {
        actorId: user.id,
        action: 'file.version_restored',
        targetType: 'node',
        targetId: a.node.id,
        ip: req.clientIp,
        meta: { versionId: req.params.versionId },
      });
      return { node: toFileNode({ ...result.node, thumb: blob.thumbStatus }) };
    },
  );

  app.delete(
    '/nodes/:id/versions/:versionId',
    { schema: { params: VersionParams, response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await fileAccess(user.id, req.params.id, 'owner');
      await versionOf(a.node.id, req.params.versionId);
      await deleteVersions(ctx, [req.params.versionId]);
      await audit(db, {
        actorId: user.id,
        action: 'file.version_deleted',
        targetType: 'node',
        targetId: a.node.id,
        ip: req.clientIp,
        meta: { versionId: req.params.versionId },
      });
      return { ok: true as const };
    },
  );

  app.delete(
    '/nodes/:id/versions',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      const a = await fileAccess(user.id, req.params.id, 'owner');
      const rows = await db
        .select({ id: fileVersions.id })
        .from(fileVersions)
        .where(eq(fileVersions.nodeId, a.node.id));
      const result = await deleteVersions(
        ctx,
        rows.map((r) => r.id),
      );
      await audit(db, {
        actorId: user.id,
        action: 'file.versions_deleted',
        targetType: 'node',
        targetId: a.node.id,
        ip: req.clientIp,
        meta: result,
      });
      return { ok: true as const };
    },
  );
};
