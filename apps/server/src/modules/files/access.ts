import type { Access, Breadcrumb, ThumbStatus } from '@familycloud/shared/all';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { blobs, type NodeRow, nodes, shares } from '../../db/schema';
import { conflict, forbidden, notFound } from '../../lib/errors';

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

/**
 * Re-checks, *inside the transaction that commits a new file*, that `userId` may still add files
 * to `folderId`, and locks the rows that grant it:
 * - the folder row (FOR NO KEY UPDATE): a concurrent trash of the folder waits for this commit;
 *   taken at the strength the commit's own folder update needs, so parallel uploads into one
 *   folder queue briefly instead of deadlocking on a lock upgrade;
 * - the granting share row (FOR SHARE): a concurrent revoke or edit→view change waits.
 * A revocation therefore lands entirely before this check (upload refused) or after the commit
 * (file already saved), never in between.
 * When saving over a file, pass it as `grantFromId`: an edit share on the file itself counts too.
 */
export async function lockWriteAccess(
  tx: Executor,
  userId: string,
  folderId: string,
  grantFromId: string = folderId,
): Promise<{ id: string; ownerId: string }> {
  const [folder] = await tx
    .select({ id: nodes.id, ownerId: nodes.ownerId, type: nodes.type, deletedAt: nodes.deletedAt })
    .from(nodes)
    .where(eq(nodes.id, folderId))
    .for('no key update');
  if (!folder || folder.deletedAt || folder.type !== 'folder') {
    throw conflict('The destination folder was deleted');
  }
  if (folder.ownerId === userId) return folder;

  const ancestors = (await tx.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = ${grantFromId}
      UNION ALL
      SELECT n.id, n.parent_id, u.depth + 1 FROM nodes n JOIN up u ON n.id = u.parent_id WHERE u.depth < 512
    )
    SELECT id FROM up
  `)) as unknown as { id: string }[];
  const [grant] = await tx
    .select({ id: shares.id })
    .from(shares)
    .where(
      and(
        eq(shares.granteeId, userId),
        eq(shares.permission, 'edit'),
        inArray(
          shares.nodeId,
          ancestors.map((a) => a.id),
        ),
      ),
    )
    .limit(1)
    .for('share');
  if (!grant) throw forbidden('You no longer have permission to add files to this folder');
  return folder;
}
