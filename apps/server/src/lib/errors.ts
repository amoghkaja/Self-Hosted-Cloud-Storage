import { ErrorCode } from '@familycloud/shared/all';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Not-found and forbidden look identical to callers so resource existence never leaks (IDOR hygiene).
export const notFound = (what = 'Item') =>
  new AppError(404, ErrorCode.NOT_FOUND, `${what} not found`);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, ErrorCode.FORBIDDEN, message);
export const badRequest = (message: string, code: ErrorCode = ErrorCode.VALIDATION) =>
  new AppError(400, code, message);
export const conflict = (message: string, code: ErrorCode = ErrorCode.CONFLICT) =>
  new AppError(409, code, message);
export const unauthenticated = (message = 'Please sign in') =>
  new AppError(401, ErrorCode.UNAUTHENTICATED, message);

/** Postgres unique_violation, optionally for a specific constraint/index name. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = findPgError(err);
  return e?.code === '23505' && (!constraint || e.constraint_name === constraint);
}

/** Text Postgres can't store (a NUL, in text or JSON): it can only have come from the request. */
export function isUnstorableText(err: unknown): boolean {
  const code = findPgError(err)?.code;
  return code === '22021' || code === '22P05';
}

function findPgError(err: unknown): { code?: string; constraint_name?: string } | null {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const c = cur as { code?: unknown; cause?: unknown; constraint_name?: string };
    if (typeof c.code === 'string' && /^\d{2}[0-9A-Z]{3}$/.test(c.code)) {
      return c as { code: string; constraint_name?: string };
    }
    cur = c.cause;
  }
  return null;
}
