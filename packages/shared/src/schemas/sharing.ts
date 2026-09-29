import { z } from 'zod';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants';
import { Bytes, Id, IsoDate, NodeName, UserRef } from './common';
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

/** "view": see (and maybe download) what's shared. "upload": a file request, send files only. */
export const LinkKind = z.enum(['view', 'upload']);
export type LinkKind = z.infer<typeof LinkKind>;

export const ShareLink = z.object({
  id: Id,
  nodeId: Id,
  kind: LinkKind,
  /** File requests: what's being asked for. */
  title: z.string().nullable(),
  /** Null when the link was made under an earlier SECRET_KEY: it can still be revoked. */
  url: z.string().nullable(),
  hasPassword: z.boolean(),
  allowDownload: z.boolean(),
  downloadCount: z.number().int(),
  maxDownloads: z.number().int().nullable(),
  /** File requests: files received so far, their total size, and the most it takes. */
  uploadCount: z.number().int(),
  uploadBytes: Bytes,
  maxUploadBytes: Bytes.nullable(),
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
  kind: LinkKind.default('view'),
  title: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(4).max(128).optional(),
  expiresAt: IsoDate.nullable().optional(),
  allowDownload: z.boolean().default(true),
  /** Stop working after this many downloads. */
  maxDownloads: z.number().int().min(1).max(10_000).nullable().optional(),
  /** File requests: stop taking files past this total (null: no limit but the quota). */
  maxUploadBytes: Bytes.max(1024 ** 5)
    .nullable()
    .optional(),
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
  kind: LinkKind,
  /** File requests: what's being asked for. */
  title: z.string().nullable(),
  locked: z.boolean(),
  allowDownload: z.boolean(),
  expiresAt: IsoDate.nullable(),
  sharedBy: z.string(),
  /** Null while the link is password-protected and not yet unlocked, and always for requests. */
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

// ── file requests (sending files without an account) ────────────────────────

export const PublicUploadBody = z.object({
  name: NodeName,
  size: Bytes,
  mimeType: z.string().max(255).optional(),
  /** The sender's name; their files go into a folder named after them. */
  from: z.string().trim().max(60).optional(),
});

/** An upload through a file request. Deliberately says nothing about the folder it lands in. */
export const PublicUploadSession = z.object({
  id: Id,
  name: z.string(),
  size: Bytes,
  chunkSize: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  receivedChunks: z.array(z.number().int().nonnegative()),
  status: z.enum(['uploading', 'finalizing', 'completed', 'aborted', 'expired']),
  expiresAt: IsoDate,
  done: z.boolean(),
});
export type PublicUploadSession = z.infer<typeof PublicUploadSession>;

export const PublicChunkResult = z.object({
  receivedCount: z.number().int(),
  totalChunks: z.number().int(),
  status: z.enum(['uploading', 'finalizing', 'completed', 'aborted', 'expired']),
  done: z.boolean(),
});
export type PublicChunkResult = z.infer<typeof PublicChunkResult>;

export const PublicUploadParams = z.object({ token: z.string().min(16).max(200), id: Id });
export const PublicChunkParams = PublicUploadParams.extend({
  index: z.coerce.number().int().min(0).max(1_000_000),
});
