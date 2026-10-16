import { ErrorCode, guessMimeType, Id } from '@familycloud/shared/all';
import { eq } from 'drizzle-orm';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import type { AppContext } from '../../context';
import { blobs, officeSessions } from '../../db/schema';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { registerErrorHandling } from '../../plugins/errors';
import { loadAccess, satisfies } from '../files/access';
import { sendBlob } from '../files/serve';
import { ingest } from '../uploads/ingest';
import { editingEnabled, resolveOfficeToken } from './editor';

/** WOPI's "the file changed in storage" answer: the editor asks whether to overwrite or reload. */
const CHANGED = { COOLStatusCode: 1010 };

/**
 * The WOPI host the document editor reads and saves files through: CheckFileInfo, GetFile and
 * PutFile, for the one file each token was made for. A listener of its own (OFFICE_WOPI_PORT)
 * that the tunnel, Caddy and the published ports never lead to, so only the editor container
 * can call it; the token still decides which file, as whom.
 *
 * Every call re-checks the person's access now, so taking a share away cuts off an open editor,
 * and saves go through ingest: the quota, version history and access check at commit of any
 * other save.
 */
export async function buildWopiApp(
  ctx: AppContext,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.logger === false ? undefined : (ctx.log as unknown as FastifyBaseLogger),
    requestTimeout: 30 * 60_000,
  });
  app.decorate('ctx', ctx);
  registerErrorHandling(app);
  // Saves are the file's bytes: never parsed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  const { db } = ctx;

  async function open(req: FastifyRequest) {
    const id = Id.safeParse((req.params as { id?: unknown }).id).data;
    if (!id) throw notFound('File');
    const token = (req.query as Record<string, unknown>).access_token;
    const session = await resolveOfficeToken(ctx, token, id);
    if (!session) throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Open the file again');
    const a = await loadAccess(db, session.user.id, id);
    if (a?.node.type !== 'file' || !a.node.blobId || !a.node.volumeId) throw notFound('File');
    const [blob] = await db
      .select({ createdAt: blobs.createdAt })
      .from(blobs)
      .where(eq(blobs.id, a.node.blobId));
    // When these contents were made: the version the editor holds, compared on every save.
    const modified = (blob?.createdAt ?? a.node.updatedAt).toISOString();
    return { ...session, a, blobId: a.node.blobId, volumeId: a.node.volumeId, modified };
  }

  // CheckFileInfo: what the editor shows and allows.
  app.get('/wopi/files/:id', async (req) => {
    const { user, a, blobId, modified } = await open(req);
    // Turned off: files already open can still be saved, but nothing opens.
    if (!(await editingEnabled(ctx))) {
      throw new AppError(403, ErrorCode.OFFICE_UNAVAILABLE, 'Editing is turned off');
    }
    return {
      BaseFileName: a.node.name,
      Size: a.node.size,
      Version: blobId,
      LastModifiedTime: modified,
      OwnerId: a.node.ownerId,
      UserId: user.id,
      UserFriendlyName: user.displayName,
      UserCanWrite: satisfies(a.access, 'edit'),
      // Only saving over this file: no "Save as" copies, renames or locks (none implemented).
      UserCanNotWriteRelative: true,
      UserCanRename: false,
      SupportsRename: false,
      SupportsLocks: false,
      SupportsUpdate: true,
      PostMessageOrigin: ctx.config.publicOrigin,
      IsAdminUser: false,
      IsAnonymousUser: false,
      EnableInsertRemoteImage: false,
      EnableShare: false,
    };
  });

  // GetFile: the same way out as every other download (an infected file is refused).
  app.get('/wopi/files/:id/contents', async (req, reply) => {
    const { a, blobId, volumeId } = await open(req);
    return sendBlob(
      ctx,
      req,
      reply,
      { blobId, volumeId, size: a.node.size, name: a.node.name, mimeType: a.node.mimeType },
      { inline: false },
    );
  });

  // PutFile: the editor saving the file (on its own every few minutes, and when closed).
  app.post('/wopi/files/:id/contents', async (req, reply) => {
    const { user, office, a, blobId, modified } = await open(req);
    if (!satisfies(a.access, 'edit')) throw forbidden('You can only view this file');
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AppError(411, ErrorCode.VALIDATION, 'Content-Length required');
    }
    // Saved since the editor opened it (the network drive, Replace, a restored version): the
    // editor asks the person what to do rather than overwriting. It leaves the header out once
    // they choose to overwrite.
    const seen = req.headers['x-cool-wopi-timestamp'];
    if (typeof seen === 'string' && seen !== modified) return reply.status(409).send(CHANGED);
    let saved: Awaited<ReturnType<typeof ingest>>;
    try {
      saved = await ingest(ctx, {
        uploaderId: user.id,
        parent: { id: a.node.parentId!, ownerId: a.node.ownerId },
        name: a.node.name,
        size: length,
        mimeType: a.node.mimeType ?? guessMimeType(a.node.name),
        body: req.raw,
        replaceNodeId: a.node.id,
        expectBlobId: blobId,
        // The file as it was before this session is kept once; its own later saves replace
        // each other.
        keepVersion: blobId !== office.savedBlobId,
      });
    } catch (err) {
      if (err instanceof AppError && err.status === 412) return reply.status(409).send(CHANGED);
      throw err;
    }
    const newBlobId = saved.node.blobId!;
    await db
      .update(officeSessions)
      .set({ savedBlobId: newBlobId })
      .where(eq(officeSessions.id, office.id));
    const [blob] = await db
      .select({ createdAt: blobs.createdAt })
      .from(blobs)
      .where(eq(blobs.id, newBlobId));
    return { LastModifiedTime: (blob?.createdAt ?? new Date()).toISOString() };
  });

  // Locks, "Save as", renames: offered by none of the answers above.
  app.post('/wopi/files/:id', async (req) => {
    await open(req);
    throw new AppError(501, ErrorCode.VALIDATION, 'Not supported');
  });

  return app;
}
