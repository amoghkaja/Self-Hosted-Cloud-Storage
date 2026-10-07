import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ErrorCode, guessMimeType, nameProblem, normalizeName } from '@familycloud/shared/all';
import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import { type NodeRow, nodes, shares, type UserRow, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { storageFor } from '../../lib/space';
import { loadAccess, type NodeAccess, satisfies } from '../files/access';
import { copyNode } from '../files/copy';
import { etagMatches, sendBlob } from '../files/serve';
import { insertNode, isAncestor, moveNode, nameSortKey, trashSubtree } from '../files/tree';
import { ingest } from '../uploads/ingest';
import { moveContentOnto } from '../versions/service';
import {
  type DavEntry,
  davHref,
  lockXml,
  MULTISTATUS_HEAD,
  MULTISTATUS_TAIL,
  multistatus,
  proppatchNames,
  proppatchXml,
  responseXml,
} from './xml';

export const MY_FILES = 'My Files';
export const SHARED = 'Shared with me';

export const DAV_METHODS = [
  'PROPFIND',
  'PROPPATCH',
  'MKCOL',
  'COPY',
  'MOVE',
  'LOCK',
  'UNLOCK',
] as const;
const ALLOW =
  'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK';

type Resolved =
  | { kind: 'root' }
  | { kind: 'shared-root' }
  | { kind: 'node'; a: NodeAccess; segments: string[] }
  | { kind: 'missing'; parent: NodeAccess | 'virtual'; name: string; segments: string[] }
  | { kind: 'conflict' };

const davError = (status: number, message: string) =>
  new AppError(status, status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.FORBIDDEN, message);

/** Decodes /dav/a%20b/c into ["a b", "c"], normalized like every other name in the app. */
export function parseDavPath(url: string): string[] {
  const pathOnly = url.split('?')[0]!.replace(/^\/dav\/?/, '');
  const parts = pathOnly.split('/').filter(Boolean);
  try {
    return parts.map((p) => normalizeName(decodeURIComponent(p)));
  } catch {
    throw new AppError(400, ErrorCode.VALIDATION, 'Malformed path');
  }
}

/** Top-level entries of "Shared with me", with clashing names disambiguated by owner. */
async function sharedRoots(ctx: AppContext, userId: string) {
  const rows = await ctx.db
    .select({ node: nodes, owner: users.displayName })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .innerJoin(users, eq(users.id, nodes.ownerId))
    .where(and(eq(shares.granteeId, userId), isNull(nodes.deletedAt)))
    .orderBy(asc(shares.createdAt));
  const counts = new Map<string, number>();
  for (const r of rows)
    counts.set(r.node.name.toLowerCase(), (counts.get(r.node.name.toLowerCase()) ?? 0) + 1);
  const used = new Set<string>();
  return rows.map((r) => {
    let name =
      (counts.get(r.node.name.toLowerCase()) ?? 0) > 1
        ? `${r.node.name} (${r.owner})`
        : r.node.name;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${r.node.name} (${r.owner} ${i})`;
    used.add(name.toLowerCase());
    return { name, node: r.node };
  });
}

/** Follows `names` down from `baseId` in one query; returns the deepest match. */
async function walk(ctx: AppContext, baseId: string, names: string[]) {
  const rows = (await ctx.db.execute(sql`
    WITH RECURSIVE w AS (
      SELECT id, 0 AS depth FROM nodes WHERE id = ${baseId} AND deleted_at IS NULL
      UNION ALL
      SELECT n.id, w.depth + 1 FROM nodes n JOIN w ON n.parent_id = w.id
      WHERE w.depth < ${names.length} AND n.deleted_at IS NULL
        AND lower(n.name) = lower(${JSON.stringify(names)}::jsonb ->> w.depth)
    )
    SELECT id, depth FROM w ORDER BY depth DESC LIMIT 1
  `)) as unknown as { id: string; depth: number }[];
  return rows[0] ?? null;
}

async function resolve(ctx: AppContext, user: UserRow, segments: string[]): Promise<Resolved> {
  if (segments.length === 0) return { kind: 'root' };
  const [top, ...rest] = segments as [string, ...string[]];
  let baseId: string;
  let names: string[];
  if (top.toLowerCase() === MY_FILES.toLowerCase()) {
    baseId = user.rootNodeId!;
    names = rest;
  } else if (top.toLowerCase() === SHARED.toLowerCase()) {
    if (rest.length === 0) return { kind: 'shared-root' };
    const roots = await sharedRoots(ctx, user.id);
    const hit = roots.find((r) => r.name.toLowerCase() === rest[0]!.toLowerCase());
    if (!hit)
      return rest.length === 1
        ? { kind: 'missing', parent: 'virtual', name: rest[0]!, segments }
        : { kind: 'conflict' };
    baseId = hit.node.id;
    names = rest.slice(1);
  } else {
    return segments.length === 1
      ? { kind: 'missing', parent: 'virtual', name: top, segments }
      : { kind: 'conflict' };
  }

  const found = await walk(ctx, baseId, names);
  if (!found) return { kind: 'conflict' };
  if (found.depth === names.length) {
    const a = await loadAccess(ctx.db, user.id, found.id);
    return a ? { kind: 'node', a, segments } : { kind: 'conflict' };
  }
  if (found.depth === names.length - 1) {
    const parent = await loadAccess(ctx.db, user.id, found.id);
    if (parent?.node.type !== 'folder') return { kind: 'conflict' };
    return { kind: 'missing', parent, name: names[names.length - 1]!, segments };
  }
  return { kind: 'conflict' };
}

async function quotaFor(ctx: AppContext, userId: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!u) return { used: 0, available: 0 };
  // The same "space left" the web app shows: quota, family limit and disks all apply.
  const s = await storageFor(ctx, u);
  return { used: s.usedBytes, available: s.availableBytes };
}

function nodeEntry(n: NodeRow, segments: string[]): DavEntry {
  const collection = n.type === 'folder';
  return {
    href: davHref(segments, collection),
    displayName: segments.length ? segments[segments.length - 1]! : n.name,
    collection,
    size: n.size,
    contentType: n.mimeType,
    modified: n.updatedAt,
    created: n.createdAt,
    etag: collection ? `"${n.id}-${n.updatedAt.getTime()}"` : `"${n.blobId}"`,
  };
}

function virtualEntry(segments: string[], name: string, created: Date): DavEntry {
  return {
    href: davHref(segments, true),
    displayName: name,
    collection: true,
    modified: new Date(),
    created,
    etag: `"v-${name}"`,
  };
}

const CHILD_BATCH = 1000;

/** A folder's children in keyset batches (nodes_children_idx), so no folder is too big to list. */
async function* childrenOf(ctx: AppContext, folderId: string) {
  let after: SQL | undefined;
  for (;;) {
    const rows = await ctx.db
      .select({ node: nodes, key: sql<string>`lower(${nodes.name})` })
      .from(nodes)
      .where(and(eq(nodes.parentId, folderId), isNull(nodes.deletedAt), after))
      .orderBy(asc(nodes.type), asc(nameSortKey), asc(nodes.id))
      .limit(CHILD_BATCH);
    for (const r of rows) yield r.node;
    const last = rows.at(-1);
    if (!last || rows.length < CHILD_BATCH) return;
    after = sql`(${nodes.type}, ${nameSortKey}, ${nodes.id}) > (${last.node.type}::node_type, ${last.key}, ${last.node.id})`;
  }
}

function sendXml(reply: FastifyReply, status: number, body: string) {
  return reply
    .status(status)
    .header('Content-Type', 'application/xml; charset=utf-8')
    .serializer((x: unknown) => x as string)
    .send(body);
}

function declaredLength(req: FastifyRequest): number | null {
  // macOS Finder streams with chunked encoding and announces the size in this header.
  const raw = req.headers['content-length'] ?? req.headers['x-expected-entity-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  // Digits only: Number() also reads "1e300" and "0x10", and a size past 2^53 isn't exact.
  const n = Number(value);
  return value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(n) ? n : null;
}

function destinationSegments(req: FastifyRequest): string[] {
  const header = req.headers.destination;
  if (typeof header !== 'string')
    throw new AppError(400, ErrorCode.VALIDATION, 'Missing Destination header');
  let pathname: string;
  try {
    pathname = new URL(header, 'http://placeholder').pathname;
  } catch {
    throw new AppError(400, ErrorCode.VALIDATION, 'Bad Destination header');
  }
  if (!pathname.startsWith('/dav/')) throw davError(403, 'Destination must be inside /dav/');
  return parseDavPath(pathname);
}

async function readBody(req: FastifyRequest, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.raw as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new AppError(413, ErrorCode.VALIDATION, 'Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A real folder the caller may add to, plus the name to use there. */
function writableTarget(target: Resolved): {
  parent: NodeAccess | null;
  name: string;
  existing: NodeAccess | null;
} {
  if (target.kind === 'missing') {
    if (target.parent === 'virtual')
      throw davError(403, 'Items must go inside "My Files" or a shared folder');
    if (!satisfies(target.parent.access, 'edit')) throw davError(403, 'Read-only folder');
    const problem = nameProblem(target.name);
    if (problem) throw new AppError(400, ErrorCode.VALIDATION, problem);
    return { parent: target.parent, name: target.name, existing: null };
  }
  if (target.kind === 'node') {
    if (target.a.isRoot || !satisfies(target.a.parentAccess, 'edit'))
      throw davError(403, 'Not allowed here');
    return { parent: null, name: target.segments[target.segments.length - 1]!, existing: target.a };
  }
  if (target.kind === 'conflict') throw davError(409, 'Parent folder does not exist');
  throw davError(403, 'Not allowed here');
}

export const davRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  // WebDAV bodies are file bytes (PUT) or XML we don't need: never let a parser consume them.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  async function authenticate(req: FastifyRequest): Promise<UserRow> {
    if (ctx.davAuth.isThrottled(req.clientIp)) {
      throw new AppError(429, ErrorCode.RATE_LIMITED, 'Too many failed sign-ins. Wait a minute.');
    }
    const user = await ctx.davAuth.authenticate(req.headers.authorization, req.clientIp);
    if (!user?.rootNodeId) {
      throw new AppError(
        401,
        ErrorCode.UNAUTHENTICATED,
        'Use your email and an app password from Settings',
        {
          'WWW-Authenticate': `Basic realm="${ctx.config.appName.replace(/"/g, '')}", charset="UTF-8"`,
        },
      );
    }
    return user;
  }

  async function handler(req: FastifyRequest, reply: FastifyReply) {
    const method = req.method.toUpperCase();
    reply.header('DAV', '1, 2').header('MS-Author-Via', 'DAV');
    if (method === 'OPTIONS') {
      return reply.status(200).header('Allow', ALLOW).header('Content-Length', '0').send();
    }
    const user = await authenticate(req);
    const segments = parseDavPath(req.url);
    const target = await resolve(ctx, user, segments);

    switch (method) {
      case 'PROPFIND': {
        const depth = req.headers.depth === '0' ? 0 : 1; // "infinity" is treated as 1
        const out: string[] = [];
        if (target.kind === 'root') {
          const quota = await quotaFor(ctx, user.id);
          out.push(responseXml({ ...virtualEntry([], 'Family Cloud', user.createdAt), quota }));
          if (depth) {
            out.push(responseXml({ ...virtualEntry([MY_FILES], MY_FILES, user.createdAt), quota }));
            out.push(responseXml(virtualEntry([SHARED], SHARED, user.createdAt)));
          }
        } else if (target.kind === 'shared-root') {
          out.push(responseXml(virtualEntry([SHARED], SHARED, user.createdAt)));
          if (depth) {
            for (const r of await sharedRoots(ctx, user.id)) {
              out.push(responseXml(nodeEntry(r.node, [SHARED, r.name])));
            }
          }
        } else if (target.kind === 'node') {
          const n = target.a.node;
          const self = nodeEntry(n, target.segments);
          if (n.type === 'folder') self.quota = await quotaFor(ctx, n.ownerId);
          out.push(responseXml(self));
          if (depth && n.type === 'folder') {
            // Streamed: a folder with many thousands of items never becomes one giant string.
            const segs = target.segments;
            async function* body() {
              yield MULTISTATUS_HEAD + out.join('');
              let chunk: string[] = [];
              for await (const child of childrenOf(ctx, n.id)) {
                chunk.push(responseXml(nodeEntry(child, [...segs, child.name])));
                if (chunk.length === CHILD_BATCH) {
                  yield chunk.join('');
                  chunk = [];
                }
              }
              yield chunk.join('') + MULTISTATUS_TAIL;
            }
            return reply
              .status(207)
              .header('Content-Type', 'application/xml; charset=utf-8')
              .send(Readable.from(body(), { objectMode: false }));
          }
        } else {
          throw davError(404, 'Not found');
        }
        return sendXml(reply, 207, multistatus(out));
      }

      case 'GET':
      case 'HEAD': {
        if (target.kind === 'node' && target.a.node.type === 'file') {
          const n = target.a.node;
          if (!n.blobId || !n.volumeId) throw davError(404, 'Not found');
          return sendBlob(
            ctx,
            req,
            reply,
            {
              blobId: n.blobId,
              volumeId: n.volumeId,
              size: n.size,
              name: n.name,
              mimeType: n.mimeType,
            },
            { inline: true },
          );
        }
        if (target.kind === 'missing' || target.kind === 'conflict')
          throw davError(404, 'Not found');
        return reply
          .status(200)
          .type('text/plain; charset=utf-8')
          .send('This is a folder. Open it in a WebDAV client.\n');
      }

      case 'PUT': {
        // A partial PUT (how `curl -C -` resumes an upload) would replace the whole file with
        // just the part it sends. RFC 9110 says to refuse it.
        if (req.headers['content-range'] !== undefined) {
          throw new AppError(400, ErrorCode.VALIDATION, 'Partial uploads are not supported');
        }
        const length = declaredLength(req);
        if (length === null)
          throw new AppError(411, ErrorCode.VALIDATION, 'Content-Length required');
        let existing: NodeRow | null = null;
        let parentNode: { id: string; ownerId: string };
        let name: string;
        if (target.kind === 'node') {
          existing = target.a.node;
          if (existing.type === 'folder') throw davError(405, 'Cannot overwrite a folder');
          // Saving over a file changes the file, not its folder: edit access on the file is
          // enough (e.g. a file shared directly with edit permission).
          if (!satisfies(target.a.access, 'edit')) throw davError(403, 'Read-only file');
          parentNode = { id: existing.parentId!, ownerId: existing.ownerId };
          name = existing.name;
        } else {
          const t = writableTarget(target);
          parentNode = { id: t.parent!.node.id, ownerId: t.parent!.node.ownerId };
          name = t.name;
        }
        // Clients that avoid lost updates send these; last-write-wins only for those that don't.
        const etag = existing ? `"${existing.blobId}"` : null;
        const ifMatch = req.headers['if-match'];
        if (ifMatch !== undefined && !(etag && etagMatches(ifMatch, etag, true))) {
          throw new AppError(412, ErrorCode.CONFLICT, 'The file changed since it was read');
        }
        if (etag && etagMatches(req.headers['if-none-match'], etag)) {
          throw new AppError(412, ErrorCode.CONFLICT, 'The file already exists');
        }
        const contentType = req.headers['content-type'];
        const { node, created } = await ingest(ctx, {
          uploaderId: user.id,
          parent: parentNode,
          name,
          size: length,
          mimeType: guessMimeType(
            name,
            typeof contentType === 'string' ? contentType.split(';')[0] : null,
          ),
          body: req.raw,
          replaceNodeId: existing?.id ?? null,
          expectBlobId: ifMatch !== undefined && ifMatch.trim() !== '*' ? existing?.blobId : null,
        });
        return reply
          .status(created ? 201 : 204)
          .header('ETag', `"${node.blobId}"`)
          .send();
      }

      case 'MKCOL': {
        if (target.kind === 'node' || target.kind === 'root' || target.kind === 'shared-root') {
          throw davError(405, 'Already exists');
        }
        const t = writableTarget(target);
        if (!t.parent) throw davError(405, 'Already exists');
        await insertNode(
          ctx.db,
          {
            ownerId: t.parent.node.ownerId,
            parentId: t.parent.node.id,
            type: 'folder',
            name: t.name,
            createdBy: user.id,
          },
          'fail',
        );
        return reply.status(201).send();
      }

      case 'DELETE': {
        if (target.kind !== 'node')
          throw davError(
            target.kind === 'missing' || target.kind === 'conflict' ? 404 : 403,
            'Cannot delete this',
          );
        if (target.a.isRoot || !satisfies(target.a.parentAccess, 'edit'))
          throw davError(403, 'Not allowed');
        // Deleting from a network drive goes to the web trash, so mistakes can be undone.
        await trashSubtree(ctx.db, target.a.node.id, { actorId: user.id });
        return reply.status(204).send();
      }

      case 'MOVE':
      case 'COPY': {
        if (target.kind !== 'node') throw davError(404, 'Source not found');
        const src = target.a;
        const destSegs = destinationSegments(req);
        const dest = await resolve(ctx, user, destSegs);
        const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase() !== 'F';
        if (dest.kind === 'node' && dest.a.node.id === src.node.id) {
          // Names are case-insensitive, so Finder renaming "photo.jpg" to "Photo.jpg" lands here.
          const name = destSegs[destSegs.length - 1]!;
          if (method === 'COPY' || name === src.node.name)
            throw davError(403, 'Source and destination are the same');
          if (src.isRoot || !satisfies(src.parentAccess, 'edit'))
            throw davError(403, 'Not allowed');
          const problem = nameProblem(name);
          if (problem) throw new AppError(400, ErrorCode.VALIDATION, problem);
          await moveNode(ctx.db, src.node, { name }, { actorId: user.id });
          return reply.status(201).send();
        }
        const d = writableTarget(dest);
        const destParent = d.existing
          ? await loadAccess(ctx.db, user.id, d.existing.node.parentId!)
          : d.parent;
        if (!destParent) throw davError(409, 'Destination folder not found');
        if (d.existing && !overwrite)
          throw new AppError(412, ErrorCode.CONFLICT, 'Destination exists');
        // Overwriting a folder that holds the source would trash the source along with it.
        if (d.existing && (await isAncestor(ctx.db, d.existing.node.id, src.node.id)))
          throw davError(403, 'The destination contains the source');
        if (await isAncestor(ctx.db, src.node.id, destParent.node.id))
          throw davError(403, 'A folder cannot be moved or copied into itself');

        if (method === 'MOVE') {
          if (src.isRoot || !satisfies(src.parentAccess, 'edit'))
            throw davError(403, 'Not allowed');
          if (destParent.node.ownerId !== src.node.ownerId) {
            throw davError(403, "Items can only be moved within the same person's files");
          }
          // A file renamed over another file: an editor saving through a temporary file.
          if (src.node.type === 'file' && d.existing?.node.type === 'file') {
            await moveContentOnto(ctx, user.id, src.node, d.existing.node);
            return reply.status(204).send();
          }
          // One transaction: if the move fails, the destination is not left in the trash.
          await moveNode(
            ctx.db,
            src.node,
            { name: d.name, parentId: destParent.node.id },
            { replaceId: d.existing?.node.id, actorId: user.id },
          );
          return reply.status(d.existing ? 204 : 201).send();
        }

        await copyNode(ctx, {
          userId: user.id,
          source: src.node,
          dest: { id: destParent.node.id, ownerId: destParent.node.ownerId },
          name: d.name,
          onConflict: 'fail',
          shallow: req.headers.depth === '0',
          replace: d.existing?.node,
        });
        return reply.status(d.existing ? 204 : 201).send();
      }

      case 'LOCK': {
        if (target.kind === 'conflict') throw davError(409, 'Parent folder does not exist');
        // Advisory only: Finder and Windows refuse to mount read-write without LOCK support.
        // A refresh names its lock in the If header; keep that token rather than minting one.
        const held = /<(opaquelocktoken:[\w-]+)>/.exec(String(req.headers.if ?? ''))?.[1];
        const token = held ?? `opaquelocktoken:${randomUUID()}`;
        const href = davHref(
          segments,
          target.kind === 'node' ? target.a.node.type === 'folder' : false,
        );
        return reply
          .status(target.kind === 'missing' ? 201 : 200)
          .header('Lock-Token', `<${token}>`)
          .header('Content-Type', 'application/xml; charset=utf-8')
          .serializer((x: unknown) => x as string)
          .send(lockXml(href, token, user.email));
      }

      case 'UNLOCK':
        return reply.status(204).send();

      case 'PROPPATCH': {
        if (target.kind === 'missing' || target.kind === 'conflict')
          throw davError(404, 'Not found');
        const props = proppatchNames(await readBody(req, 64 * 1024));
        const collection = target.kind !== 'node' || target.a.node.type === 'folder';
        return sendXml(reply, 207, proppatchXml(davHref(segments, collection), props));
      }

      default:
        return reply.status(405).header('Allow', ALLOW).send();
    }
  }

  const config = {
    rateLimit: {
      max: (req: FastifyRequest) => Math.round(3000 * req.server.ctx.config.rateLimitScale),
      timeWindow: '1 minute',
    },
  };
  const methods = ['GET', 'PUT', 'DELETE', 'OPTIONS', ...DAV_METHODS];
  app.route({ method: methods, url: '/dav', config, handler });
  app.route({ method: methods, url: '/dav/*', config, handler });
};
