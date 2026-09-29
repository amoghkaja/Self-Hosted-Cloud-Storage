import { z } from 'zod';
import { Bytes, DisplayName, Email, Id, IsoDate, Password, UserRole } from './common';

export const Me = z.object({
  id: Id,
  email: z.string(),
  displayName: z.string(),
  role: UserRole,
  quotaBytes: Bytes.nullable(),
  usedBytes: Bytes,
  totpEnabled: z.boolean(),
  rootNodeId: Id,
});
export type Me = z.infer<typeof Me>;

export const StorageInfo = z.object({
  usedBytes: Bytes,
  quotaBytes: Bytes.nullable(),
  /** What can still be uploaded now: the tightest of quota, family limit and free disk space. */
  availableBytes: Bytes,
});
export type StorageInfo = z.infer<typeof StorageInfo>;

export const SetupStatus = z.object({
  needsSetup: z.boolean(),
  appName: z.string(),
  /** Text shown next to the logo; defaults to the app name. */
  wordmark: z.string(),
  /** Changes whenever the admin uploads a new logo; null = built-in logo. */
  logoVersion: z.string().nullable(),
  /** Optional link back to the family's main website. */
  homeUrl: z.string().nullable(),
  /** Where this server's source code is published (AGPL-3.0). */
  sourceUrl: z.string(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupBody = z.object({
  setupToken: z.string().min(1).max(200),
  email: Email,
  displayName: DisplayName,
  password: Password,
});

export const LoginBody = z.object({
  email: Email,
  password: z.string().min(1).max(256),
});

export const LoginResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), user: Me }),
  z.object({ status: z.literal('mfa_required'), mfaToken: z.string() }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const TotpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');

export const LoginTotpBody = z.object({ mfaToken: z.string().min(1).max(1000), code: TotpCode });

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: Password,
});

export const UpdateProfileBody = z.object({ displayName: DisplayName });

export const TotpSetupResponse = z.object({ secret: z.string(), otpauthUrl: z.string() });
export const TotpEnableBody = z.object({ code: TotpCode });
export const TotpDisableBody = z.object({ password: z.string().min(1).max(256), code: TotpCode });

export const SessionInfo = z.object({
  id: Id,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: IsoDate,
  lastSeenAt: IsoDate,
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const InviteInfo = z.object({
  email: z.string().nullable(),
  role: UserRole,
  expiresAt: IsoDate,
  invitedBy: z.string(),
});
export type InviteInfo = z.infer<typeof InviteInfo>;

export const AcceptInviteBody = z.object({
  email: Email,
  displayName: DisplayName,
  password: Password,
});

export const TokenParams = z.object({ token: z.string().min(16).max(200) });

// ── app passwords (network drive / WebDAV) ──────────────────────────────────

export const AppPassword = z.object({
  id: Id,
  name: z.string(),
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
});
export type AppPassword = z.infer<typeof AppPassword>;

export const CreateAppPasswordBody = z.object({ name: z.string().trim().min(1).max(60) });

export const CreateAppPasswordResponse = z.object({
  appPassword: AppPassword,
  /** Shown once. Formatted in dash-separated groups for easy typing on a phone. */
  password: z.string(),
  davUrl: z.string(),
  username: z.string(),
});
export type CreateAppPasswordResponse = z.infer<typeof CreateAppPasswordResponse>;

// ── passkeys ────────────────────────────────────────────────────────────────

export const Passkey = z.object({
  id: Id,
  name: z.string(),
  /** Synced across the person's devices (e.g. iCloud Keychain). */
  backedUp: z.boolean(),
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
});
export type Passkey = z.infer<typeof Passkey>;

export const PasskeyName = z.string().trim().min(1).max(60);

/** WebAuthn options for the browser plus a signed token that carries the challenge. */
export const PasskeyOptions = z.object({
  options: z.record(z.string(), z.unknown()),
  token: z.string(),
});
export type PasskeyOptions = z.infer<typeof PasskeyOptions>;

/** The browser's credential JSON; its structure is checked by the WebAuthn verifier. */
const CredentialJson = z.record(z.string(), z.unknown());

export const RegisterPasskeyBody = z.object({
  token: z.string().max(2000),
  response: CredentialJson,
  name: PasskeyName.optional(),
});

export const PasskeyLoginBody = z.object({
  token: z.string().max(2000),
  response: CredentialJson,
});

export const RenamePasskeyBody = z.object({ name: PasskeyName });
