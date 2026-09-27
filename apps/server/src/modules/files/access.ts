import type { Access, Breadcrumb, ThumbStatus } from '@familycloud/shared/all';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { blobs, type NodeRow, nodes } from '../../db/schema';
import { forbidden, notFound } from '../../lib/errors';

export type NodeWithBlob = NodeRow & { thumb: ThumbStatus | null; volumeId: string | null };

export interface NodeAccess {
  node: NodeWithBlob;
  access: Access;
  /** Access the caller has on the node's parent (null for roots or when the parent is outside their view). */
  parentAccess: Access | null;
  breadcrumbs: Breadcrumb[];
  isRoot: boolean;
}

interface ChainRow {
  id: string;
  name: string;
  depth: number;
  ownerId: string;
  permission: 'view' | 'edit' | null;
}

const RANK: Record<Access, number> = { view: 1, edit: 2, owner: 3 };

export function satisfies(have: Access | null, need: Access): boolean {
  return have !== null && RANK[have] >= RANK[need];
}

/** Access implied by a chain (root first) for `userId`, plus the index where visibility starts. */
function accessFromChain(
  chain: ChainRow[],
  userId: string,
): { access: Access; from: number } | null {
  const leaf = chain[chain.length - 1];
  if (!leaf) return null;
  if (leaf.ownerId === userId) return { access: 'owner', from: 0 };
  let best: Access | null = null;
  let from = -1;
  for (const [i, row] of chain.entries()) {
    if (!row.permission) continue;
    if (from === -1) from = i; // top-most share: breadcrumbs start here
    if (!best || RANK[row.permission] > RANK[best]) best = row.permission;
  }
  return best ? { access: best, from } : null;
}

/**
 * The single authorization choke point for node access. Resolves the node, its ancestor chain and
 * any shares granted to `userId` along that chain in two indexed queries.
 * Owners see everything in their tree; share grantees see the shared subtree only (breadcrumbs are
 * truncated at the share root so the owner's surrounding folders stay private).
 */
export async function loadAccess(
  exec: Executor,
  userId: string,
  nodeId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<NodeAccess | null> {
  const [row] = await exec
    .select({ node: nodes, thumb: blobs.thumbStatus, volumeId: blobs.volumeId })
    .from(nodes)
    .leftJoin(blobs, eq(blobs.id, nodes.blobId))
    .where(eq(nodes.id, nodeId));
  if (!row) return null;
  if (row.node.deletedAt && !opts.includeDeleted) return null;

  const chain = (await exec.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, name, owner_id, 0 AS depth FROM nodes WHERE id = ${nodeId}
      UNION ALL
      SELECT p.id, p.parent_id, p.name, p.owner_id, c.depth + 1
      FROM nodes p JOIN chain c ON p.id = c.parent_id
      WHERE c.depth < 512
    )
    SELECT c.id, c.name, c.depth, c.owner_id AS "ownerId", s.permission
    FROM chain c
    LEFT JOIN shares s ON s.node_id = c.id AND s.grantee_id = ${userId}
    ORDER BY c.depth DESC
  `)) as unknown as ChainRow[];

  const self = accessFromChain(chain, userId);
  if (!self) return null;
  const parentChain = chain.slice(0, -1);
  const parent = parentChain.length ? accessFromChain(parentChain, userId) : null;

  return {
    node: { ...row.node, thumb: row.thumb, volumeId: row.volumeId },
    access: self.access,
    parentAccess: parent?.access ?? null,
    breadcrumbs: chain.slice(self.from).map((c) => ({ id: c.id, name: c.name })),
    isRoot: row.node.parentId === null,
  };
}

/** Like loadAccess but throws: 404 when the caller cannot see the node, 403 when they can but lack `need`. */
export async function requireAccess(
  exec: Executor,
  userId: string,
  nodeId: string,
  need: Access,
): Promise<NodeAccess> {
  const result = await loadAccess(exec, userId, nodeId);
  if (!result) throw notFound();
  if (!satisfies(result.access, need)) throw forbidden();
  return result;
}

export async function requireFolder(
  exec: Executor,
  userId: string,
  nodeId: string,
  need: Access,
): Promise<NodeAccess> {
  const result = await requireAccess(exec, userId, nodeId, need);
  if (result.node.type !== 'folder') throw notFound('Folder');
  return result;
}
