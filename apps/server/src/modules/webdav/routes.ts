import { randomUUID } from 'node:crypto';
import { ErrorCode, guessMimeType, nameProblem, normalizeName } from '@familycloud/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import {
  blobs,
  type NodeRow,
  nodes,
  shares,
  storageVolumes,
  type UserRow,
  users,
} from '../../db/schema';
import { AppError } from '../../lib/errors';
import { loadAccess, type NodeAccess, satisfies } from '../files/access';
import { listTree, sendBlob } from '../files/serve';
import { insertNode, isAncestor, trashSubtree, updateNode } from '../files/tree';
import { ingest } from '../uploads/ingest';
import { type DavEntry, davHref, lockXml, multistatus, proppatchXml, responseXml } from './xml';

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
const MAX_COPY_ENTRIES = 10_000;

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
    if (!parent || parent.node.type !== 'folder') return { kind: 'conflict' };
    return { kind: 'missing', parent, name: names[names.length - 1]!, segments };
  }
  return { kind: 'conflict' };
}

async function quotaFor(ctx: AppContext, userId: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
  const used = u?.usedBytes ?? 0;
  if (u?.quotaBytes != null)
    return { used, available: u.quotaBytes - used - (u.reservedBytes ?? 0) };
  // Unlimited: report what the disks can actually still take.
  const vols = await ctx.db
    .select()
    .from(storageVolumes)
    .where(eq(storageVolumes.status, 'active'));
  let free = 0;
  for (const v of vols) {
    const rt = await ctx.volumes.status(v);
    if (rt.online && rt.disk) free += Math.max(0, rt.disk.freeBytes - v.reserveBytes);
  }
  return { used, available: free };
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

async function childrenOf(ctx: AppContext, folderId: string) {
  return ctx.db
    .select()
    .from(nodes)
    .where(and(eq(nodes.parentId, folderId), isNull(nodes.deletedAt)))
    .orderBy(asc(nodes.type), asc(sql`lower(${nodes.name})`))
    .limit(20_000);
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
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return raw !== undefined && Number.isInteger(n) && n >= 0 ? n : null;
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
            for (const child of await childrenOf(ctx, n.id)) {
              out.push(responseXml(nodeEntry(child, [...target.segments, child.name])));
            }
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
        const length = declaredLength(req);
        if (length === null)
          throw new AppError(411, ErrorCode.VALIDATION, 'Content-Length required');
        const t = writableTarget(target);
        if (t.existing && t.existing.node.type === 'folder')
          throw davError(405, 'Cannot overwrite a folder');
        const parentNode = t.existing
          ? { id: t.existing.node.parentId!, ownerId: t.existing.node.ownerId }
          : { id: t.parent!.node.id, ownerId: t.parent!.node.ownerId };
        const contentType = req.headers['content-type'];
        const { node, created } = await ingest(ctx, {
          uploaderId: user.id,
          parent: parentNode,
          name: t.name,
          size: length,
          mimeType: guessMimeType(
            t.name,
            typeof contentType === 'string' ? contentType.split(';')[0] : null,
          ),
          source: { kind: 'stream', body: req.raw },
          replaceNodeId: t.existing?.node.id ?? null,
          onConflict: 'fail',
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
        await trashSubtree(ctx.db, target.a.node.id);
        return reply.status(204).send();
      }

      case 'MOVE':
      case 'COPY': {
        if (target.kind !== 'node') throw davError(404, 'Source not found');
        const src = target.a;
        const destSegs = destinationSegments(req);
        const dest = await resolve(ctx, user, destSegs);
        const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase() !== 'F';
        if (dest.kind === 'node' && dest.a.node.id === src.node.id)
          throw davError(403, 'Source and destination are the same');
        const d = writableTarget(dest);
        const destParent = d.existing
          ? await loadAccess(ctx.db, user.id, d.existing.node.parentId!)
          : d.parent;
        if (!destParent) throw davError(409, 'Destination folder not found');
        if (d.existing && !overwrite)
          throw new AppError(412, ErrorCode.CONFLICT, 'Destination exists');

        if (method === 'MOVE') {
          if (src.isRoot || !satisfies(src.parentAccess, 'edit'))
            throw davError(403, 'Not allowed');
          if (destParent.node.ownerId !== src.node.ownerId) {
            throw davError(403, "Items can only be moved within the same person's files");
          }
          if (
            destParent.node.id === src.node.id ||
            (await isAncestor(ctx.db, src.node.id, destParent.node.id))
          ) {
            throw davError(403, 'A folder cannot be moved into itself');
          }
          if (d.existing) await trashSubtree(ctx.db, d.existing.node.id);
          await updateNode(ctx.db, src.node.id, { name: d.name, parentId: destParent.node.id });
          return reply.status(d.existing ? 204 : 201).send();
        }

        if (d.existing) await trashSubtree(ctx.db, d.existing.node.id);
        await copyInto(
          ctx,
          user.id,
          src.node,
          { id: destParent.node.id, ownerId: destParent.node.ownerId },
          d.name,
          req.headers.depth === '0',
        );
        return reply.status(d.existing ? 204 : 201).send();
      }

      case 'LOCK': {
        // Advisory only: Finder and Windows refuse to mount read-write without LOCK support.
        const token = `opaquelocktoken:${randomUUID()}`;
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

      case 'PROPPATCH':
        if (target.kind === 'missing' || target.kind === 'conflict')
          throw davError(404, 'Not found');
        return sendXml(reply, 207, proppatchXml(davHref(segments, false)));

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

/** Copies a file or folder tree (new blobs, quota charged to the destination owner). */
async function copyInto(
  ctx: AppContext,
  userId: string,
  src: NodeRow,
  destParent: { id: string; ownerId: string },
  name: string,
  shallow: boolean,
) {
  const copyFile = async (
    blobId: string,
    parentId: string,
    fileName: string,
    size: number,
    mimeType: string | null,
  ) => {
    const [blob] = await ctx.db.select().from(blobs).where(eq(blobs.id, blobId));
    if (!blob) return;
    await ingest(ctx, {
      uploaderId: userId,
      parent: { id: parentId, ownerId: destParent.ownerId },
      name: fileName,
      size,
      mimeType: mimeType ?? 'application/octet-stream',
      source: { kind: 'copy', fromFile: await ctx.volumes.blobFile(blob) },
      onConflict: 'rename',
    });
  };

  if (src.type === 'file') {
    if (src.blobId) await copyFile(src.blobId, destParent.id, name, src.size, src.mimeType);
    return;
  }
  const root = await insertNode(
    ctx.db,
    {
      ownerId: destParent.ownerId,
      parentId: destParent.id,
      type: 'folder',
      name,
      createdBy: userId,
    },
    'fail',
  );
  if (shallow) return;
  const tree = await listTree(ctx.db, src.id, MAX_COPY_ENTRIES + 1);
  if (tree.length > MAX_COPY_ENTRIES)
    throw new AppError(413, ErrorCode.VALIDATION, 'Folder is too large to copy in one go');
  const folderIds = new Map<string, string>([['', root.id]]);
  for (const e of tree) {
    const slash = e.path.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : e.path.slice(0, slash);
    const leaf = slash < 0 ? e.path : e.path.slice(slash + 1);
    const parentId = folderIds.get(parentPath);
    if (!parentId) continue;
    if (e.type === 'folder') {
      const f = await insertNode(
        ctx.db,
        { ownerId: destParent.ownerId, parentId, type: 'folder', name: leaf, createdBy: userId },
        'reuse',
      );
      folderIds.set(e.path, f.id);
    } else if (e.blobId) {
      const [n] = await ctx.db
        .select({ mimeType: nodes.mimeType })
        .from(nodes)
        .where(eq(nodes.id, e.id));
      await copyFile(e.blobId, parentId, leaf, Number(e.size), n?.mimeType ?? null);
    }
  }
}
