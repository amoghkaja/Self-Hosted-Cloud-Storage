import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseChangelog } from '../src/lib/changelog';
import { addMember, Client, createTestEnv, setupAdmin, type TestEnv } from './helpers';

const CHANGELOG = `# Changelog

Intro text with a [link](docs/releasing.md).

## Unreleased

## v0.2.0 (2026-10-02)

### New

- **Photos:** swipe down to close a photo,
  on phones too. See [the guide](docs/photos.md).

### Before you update

- Add \`UPDATE_CHANNEL=stable\` to \`deploy/.env\`.

## v0.1.0 (2026-09-01)

The first release.

### Fixed

- **Uploads:** resume after a dropped connection.
`;

let env: TestEnv;
let admin: Client;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fc-changelog-'));
  await writeFile(path.join(dir, 'CHANGELOG.md'), CHANGELOG);
  env = await createTestEnv({
    APP_VERSION: 'v0.2.0',
    CHANGELOG_PATH: path.join(dir, 'CHANGELOG.md'),
  });
  admin = (await setupAdmin(env)).client;
});
afterAll(async () => {
  await env.close();
  await rm(dir, { recursive: true, force: true });
});

describe('release notes', () => {
  it('parses versions, dates, groups and wrapped items, skipping empty sections', () => {
    expect(parseChangelog(CHANGELOG)).toEqual([
      {
        version: 'v0.2.0',
        date: '2026-10-02',
        groups: [
          {
            title: 'New',
            items: ['**Photos:** swipe down to close a photo, on phones too. See the guide.'],
          },
          {
            title: 'Before you update',
            items: ['Add `UPDATE_CHANNEL=stable` to `deploy/.env`.'],
          },
        ],
      },
      {
        version: 'v0.1.0',
        date: '2026-09-01',
        groups: [{ title: 'Fixed', items: ['**Uploads:** resume after a dropped connection.'] }],
      },
    ]);
  });

  it('tells signed-in people the version and what changed; update steps go to admins only', async () => {
    expect((await new Client(env.app).get('/about')).status).toBe(401);

    const forAdmin = await admin.get('/about');
    expect(forAdmin.body.version).toBe('v0.2.0');
    expect(forAdmin.body.releases[0].groups.map((g: { title: string }) => g.title)).toEqual([
      'New',
      'Before you update',
    ]);

    const member = (await addMember(env, admin, 'mum@example.com')).client;
    const forMember = await member.get('/about');
    expect(forMember.body.version).toBe('v0.2.0');
    expect(forMember.body.releases.map((r: { version: string }) => r.version)).toEqual([
      'v0.2.0',
      'v0.1.0',
    ]);
    expect(forMember.body.releases[0].groups.map((g: { title: string }) => g.title)).toEqual([
      'New',
    ]);
  });
});
