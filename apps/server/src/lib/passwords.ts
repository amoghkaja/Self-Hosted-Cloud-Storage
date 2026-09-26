import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies a password. When `stored` is null (unknown user) a dummy hash is checked instead so
 * response timing does not reveal which emails have accounts.
 */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hash('dummy-password-for-timing', OPTIONS);
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
