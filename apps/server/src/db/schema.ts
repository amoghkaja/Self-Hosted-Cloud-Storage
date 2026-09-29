import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytes = (name: string) => bigint(name, { mode: 'number' });

export const userRole = pgEnum('user_role', ['admin', 'member']);
// Declaration order matters: folders sort before files in listings.
export const nodeType = pgEnum('node_type', ['folder', 'file']);
export const volumeStatus = pgEnum('volume_status', ['active', 'draining', 'readonly', 'retired']);
export const thumbStatus = pgEnum('thumb_status', [
  'none',
  'pending',
  'ready',
  'failed',
  'unsupported',
]);
export const streamStatus = pgEnum('stream_status', [
  'none',
  'pending',
  'ready',
  'original',
  'failed',
]);
export const uploadStatus = pgEnum('upload_status', [
  'uploading',
  'finalizing',
  'completed',
  'aborted',
  'expired',
]);
export const sharePermission = pgEnum('share_permission', ['view', 'edit']);

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('member'),
    /** Null = unlimited. May be set below usedBytes; uploads are then blocked until usage drops. */
    quotaBytes: bytes('quota_bytes'),
    usedBytes: bytes('used_bytes').notNull().default(0),
    /** Bytes promised to in-flight uploads; counted against quota so parallel uploads cannot overshoot. */
    reservedBytes: bytes('reserved_bytes').notNull().default(0),
    rootNodeId: uuid('root_node_id'),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    /** Last accepted TOTP time-step; codes at or before it are rejected (replay protection). */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    disabledAt: ts('disabled_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_usage_nonneg', sql`${t.usedBytes} >= 0 AND ${t.reservedBytes} >= 0`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    absoluteExpiresAt: ts('absolute_expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    email: text('email'),
    role: userRole('role').notNull().default('member'),
    quotaBytes: bytes('quota_bytes'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('invites_token_hash_key').on(t.tokenHash)],
);

/**
 * One-time links an admin makes so a family member who forgot their password can choose a new
 * one. Only the newest unused link for a person works; tokens are stored hashed.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_resets_token_hash_key').on(t.tokenHash),
    index('password_resets_user_idx').on(t.userId),
  ],
);

export const storageVolumes = pgTable(
  'storage_volumes',
  {
    id: id(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    status: volumeStatus('status').notNull().default('active'),
    capacityLimitBytes: bytes('capacity_limit_bytes'),
    reserveBytes: bytes('reserve_bytes').notNull().default(0),
    statusMessage: text('status_message'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('storage_volumes_path_key').on(t.path)],
);

export const blobs = pgTable(
  'blobs',
  {
    id: id(),
    volumeId: uuid('volume_id')
      .notNull()
      .references(() => storageVolumes.id),
    size: bytes('size').notNull(),
    sha256: text('sha256'),
    thumbStatus: thumbStatus('thumb_status').notNull().default('none'),
    /**
     * Videos: a 720p H.264 copy for streaming, in the cache ('ready'); 'original' when the file
     * already streams well everywhere; 'none' for anything that isn't a video.
     */
    streamStatus: streamStatus('stream_status').notNull().default('none'),
    /** Office documents: a PDF rendering for in-browser viewing, in the cache. */
    previewStatus: streamStatus('preview_status').notNull().default('none'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('blobs_volume_idx').on(t.volumeId)],
);

