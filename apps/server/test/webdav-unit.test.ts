import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import type { SettingsStore } from '../src/lib/settings';
import { DavAuthenticator } from '../src/modules/webdav/auth';
import { proppatchNames, xmlEscape } from '../src/modules/webdav/xml';

describe('device password cache', () => {
  it('does not cache a lookup that raced with removing the device', async () => {
    let started!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (rows: unknown[]) => void;
    const firstLookup = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    let lookups = 0;
    // A stand-in for the database whose first lookup resolves only when told to; by the second
    // the device password is gone.
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => {
              if (++lookups > 1) return Promise.resolve([]);
              started();
              return firstLookup;
            },
          }),
        }),
      }),
    } as unknown as Db;
    const settings = { get: async () => ({ allowedEmailDomains: [] }) } as unknown as SettingsStore;
    const auth = new DavAuthenticator(db, settings);
    const header = `Basic ${Buffer.from('a@example.com:abcde-fghjk-mnpqr-stuvw').toString('base64')}`;

    const inFlight = auth.authenticate(header, '192.0.2.1');
    await lookupStarted; // the password was read before the removal…
    auth.forgetUser('u1'); // …the device is removed…
    release([
      { user: { id: 'u1', email: 'a@example.com' }, app: { id: 'p1', lastUsedAt: new Date() } },
    ]); // …then the stale row arrives.
    expect(await inFlight).not.toBeNull(); // that request was already signed in
    // The next request must ask the database, not find the removed password in the cache.
    expect(await auth.authenticate(header, '192.0.2.1')).toBeNull();
  });
});

describe('PROPPATCH body scanner', () => {
  it('takes linear time on unclosed comments and declarations', () => {
    const bodies = ['<!--'.repeat(16_384), '<!'.repeat(32_768), '<![CDATA['.repeat(7_281)];
    const start = performance.now();
    for (const body of bodies) expect(proppatchNames(body)).toEqual([]);
    // Each one took hundreds of milliseconds when every "<" searched to the end again.
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('still skips comments and declarations around the properties', () => {
    const body =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "x">]><D:propertyupdate xmlns:D="DAV:">' +
      '<!-- <D:set><D:prop><D:hidden/></D:prop></D:set> -->' +
      '<D:set><D:prop><D:displayname/></D:prop></D:set></D:propertyupdate>';
    expect(proppatchNames(body)).toEqual([{ ns: 'DAV:', name: 'displayname' }]);
  });
});

describe('XML escaping', () => {
  it("replaces what XML can't hold, so one odd name can't break a whole listing", () => {
    // A display name (shown for shared folders) or a name stored before names refused these.
    expect(xmlEscape('a\uFFFFb\u0001c\uD800d')).toBe('a\uFFFDb\uFFFDc\uFFFDd');
    expect(xmlEscape('Trip 😀 <&> "x" \'y\'\tz')).toBe(
      'Trip 😀 &lt;&amp;&gt; &quot;x&quot; &apos;y&apos;\tz',
    );
  });
});
