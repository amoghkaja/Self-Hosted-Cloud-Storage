/**
 * Stable machine-readable error codes returned in RFC 9457 problem+json bodies (`code` field).
 * Clients switch on these, never on human-readable messages.
 */
export const ErrorCode = {
  VALIDATION: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  NAME_CONFLICT: 'NAME_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  MFA_INVALID: 'MFA_INVALID',
  /** A passkey sign-in or registration could not be verified. */
  PASSKEY_INVALID: 'PASSKEY_INVALID',
  /** Stored two-factor secrets can't be decrypted (SECRET_KEY changed); an admin must reset 2FA. */
  MFA_UNAVAILABLE: 'MFA_UNAVAILABLE',
  SETUP_COMPLETE: 'SETUP_COMPLETE',
  INVITE_INVALID: 'INVITE_INVALID',
  /** A password-reset link that is unknown, used, expired or replaced by a newer one. */
  RESET_INVALID: 'RESET_INVALID',
  /** The address isn't in the admin's "allowed email domains" list. */
  EMAIL_DOMAIN: 'EMAIL_DOMAIN',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
  STORAGE_FULL: 'STORAGE_FULL',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  VOLUME_OFFLINE: 'VOLUME_OFFLINE',
  UPLOAD_STATE: 'UPLOAD_STATE',
  CHUNK_INVALID: 'CHUNK_INVALID',
  INVALID_MOVE: 'INVALID_MOVE',
  LINK_LOCKED: 'LINK_LOCKED',
  LINK_EXPIRED: 'LINK_EXPIRED',
  BLOB_MISSING: 'BLOB_MISSING',
  FILE_INFECTED: 'FILE_INFECTED',
  FILE_SCANNING: 'FILE_SCANNING',
  CSRF: 'CSRF_REJECTED',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  issues?: { path: string; message: string }[];
}
