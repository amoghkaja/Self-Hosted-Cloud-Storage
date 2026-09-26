import { z } from 'zod';
import { GiB, TiB } from '../constants';
import { Bytes, DisplayName, Email, Id, IsoDate, UserRef, UserRole } from './common';

const MAX_BYTES = 1024 * TiB;

export const VolumeStatus = z.enum(['active', 'draining', 'readonly', 'retired']);
export type VolumeStatus = z.infer<typeof VolumeStatus>;

export const DiskStats = z.object({ totalBytes: Bytes, freeBytes: Bytes });

export const Volume = z.object({
  id: Id,
  name: z.string(),
  path: z.string(),
  status: VolumeStatus,
  /** Runtime health: marker file present and readable. */
  online: z.boolean(),
  capacityLimitBytes: Bytes.nullable(),
  reserveBytes: Bytes,
  usedByAppBytes: Bytes,
  blobCount: z.number().int(),
  disk: DiskStats.nullable(),
  statusMessage: z.string().nullable(),
  createdAt: IsoDate,
});
export type Volume = z.infer<typeof Volume>;

export const AdminUser = z.object({
  id: Id,
  email: z.string(),
  displayName: z.string(),
  role: UserRole,
  quotaBytes: Bytes.nullable(),
  usedBytes: Bytes,
  reservedBytes: Bytes,
  totpEnabled: z.boolean(),
  disabled: z.boolean(),
  createdAt: IsoDate,
  lastSeenAt: IsoDate.nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const Settings = z.object({
  /** Upper bound for all accounts combined (used + in-flight uploads). Null = physical disks only. */
  globalCapacityBytes: Bytes.max(MAX_BYTES).nullable(),
  maxFileSizeBytes: Bytes.max(MAX_BYTES).nullable(),
  trashRetentionDays: z.number().int().min(1).max(365),
  /** Quota pre-filled for new invites. Null = unlimited. */
  defaultQuotaBytes: Bytes.max(MAX_BYTES).nullable(),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  globalCapacityBytes: null,
  maxFileSizeBytes: null,
  trashRetentionDays: 30,
  defaultQuotaBytes: 50 * GiB,
};

export const UpdateSettingsBody = Settings.partial();

export const AdminOverview = z.object({
  volumes: z.array(Volume),
  users: z.array(AdminUser),
  settings: Settings,
  totals: z.object({
    physicalTotalBytes: Bytes,
    physicalFreeBytes: Bytes,
    usedBytes: Bytes,
    reservedBytes: Bytes,
    allocatedQuotaBytes: Bytes,
    unlimitedUsers: z.number().int(),
  }),
  warnings: z.array(z.string()),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

export const UpdateUserBody = z
  .object({
    displayName: DisplayName.optional(),
    role: UserRole.optional(),
    quotaBytes: Bytes.max(MAX_BYTES).nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const AdminInvite = z.object({
  id: Id,
  email: z.string().nullable(),
  role: UserRole,
  quotaBytes: Bytes.nullable(),
  expiresAt: IsoDate,
  createdAt: IsoDate,
  createdBy: UserRef.nullable(),
});
export type AdminInvite = z.infer<typeof AdminInvite>;

export const CreateInviteBody = z.object({
  email: Email.nullable().optional(),
  role: UserRole.default('member'),
  quotaBytes: Bytes.max(MAX_BYTES).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const CreateInviteResponse = z.object({ invite: AdminInvite, url: z.string() });

export const VolumeCandidate = z.object({
  path: z.string(),
  name: z.string(),
  totalBytes: Bytes,
  freeBytes: Bytes,
  /** Name of an existing volume on the same physical filesystem, if any (adds no capacity). */
  sameFilesystemAs: z.string().nullable(),
});
export type VolumeCandidate = z.infer<typeof VolumeCandidate>;

export const AddVolumeBody = z.object({
  name: z.string().trim().min(1).max(64),
  path: z.string().min(1).max(4096),
  capacityLimitBytes: Bytes.max(MAX_BYTES).nullable().optional(),
  reserveBytes: Bytes.max(MAX_BYTES).optional(),
});

export const UpdateVolumeBody = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    status: z.enum(['active', 'readonly']).optional(),
    capacityLimitBytes: Bytes.max(MAX_BYTES).nullable().optional(),
    reserveBytes: Bytes.max(MAX_BYTES).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const AuditEntry = z.object({
  id: z.number().int(),
  actor: UserRef.nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: IsoDate,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const AuditPage = z.object({
  items: z.array(AuditEntry),
  nextCursor: z.number().int().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;
