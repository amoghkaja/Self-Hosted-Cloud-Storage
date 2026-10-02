import type { AdminUser, FileNode, Me, ThumbStatus } from '@familycloud/shared/all';
import type { NodeRow, UserRow } from '../db/schema';
import { toIso, toIsoOrNull } from './time';

/**
 * Row -> DTO mappers. They build explicit objects (never spread rows) so a new column such as a
 * secret hash can never leak into an API response by accident.
 */

export function toMe(u: UserRow): Me {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    quotaBytes: u.quotaBytes,
    usedBytes: u.usedBytes,
    totpEnabled: u.totpEnabled,
    rootNodeId: u.rootNodeId!,
  };
}

export function toAdminUser(u: UserRow, lastSeenAt: Date | string | null): AdminUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    quotaBytes: u.quotaBytes,
    usedBytes: u.usedBytes,
    reservedBytes: u.reservedBytes,
    totpEnabled: u.totpEnabled,
    disabled: u.disabledAt !== null,
    createdAt: toIso(u.createdAt),
    lastSeenAt: toIsoOrNull(lastSeenAt),
  };
}

export type NodeWithThumb = Pick<
  NodeRow,
  'id' | 'type' | 'name' | 'size' | 'mimeType' | 'parentId' | 'ownerId' | 'createdAt' | 'updatedAt'
> & { thumb?: ThumbStatus | null; scan?: string | null };

export function toFileNode(n: NodeWithThumb): FileNode {
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    size: Number(n.size),
    mimeType: n.mimeType,
    parentId: n.parentId,
    ownerId: n.ownerId,
    thumb: n.type === 'folder' ? 'none' : (n.thumb ?? 'none'),
    ...(n.scan === 'infected' ? { infected: true } : {}),
    ...(n.scan === 'held' ? { checking: true } : {}),
    createdAt: toIso(n.createdAt),
    updatedAt: toIso(n.updatedAt),
  };
}
