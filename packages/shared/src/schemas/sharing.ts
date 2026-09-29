import { z } from 'zod';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants';
import { Bytes, Id, IsoDate, UserRef } from './common';
import { Breadcrumb, FileNode, NodeType, ThumbStatus } from './files';

export const SharePermission = z.enum(['view', 'edit']);
export type SharePermission = z.infer<typeof SharePermission>;

export const DirectoryUser = z.object({ id: Id, displayName: z.string(), email: z.string() });
export type DirectoryUser = z.infer<typeof DirectoryUser>;

export const Share = z.object({
  id: Id,
  nodeId: Id,
  grantee: DirectoryUser,
  permission: SharePermission,
  createdAt: IsoDate,
});
export type Share = z.infer<typeof Share>;

export const CreateShareBody = z.object({ userId: Id, permission: SharePermission });
export const UpdateShareBody = z.object({ permission: SharePermission });

export const SharedWithMeItem = z.object({
  shareId: Id,
  permission: SharePermission,
  node: FileNode,
  owner: UserRef,
  sharedAt: IsoDate,
});
export type SharedWithMeItem = z.infer<typeof SharedWithMeItem>;

// ── public links ────────────────────────────────────────────────────────────

export const ShareLink = z.object({
  id: Id,
  nodeId: Id,
  /** Null when the link was made under an earlier SECRET_KEY: it can still be revoked. */
  url: z.string().nullable(),
  hasPassword: z.boolean(),
  allowDownload: z.boolean(),
  expiresAt: IsoDate.nullable(),
  createdAt: IsoDate,
  lastAccessedAt: IsoDate.nullable(),
});
export type ShareLink = z.infer<typeof ShareLink>;

/** Something the user shares with family or by link, for the "Shared by me" page. */
export const SharedByMeItem = z.object({
  node: FileNode,
  people: z.array(Share),
  links: z.array(ShareLink),
});
export type SharedByMeItem = z.infer<typeof SharedByMeItem>;

export const CreateLinkBody = z.object({
  password: z.string().min(4).max(128).optional(),
  expiresAt: IsoDate.nullable().optional(),
  allowDownload: z.boolean().default(true),
});

export const PublicNode = z.object({
  id: Id,
  type: NodeType,
  name: z.string(),
  size: Bytes,
  mimeType: z.string().nullable(),
  thumb: ThumbStatus,
  updatedAt: IsoDate,
});
export type PublicNode = z.infer<typeof PublicNode>;

export const PublicLinkInfo = z.object({
  locked: z.boolean(),
  allowDownload: z.boolean(),
  expiresAt: IsoDate.nullable(),
  sharedBy: z.string(),
  /** Null while the link is password-protected and not yet unlocked. */
  node: PublicNode.nullable(),
});
export type PublicLinkInfo = z.infer<typeof PublicLinkInfo>;

export const PublicFolder = z.object({
  folder: PublicNode,
  breadcrumbs: z.array(Breadcrumb),
  items: z.array(PublicNode),
  nextCursor: z.string().nullable(),
});
export type PublicFolder = z.infer<typeof PublicFolder>;

export const UnlockLinkBody = z.object({ password: z.string().min(1).max(128) });

export const PublicFolderQuery = z.object({
  folderId: Id.optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export const PublicNodeParams = z.object({
  token: z.string().min(16).max(200),
  nodeId: Id,
});
