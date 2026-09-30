import { z } from 'zod';
import { BRAND_LOGO_MAX_BYTES, BRAND_LOGO_TYPES, GiB, TiB } from '../constants';
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
  /** Room for family files here after the reserve and capacity limit (null while offline). */
  usable: z.object({ totalBytes: Bytes, freeBytes: Bytes }).nullable(),
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
  /** How long a file's older versions are kept after it's saved over. 0 = don't keep them. */
  versionRetentionDays: z.number().int().min(0).max(365),
  /** Quota pre-filled for new invites. Null = unlimited. */
  defaultQuotaBytes: Bytes.max(MAX_BYTES).nullable(),
  /**
   * Only addresses at these domains may be invited or sign in (web, passkeys, network drive).
   * Empty = any address.
   */
  allowedEmailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(
          /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
          {
            message: 'Enter domains like example.com',
          },
        ),
    )
    .max(10),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  globalCapacityBytes: null,
  maxFileSizeBytes: null,
  trashRetentionDays: 30,
  versionRetentionDays: 30,
  defaultQuotaBytes: 50 * GiB,
  allowedEmailDomains: [],
};

export const UpdateSettingsBody = Settings.partial();

export const Branding = z.object({
  /** Text beside the logo, e.g. "Cloud". Null = the app name. */
  wordmark: z.string().trim().min(1).max(40).nullable(),
  /** Link back to the family's main website, shown on sign-in and in the menu. */
  homeUrl: z
    .string()
    .trim()
    .max(200)
    .regex(/^https?:\/\/[^\s/]+(\/\S*)?$/, 'Must be an http(s) address')
    .nullable(),
  /**
   * Shown on the Privacy page: who runs this server and how to reach them, and any terms of
   * their own (plain text).
   */
  privacyNotice: z.string().trim().max(2000).nullable(),
  hasLogo: z.boolean(),
});
export type Branding = z.infer<typeof Branding>;

export const UpdateBrandingBody = Branding.omit({ hasLogo: true }).partial();

export const UploadLogoBody = z.object({
  mimeType: z.enum(BRAND_LOGO_TYPES),
  /** Base64 file contents. */
  data: z.string().max(Math.ceil((BRAND_LOGO_MAX_BYTES * 4) / 3) + 4),
});

export const AdminOverview = z.object({
  volumes: z.array(Volume),
  users: z.array(AdminUser),
  settings: Settings,
  totals: z.object({
    /** Whole disks, each filesystem counted once. */
    diskTotalBytes: Bytes,
    diskFreeBytes: Bytes,
    /** Always-keep-free reserves on those disks. */
    reserveBytes: Bytes,
    /** Room for family files: stored + still free, after reserves and capacity limits. */
    usableTotalBytes: Bytes,
    usableFreeBytes: Bytes,
    /** What the family can use in total: the family limit, or the usable space if lower. */
    familyCapacityBytes: Bytes,
    usedBytes: Bytes,
    reservedBytes: Bytes,
    allocatedQuotaBytes: Bytes,
    unlimitedUsers: z.number().int(),
  }),
  warnings: z.array(z.string()),
  /** The Family Cloud release this server runs, e.g. v0.2.0 ("dev" when built from source). */
  version: z.string(),
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

/** Deleting an account: the admin types the person's email to confirm. */
export const DeleteUserBody = z.object({ confirmEmail: z.string().trim().max(254) });

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

/** A one-time link that lets a family member choose a new password. */
export const PasswordResetLink = z.object({ url: z.string(), expiresAt: IsoDate });
export type PasswordResetLink = z.infer<typeof PasswordResetLink>;

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
