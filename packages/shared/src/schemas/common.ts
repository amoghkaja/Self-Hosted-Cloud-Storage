import { z } from 'zod';
import { NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../constants';
import { nameProblem, normalizeName } from '../names';

export const Id = z.uuid();
export const IsoDate = z.iso.datetime();
export const Bytes = z.number().int().nonnegative();

export const IdParams = z.object({ id: Id });

/** Node names: NFC-normalized, trimmed, and free of separators/control characters. */
export const NodeName = z
  .string()
  .max(NAME_MAX_LENGTH * 4)
  .transform(normalizeName)
  .superRefine((name, ctx) => {
    const problem = nameProblem(name);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

// Trimmed and lowercased *before* the format check (a pasted " Mom@Example.com " is fine), so
// accounts are unique case-insensitively and sign-in matches however the address is typed.
export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const DisplayName = z.string().trim().min(1).max(80);

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;

export const UserRef = z.object({ id: Id, displayName: z.string() });
export type UserRef = z.infer<typeof UserRef>;

export const Ok = z.object({ ok: z.literal(true) });
