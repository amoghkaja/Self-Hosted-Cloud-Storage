import { z } from 'zod';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants';
import { Bytes, Id, IsoDate, NodeName, UserRef } from './common';

export const NodeType = z.enum(['folder', 'file']);
export type NodeType = z.infer<typeof NodeType>;

export const Access = z.enum(['owner', 'edit', 'view']);
export type Access = z.infer<typeof Access>;

export const ThumbStatus = z.enum(['none', 'pending', 'ready', 'failed', 'unsupported']);
export type ThumbStatus = z.infer<typeof ThumbStatus>;

export const FileNode = z.object({
  id: Id,
  type: NodeType,
  name: z.string(),
  size: Bytes,
  mimeType: z.string().nullable(),
  parentId: Id.nullable(),
  ownerId: Id,
  thumb: ThumbStatus,
  /** A virus was found in it: it can't be opened or downloaded, only deleted. */
  infected: z.boolean().optional(),
  /** Sent through a file request and still waiting for its virus check: not openable yet. */
  checking: z.boolean().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type FileNode = z.infer<typeof FileNode>;

export const Breadcrumb = z.object({ id: Id, name: z.string() });
export type Breadcrumb = z.infer<typeof Breadcrumb>;

export const NodeDetail = z.object({
  node: FileNode,
  access: Access,
  owner: UserRef,
  /** Path from the top-most node the caller may see (their root or a share root) to this node. */
  breadcrumbs: z.array(Breadcrumb),
  isRoot: z.boolean(),
  /** Set when this folder feeds a trip album: everything in it is visible to the whole family. */
  album: z.object({ id: Id, title: z.string() }).nullable(),
});
export type NodeDetail = z.infer<typeof NodeDetail>;

export const SortKey = z.enum(['name', 'updated', 'size']);
export type SortKey = z.infer<typeof SortKey>;
export const SortDir = z.enum(['asc', 'desc']);
export type SortDir = z.infer<typeof SortDir>;

export const ChildrenQuery = z.object({
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  sort: SortKey.default('name'),
  dir: SortDir.default('asc'),
});
export type ChildrenQuery = z.infer<typeof ChildrenQuery>;

export const NodePage = z.object({ items: z.array(FileNode), nextCursor: z.string().nullable() });
export type NodePage = z.infer<typeof NodePage>;

export const CreateFolderBody = z.object({
  parentId: Id,
  name: NodeName,
  /** When true and a folder with this name exists, return it instead of failing (folder uploads). */
  reuseExisting: z.boolean().default(false),
  /** When true and the name is taken, make "name (2)" instead of failing. */
  renameIfTaken: z.boolean().default(false),
});

/** Copy into `parentId`; the name defaults to the original's ("name (copy)" in the same folder). */
export const CopyNodeBody = z.object({ parentId: Id, name: NodeName.optional() });

export const UpdateNodeBody = z
  .object({ name: NodeName.optional(), parentId: Id.optional() })
  .refine((b) => b.name !== undefined || b.parentId !== undefined, 'Nothing to update');

export const RecentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ContentQuery = z.object({
  inline: z.enum(['0', '1']).default('0'),
});

export const ThumbQuery = z.object({
  size: z.coerce
    .number()
    .pipe(z.union([z.literal(256), z.literal(1600)]))
    .default(256),
});

export const ZipQuery = z.object({
  ids: z
    .string()
    .max(37 * 500)
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(Id).min(1).max(500)),
});

// ── uploads ─────────────────────────────────────────────────────────────────

/**
 * What to do when the folder already has a file with this name: add this one as "name (1)"
 * (default), or save over it, keeping the old contents as a version.
 */
export const UploadConflict = z.enum(['rename', 'replace']);
export type UploadConflict = z.infer<typeof UploadConflict>;

export const CreateUploadBody = z.object({
  parentId: Id,
  name: NodeName,
  size: Bytes,
  mimeType: z.string().max(255).optional(),
  onConflict: UploadConflict.default('rename'),
});

/**
 * "Do you already have this file?" The browser sends the file's SHA-256; when a file with the
 * same contents is already stored (and visible to the uploader), the new file points at it and
 * no bytes are sent.
 */
export const InstantUploadBody = CreateUploadBody.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256'),
});
export const InstantUploadResult = z.object({ node: FileNode.nullable() });
export type InstantUploadResult = z.infer<typeof InstantUploadResult>;

export const UploadStatus = z.enum(['uploading', 'finalizing', 'completed', 'aborted', 'expired']);

export const UploadSession = z.object({
  id: Id,
  name: z.string(),
  size: Bytes,
  chunkSize: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  receivedChunks: z.array(z.number().int().nonnegative()),
  status: UploadStatus,
  expiresAt: IsoDate,
  node: FileNode.nullable(),
});
export type UploadSession = z.infer<typeof UploadSession>;

export const ChunkParams = z.object({
  id: Id,
  index: z.coerce.number().int().min(0).max(1_000_000),
});

export const ChunkResult = z.object({
  receivedCount: z.number().int(),
  totalChunks: z.number().int(),
  status: UploadStatus,
  node: FileNode.nullable(),
});
export type ChunkResult = z.infer<typeof ChunkResult>;

/** Which of these names are already taken in a folder (to ask "replace or keep both?"). */
export const NameCheckBody = z.object({ names: z.array(NodeName).min(1).max(1000) });
export const NameCheckResult = z.object({
  files: z.array(z.string()),
  folders: z.array(z.string()),
  /** How long a replaced file's old contents are kept (0: replacing deletes them). */
  versionRetentionDays: z.number().int(),
});
export type NameCheckResult = z.infer<typeof NameCheckResult>;

// ── versions ────────────────────────────────────────────────────────────────

export const FileVersion = z.object({
  id: Id,
  size: Bytes,
  mimeType: z.string().nullable(),
  /** When this content was saved, and by whom. */
  modifiedAt: IsoDate,
  modifiedBy: UserRef.nullable(),
  /** When it was replaced by newer content (it expires counting from here). */
  replacedAt: IsoDate,
});
export type FileVersion = z.infer<typeof FileVersion>;

export const VersionList = z.object({
  current: z.object({ size: Bytes, modifiedAt: IsoDate, modifiedBy: UserRef.nullable() }),
  items: z.array(FileVersion),
  /** Days versions are kept (0: new versions aren't kept). */
  retentionDays: z.number().int(),
  /** Only the owner may delete versions. */
  canDelete: z.boolean(),
});
export type VersionList = z.infer<typeof VersionList>;

export const VersionParams = z.object({ id: Id, versionId: Id });

// ── trash ───────────────────────────────────────────────────────────────────

export const TrashItem = z.object({
  id: Id,
  type: NodeType,
  name: z.string(),
  size: Bytes,
  mimeType: z.string().nullable(),
  thumb: ThumbStatus,
  deletedAt: IsoDate,
  originalParent: z.object({ id: Id, name: z.string() }).nullable(),
});
export type TrashItem = z.infer<typeof TrashItem>;

export const TrashList = z.object({ items: z.array(TrashItem), retentionDays: z.number().int() });
export type TrashList = z.infer<typeof TrashList>;

export const RestoreResult = z.object({ node: FileNode });
