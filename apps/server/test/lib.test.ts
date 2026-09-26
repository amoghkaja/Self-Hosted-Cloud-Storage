import { describe, expect, it } from 'vitest';
import { scrubUrl } from '../src/context';
import { Keyring } from '../src/lib/crypto';
import { contentDisposition, isInlineSafe, parseRange } from '../src/lib/http';
import { toIso } from '../src/lib/time';

describe('parseRange', () => {
  it('handles the single-range forms and rejects the rest', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('content helpers', () => {
  it('only allows known-safe types inline', () => {
    expect(isInlineSafe('image/jpeg')).toBe(true);
    expect(isInlineSafe('text/html')).toBe(false);
    expect(isInlineSafe('image/svg+xml')).toBe(false);
    expect(isInlineSafe(null)).toBe(false);
  });

  it('builds a header that cannot be broken out of', () => {
    const h = contentDisposition('attachment', 'a"; evil=1.txt');
    expect(h).toBe(
      `attachment; filename="a_; evil=1.txt"; filename*=UTF-8''a%22%3B%20evil%3D1.txt`,
    );
  });
});

describe('Keyring', () => {
  const keys = new Keyring('x'.repeat(40));
  it('signs, verifies and expires tokens, bound to their purpose', () => {
    const t = keys.sign('mfa', { uid: 'u1' }, 60);
    expect(keys.verify('mfa', t)).toMatchObject({ uid: 'u1' });
    expect(keys.verify('link-unlock', t)).toBeNull();
    expect(keys.verify('mfa', `${t}x`)).toBeNull();
    expect(keys.verify('mfa', keys.sign('mfa', { uid: 'u1' }, -1))).toBeNull();
  });

  it('encrypts with authentication', () => {
    const ct = keys.encrypt('totp', 'JBSWY3DPEHPK3PXP');
    expect(keys.decrypt('totp', ct)).toBe('JBSWY3DPEHPK3PXP');
    const tampered = `${ct.slice(0, -2)}AA`;
    expect(() => keys.decrypt('totp', tampered)).toThrow();
    expect(() => new Keyring('y'.repeat(40)).decrypt('totp', ct)).toThrow();
  });
});

describe('misc', () => {
  it('scrubs tokens from logged URLs', () => {
    expect(scrubUrl('/api/v1/public/links/abc123/content/x')).toBe(
      '/api/v1/public/links/[token]/content/x',
    );
    expect(scrubUrl('/api/v1/invites/tok/accept')).toBe('/api/v1/invites/[token]/accept');
  });

  it('normalizes Postgres timestamps', () => {
    expect(toIso('2026-09-26 09:14:23.123456+00')).toBe('2026-09-26T09:14:23.123Z');
    expect(toIso('2026-09-26 11:14:23+02')).toBe('2026-09-26T09:14:23.000Z');
  });
});
