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

export const SetupStatus = z.object({ needsSetup: z.boolean(), appName: z.string() });
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
