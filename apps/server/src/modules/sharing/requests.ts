import {
  ErrorCode,
  isProgramFile,
  nameProblem,
  normalizeName,
  Ok,
  PublicChunkParams,
  PublicChunkResult,
  PublicUploadBody,
  PublicUploadParams,
  PublicUploadSession,
  REQUEST_MAX_FILES,
  TokenParams,
} from '@familycloud/shared/all';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { albumFolders, type UploadSessionRow, uploadChunks, uploadSessions } from '../../db/schema';
import { audit } from '../../lib/audit';
import { AppError, notFound } from '../../lib/errors';
import { toIso } from '../../lib/time';
import { strictLimit } from '../../plugins/security';
import { insertNode } from '../files/tree';
import { createUpload, releaseUpload, writeChunk } from '../uploads/service';
import { resolveUnlocked } from './links';

/**
 * File requests: a link that lets anyone send files into one folder without an account, and
 * never shows them what's in it (like Dropbox file requests). Uploads are ordinary resumable
 * uploads, charged to the folder's owner and tied to the request: they stop the moment the
 * request is turned off, expires or its folder is deleted. The sender only ever learns about
 * their own uploads; nothing here reveals the folder, its owner's files or their ids.
 */
export const requestRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;
  const { db } = ctx;

  // Chunk bodies are streamed straight to disk by the handler; never buffer or parse them.
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => done(null));

  const openRequest = (req: FastifyRequest, token: string) =>
    resolveUnlocked(ctx, req, token, 'upload');

  async function requestSession(req: FastifyRequest, token: string, id: string) {
    const r = await openRequest(req, token);
    const [s] = await db
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.id, id), eq(uploadSessions.linkId, r.link.id)));
    if (!s) throw notFound('Upload');
    return { r, s };
  }

  async function toDto(s: UploadSessionRow) {
    const chunks = await db
      .select({ idx: uploadChunks.idx })
      .from(uploadChunks)
      .where(eq(uploadChunks.uploadId, s.id));
    return {
      id: s.id,
      name: s.name,
      size: s.size,
      chunkSize: s.chunkSize,
      totalChunks: s.totalChunks,
      receivedChunks: chunks.map((c) => c.idx).sort((a, b) => a - b),
      status: s.status,
      expiresAt: toIso(s.expiresAt),
      done: s.status === 'completed',
    };
  }

  app.post(
    '/public/links/:token/uploads',
    {
      config: strictLimit(60),
      schema: {
        params: TokenParams,
        body: PublicUploadBody,
        response: { 200: PublicUploadSession },
      },
    },
    async (req) => {
      const r = await openRequest(req, req.params.token);
      if (r.root.type !== 'folder') throw notFound('Link');
      const ownerId = r.root.ownerId;
      let name = req.body.name;
      if (isProgramFile(name)) {
        throw new AppError(
          400,
          ErrorCode.VALIDATION,
          "Programs and scripts can't be sent this way. Send photos, videos or documents.",
        );
      }
      const [open] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.linkId, r.link.id),
            inArray(uploadSessions.status, ['uploading', 'finalizing']),
          ),
        );
      if (r.link.uploadCount + (open?.n ?? 0) >= REQUEST_MAX_FILES) {
        throw new AppError(
          409,
          ErrorCode.CONFLICT,
          `This request has taken all the files it can (${REQUEST_MAX_FILES}).`,
        );
      }
      const from = req.body.from ? normalizeName(req.body.from) : '';
      let senderFolder = false;
      if (from) {
        const problem = nameProblem(from);
        if (problem) throw new AppError(400, ErrorCode.VALIDATION, `Your name: ${problem}`);
        const [album] = await db
          .select({ id: albumFolders.albumId })
          .from(albumFolders)
          .where(eq(albumFolders.folderId, r.root.id));
        if (album) {
          // An album shows what's directly in its folders: name the photo after its sender.
          const prefixed = `${from} - ${name}`;
          if (!nameProblem(prefixed)) name = prefixed;
        } else {
          senderFolder = true;
        }
      }
      let session = await createUpload(ctx, ownerId, {
        parentId: r.root.id,
        name,
        size: req.body.size,
        mimeType: req.body.mimeType,
        linkId: r.link.id,
      });
      if (senderFolder) {
        // Each sender's files go in a folder with their name, so the owner can tell who sent
        // what. Made only once an upload is accepted, so refused ones leave nothing behind.
        // (A file of that name in the way: the request's own folder it is.)
        const folder = await insertNode(
          db,
          { ownerId, parentId: r.root.id, type: 'folder', name: from, createdBy: null },
          'reuse',
        ).catch(() => null);
        if (folder) {
          const [moved] = await db
            .update(uploadSessions)
            .set({ parentId: folder.id })
            .where(eq(uploadSessions.id, session.id))
            .returning();
          if (moved) session = moved;
        }
      }
      return toDto(session);
    },
  );

  app.get(
    '/public/links/:token/uploads/:id',
    {
      config: strictLimit(600),
      schema: { params: PublicUploadParams, response: { 200: PublicUploadSession } },
    },
    async (req) => toDto((await requestSession(req, req.params.token, req.params.id)).s),
  );

  app.put(
    '/public/links/:token/uploads/:id/chunks/:index',
    {
      schema: { params: PublicChunkParams, response: { 200: PublicChunkResult } },
      // Same allowance as signed-in uploads: big files are many chunks.
      config: {
        rateLimit: {
          max: (r: { server: { ctx: { config: { rateLimitScale: number } } } }) =>
            Math.round(3000 * r.server.ctx.config.rateLimitScale),
          timeWindow: '1 minute',
        },
      },
    },
    async (req) => {
      const { r, s } = await requestSession(req, req.params.token, req.params.id);
      const header = req.headers['content-length'];
      const declared = header === undefined ? null : Number(header);
      const { session, node } = await writeChunk(
        ctx,
        s,
        req.params.index,
        req.raw,
        Number.isFinite(declared) ? declared : null,
      );
      if (node) {
        // Exactly one request finishes a file (counted with it, see finalizeUpload).
        await audit(db, {
          actorId: null,
          action: 'link.upload_received',
          targetType: 'node',
          targetId: node.id,
          ip: req.clientIp,
          meta: { linkId: r.link.id, name: node.name, size: node.size },
        });
      }
      return {
        receivedCount: session.receivedCount,
        totalChunks: session.totalChunks,
        status: session.status,
        done: session.status === 'completed',
      };
    },
  );

  app.delete(
    '/public/links/:token/uploads/:id',
    { config: strictLimit(120), schema: { params: PublicUploadParams, response: { 200: Ok } } },
    async (req) => {
      const { s } = await requestSession(req, req.params.token, req.params.id);
      await releaseUpload(ctx, s.id, 'aborted');
      return { ok: true as const };
    },
  );
};
