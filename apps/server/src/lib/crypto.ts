import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** URL-safe random token. 32 bytes = 256 bits for sessions; 16+ bytes for links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Derives purpose-specific keys from SECRET_KEY so a leak of one derived key (or a bug in one
 * feature) does not compromise the others.
 */
export class Keyring {
  private readonly cache = new Map<string, Buffer>();
  constructor(private readonly secret: string) {}

  key(purpose: string): Buffer {
    let k = this.cache.get(purpose);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', this.secret, 'familycloud', purpose, 32));
      this.cache.set(purpose, k);
    }
    return k;
  }

  /** Compact signed token: base64url(json).base64url(hmac). Includes an expiry. */
  sign(purpose: string, payload: Record<string, unknown>, ttlSeconds: number): string {
    const body = Buffer.from(
      JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
    ).toString('base64url');
    const mac = createHmac('sha256', this.key(`sign:${purpose}`))
      .update(body)
      .digest('base64url');
    return `${body}.${mac}`;
  }

  verify<T extends Record<string, unknown>>(purpose: string, token: string): T | null {
    const [body, mac, ...rest] = token.split('.');
    if (!body || !mac || rest.length) return null;
    const expected = createHmac('sha256', this.key(`sign:${purpose}`))
      .update(body)
      .digest('base64url');
    if (!safeEqual(mac, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
        exp: number;
      };
      if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** AES-256-GCM. Output: base64url(iv | tag | ciphertext). */
  encrypt(purpose: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(`enc:${purpose}`), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
  }

  decrypt(purpose: string, encoded: string): string {
    const raw = Buffer.from(encoded, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(`enc:${purpose}`),
      raw.subarray(0, 12),
    );
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}
