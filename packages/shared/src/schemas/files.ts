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
});

export const UpdateNodeBody = z
  .object({ name: NodeName.optional(), parentId: Id.optional() })
  .refine((b) => b.name !== undefined || b.parentId !== undefined, 'Nothing to update');

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

export const CreateUploadBody = z.object({
  parentId: Id,
  name: NodeName,
  size: Bytes,
  mimeType: z.string().max(255).optional(),
});

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
