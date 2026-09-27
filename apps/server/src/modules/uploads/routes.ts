import {
  ChunkParams,
  ChunkResult,
  CreateUploadBody,
  IdParams,
  Ok,
  UploadSession,
} from '@familycloud/shared/all';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireUser } from '../../plugins/auth';
import { createUpload, getOwnedSession, releaseUpload, toUploadDto, writeChunk } from './service';

export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  // Chunk bodies are streamed straight to disk by the handler; never buffer or parse them.
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => done(null));

  app.post(
    '/uploads',
    { schema: { body: CreateUploadBody, response: { 200: UploadSession } } },
    async (req) => {
      const { user } = requireUser(req);
      const session = await createUpload(ctx, user.id, req.body);
      return toUploadDto(ctx, session);
    },
  );

  app.get(
    '/uploads/:id',
    { schema: { params: IdParams, response: { 200: UploadSession } } },
    async (req) => {
      const { user } = requireUser(req);
      return toUploadDto(ctx, await getOwnedSession(ctx, user.id, req.params.id));
    },
  );

  app.put(
    '/uploads/:id/chunks/:index',
    {
      schema: { params: ChunkParams, response: { 200: ChunkResult } },
      // Chunk PUTs are high-volume by design; the global limiter would throttle big uploads.
      config: {
        rateLimit: {
          max: (r: { server: { ctx: { config: { rateLimitScale: number } } } }) =>
            Math.round(3000 * r.server.ctx.config.rateLimitScale),
          timeWindow: '1 minute',
        },
      },
    },
    async (req) => {
      const { user } = requireUser(req);
      const session = await getOwnedSession(ctx, user.id, req.params.id);
      const header = req.headers['content-length'];
      const declared = header === undefined ? null : Number(header);
      const { session: s, node } = await writeChunk(
        ctx,
        session,
        req.params.index,
        req.raw,
        Number.isFinite(declared) ? declared : null,
      );
      const dto = node ? null : s.status === 'completed' ? await toUploadDto(ctx, s) : null;
      return {
        receivedCount: s.receivedCount,
        totalChunks: s.totalChunks,
        status: s.status,
        node: node ?? dto?.node ?? null,
      };
    },
  );

  app.delete(
    '/uploads/:id',
    { schema: { params: IdParams, response: { 200: Ok } } },
    async (req) => {
      const { user } = requireUser(req);
      const s = await getOwnedSession(ctx, user.id, req.params.id);
      await releaseUpload(ctx, s.id, 'aborted');
      return { ok: true as const };
    },
  );
};
