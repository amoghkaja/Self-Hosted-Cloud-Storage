import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { scrubUrl } from '../src/context';
import { rateLimitKey } from '../src/lib/client-ip';
import { Keyring } from '../src/lib/crypto';
import { contentDisposition, isInlineSafe, parseRange } from '../src/lib/http';
import { renderShell } from '../src/lib/shell';
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
    // One token per payload: callers that remember used tokens compare them as text.
    expect(keys.verify('mfa', `${t}.x`)).toBeNull();
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
    // The invite link itself (web page served by the SPA fallback) carries the token too.
    expect(scrubUrl('/invite/tok?x=1')).toBe('/invite/[token]?x=1');
    expect(scrubUrl('/s/tok')).toBe('/s/[token]');
    // Password-reset links: the API call and the web page.
    expect(scrubUrl('/api/v1/password-resets/tok')).toBe('/api/v1/password-resets/[token]');
    expect(scrubUrl('/reset/tok')).toBe('/reset/[token]');
    // Admin routes that merely mention "reset" keep their ids.
    expect(scrubUrl('/api/v1/admin/users/u1/reset-totp')).toBe('/api/v1/admin/users/u1/reset-totp');
  });

  it('buckets IPv6 clients by /64 for rate limiting', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    const a = rateLimitKey('2001:db8:aa:bb:1::1');
    expect(a).toBe('2001:db8:aa:bb::/64');
    expect(rateLimitKey('2001:DB8:AA:BB:ffff:ffff:ffff:ffff')).toBe(a);
    expect(rateLimitKey('2001:0db8:00aa:00bb::9')).toBe(a);
    expect(rateLimitKey('2001:db8:aa:bc::1')).not.toBe(a);
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitKey('64:ff9b:1:2:3:4:1.2.3.4')).toBe('64:ff9b:1:2::/64');
    expect(rateLimitKey('not an ip')).toBe('not an ip');
  });

  it('normalizes Postgres timestamps', () => {
    expect(toIso('2026-09-26 09:14:23.123456+00')).toBe('2026-09-26T09:14:23.123Z');
    expect(toIso('2026-09-26 11:14:23+02')).toBe('2026-09-26T09:14:23.000Z');
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'x', SECRET_KEY: 'k'.repeat(40) };
  it('accepts an http(s) origin and rejects other schemes or a path', () => {
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://cloud.example.com/' }).publicOrigin).toBe(
      'https://cloud.example.com',
    );
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'ftp://cloud.example.com' })).toThrow(
      /PUBLIC_URL/,
    );
    // A path would be silently dropped from links and cookies, so refuse it up front.
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://example.com/cloud' })).toThrow(
      /must not contain a path/,
    );
  });
});

describe('request logging', () => {
  it('never writes share or invite tokens to the logs', async () => {
    const { Writable } = await import('node:stream');
    const { loadConfig } = await import('../src/config');
    const { createLogger } = await import('../src/context');
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger(
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'x',
        SECRET_KEY: 'k'.repeat(40),
        LOG_LEVEL: 'info',
      }),
      sink,
    );
    log.info(
      { req: { method: 'GET', url: '/api/v1/public/links/SUPERSECRET123456789/content/x' } },
      'incoming request',
    );
    log.info(
      { req: { method: 'POST', url: '/api/v1/invites/INVITESECRET123456789/accept' } },
      'incoming request',
    );
    log.info({ req: { method: 'GET', url: '/invite/INVITEPAGE123456789' } }, 'incoming request');
    const out = lines.join('');
    expect(out).not.toContain('SUPERSECRET');
    expect(out).not.toContain('INVITESECRET');
    expect(out).not.toContain('INVITEPAGE');
    expect(out).toContain('/public/links/[token]');
  });
});

describe('renderShell', () => {
  const html =
    '<head><link rel="icon" href="/favicon.svg" type="image/svg+xml" />\n<link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n<title>Family Cloud</title></head><body><noscript>Family Cloud needs JavaScript to run.</noscript></body>';
  const opts = { appName: 'Kaja <Family> Cloud', publicUrl: 'https://cloud.example.com' };

  it('uses the uploaded logo and name, escaped', () => {
    const out = renderShell(html, { ...opts, logoVersion: 'v1', sharePage: false });
    expect(out).toContain('<title>Kaja &#60;Family&#62; Cloud</title>');
    expect(out).toContain('href="/api/v1/brand/icon/192?v=v1" type="image/png"');
    expect(out).toContain('rel="apple-touch-icon" href="/api/v1/brand/icon/180?v=v1"');
    expect(out).toContain('content="https://cloud.example.com/api/v1/brand/icon/512?v=v1"');
    expect(out).not.toContain('/favicon.svg');
    expect(out).toContain('<noscript>Kaja &#60;Family&#62; Cloud needs JavaScript');
    expect(out).toContain(
      '<meta name="description" content="Kaja &#60;Family&#62; Cloud: our family\'s private cloud." />',
    );
  });

  it('keeps share-link previews generic, and falls back to the built-in icons', () => {
    const out = renderShell(html, { ...opts, logoVersion: null, sharePage: true });
    expect(out).toContain('<title>Shared with you · Kaja');
    expect(out).toContain('href="/favicon.svg"');
    expect(out).toContain('content="https://cloud.example.com/icon-512.png"');
  });
});