export const nodes = pgTable(
  'nodes',
  {
    id: id(),
    /** Owner of the tree the node lives in; quota is charged here even for uploads by share grantees. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => nodes.id, { onDelete: 'cascade' }),
    type: nodeType('type').notNull(),
    name: text('name').notNull(),
    blobId: uuid('blob_id').references(() => blobs.id, { onDelete: 'restrict' }),
    size: bytes('size').notNull().default(0),
    mimeType: text('mime_type'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Who last saved new contents into this file (null: nobody since `createdBy` made it). */
    modifiedBy: uuid('modified_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
    /** Top-most node of the trash operation that removed this node (itself for the trashed item). */
    trashRootId: uuid('trash_root_id'),
  },
  (t) => [
    // Live names are unique per folder, case-insensitively.
    uniqueIndex('nodes_parent_name_key')
      .on(t.parentId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
    // Exactly one root folder per user.
    uniqueIndex('nodes_owner_root_key').on(t.ownerId).where(sql`${t.parentId} IS NULL`),
    // Keyset pagination for "folders first, then name" in natural order ("IMG_2" before "IMG_10").
    index('nodes_children_idx')
      .on(t.parentId, t.type, sql`(lower(${t.name}) COLLATE "natural")`, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index('nodes_trash_root_idx').on(t.trashRootId),
    index('nodes_owner_deleted_idx').on(t.ownerId, t.deletedAt),
    index('nodes_blob_idx').on(t.blobId),
    index('nodes_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

/**
 * Earlier contents of a file, kept when it is saved over (network drive, "Replace" on upload,
 * restoring another version). They count toward the file owner's storage and expire after the
 * admin's retention period; blobs they point at are never deleted while they exist.
 */
export const fileVersions = pgTable(
  'file_versions',
  {
    id: id(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    blobId: uuid('blob_id')
      .notNull()
      .references(() => blobs.id, { onDelete: 'restrict' }),
    size: bytes('size').notNull(),
    mimeType: text('mime_type'),
    /** When this content was saved, and by whom. */
    modifiedAt: ts('modified_at').notNull(),
    modifiedBy: uuid('modified_by').references(() => users.id, { onDelete: 'set null' }),
    /** When newer content replaced it: retention counts from here. */
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('file_versions_node_idx').on(t.nodeId, t.createdAt),
    index('file_versions_blob_idx').on(t.blobId),
    index('file_versions_created_idx').on(t.createdAt),
  ],
);
export type FileVersionRow = typeof fileVersions.$inferSelect;

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Whose quota the reservation is held against (owner of the destination folder). */
    chargeUserId: uuid('charge_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').notNull(),
    name: text('name').notNull(),
    size: bytes('size').notNull(),
    mimeType: text('mime_type').notNull(),
    chunkSize: integer('chunk_size').notNull(),
    totalChunks: integer('total_chunks').notNull(),
    receivedCount: integer('received_count').notNull().default(0),
    volumeId: uuid('volume_id')
      .notNull()
      .references(() => storageVolumes.id),
    blobId: uuid('blob_id').notNull(),
    nodeId: uuid('node_id'),
    /** Save over a file of the same name in the folder (keeping its old version) instead of "name (1)". */
    replaceExisting: boolean('replace_existing').notNull().default(false),
    status: uploadStatus('status').notNull().default('uploading'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('upload_sessions_user_status_idx').on(t.userId, t.status),
    index('upload_sessions_status_expires_idx').on(t.status, t.expiresAt),
  ],
);

export const uploadChunks = pgTable(
  'upload_chunks',
  {
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => uploadSessions.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.idx] })],
);

export const shares = pgTable(
  'shares',
  {
    id: id(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    granteeId: uuid('grantee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: sharePermission('permission').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shares_node_grantee_key').on(t.nodeId, t.granteeId),
    index('shares_grantee_idx').on(t.granteeId),
  ],
);

export const shareLinks = pgTable(
  'share_links',
  {
    id: id(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** AES-GCM encrypted token so the owner can copy the link again later. */
    tokenEnc: text('token_enc').notNull(),
    passwordHash: text('password_hash'),
    allowDownload: boolean('allow_download').notNull().default(true),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    lastAccessedAt: ts('last_accessed_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('share_links_token_hash_key').on(t.tokenHash),
    index('share_links_node_idx').on(t.nodeId),
  ],
);

/** Per-device passwords for WebDAV clients (Files app helpers, Finder, Windows). Revocable. */
export const appPasswords = pgTable(
  'app_passwords',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** sha256 of a 100-bit random secret (high entropy, so a fast hash is appropriate). */
    tokenHash: text('token_hash').notNull(),
    lastUsedAt: ts('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_passwords_token_hash_key').on(t.tokenHash),
    index('app_passwords_user_idx').on(t.userId),
  ],
);

/** WebAuthn passkeys: public keys only, so a database leak reveals nothing that signs in. */
export const passkeys = pgTable(
  'passkeys',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** base64url credential id, as the browser reports it. */
    credentialId: text('credential_id').notNull(),
    /** base64url COSE public key. */
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>(),
    /** Synced passkey (iCloud Keychain etc.) rather than one bound to a single device. */
    backedUp: boolean('backed_up').notNull().default(false),
    lastUsedAt: ts('last_used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('passkeys_credential_id_key').on(t.credentialId),
    index('passkeys_user_idx').on(t.userId),
  ],
);
export type PasskeyRow = typeof passkeys.$inferSelect;

/**
 * Trip albums (the Photos section). An album owns no files itself: each person on the trip gets
 * a folder in their own space ("Trips/<album>"), so their photos count against their own quota
 * and show up in My Files and the network drive too. The album is everything in those folders.
 */
export const albums = pgTable(
  'albums',
  {
    id: id(),
    title: text('title').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Chosen cover photo; falls back to the first photo. */
    coverNodeId: uuid('cover_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('albums_start_idx').on(t.startDate),
    check('albums_dates_check', sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);
export type AlbumRow = typeof albums.$inferSelect;

/** Who was on the trip: shown on the album and allowed to add photos. */
export const albumPeople = pgTable(
  'album_people',
  {
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.albumId, t.userId] }),
    index('album_people_user_idx').on(t.userId),
  ],
);

/** Each contributor's folder for an album. Deleting the folder removes their photos from it. */
export const albumFolders = pgTable(
  'album_folders',
  {
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.albumId, t.userId] }),
    uniqueIndex('album_folders_folder_key').on(t.folderId),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

export type UserRow = typeof users.$inferSelect;
export type NodeRow = typeof nodes.$inferSelect;
export type BlobRow = typeof blobs.$inferSelect;
export type VolumeRow = typeof storageVolumes.$inferSelect;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
