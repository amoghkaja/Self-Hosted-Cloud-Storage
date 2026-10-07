import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, Client, createTestEnv, ORIGIN, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
const RP_ID = new URL(ORIGIN).hostname;

beforeAll(async () => {
  env = await createTestEnv();
  admin = (await setupAdmin(env)).client;
});
afterAll(async () => {
  await env.close();
});

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

/** A minimal software authenticator (like a phone's secure enclave), for real signatures. */
class Authenticator {
  readonly credId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly cose: Uint8Array;
  counter = 0;
  userHandle = '';

  constructor(
    private readonly origin = ORIGIN,
    private readonly rpId = RP_ID,
    /** Synced passkeys (iCloud Keychain, Google Password Manager) always report 0. */
    private readonly counts = true,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  private authData(attested: boolean) {
    const flags = 0x01 | 0x04 | 0x08 | 0x10 | (attested ? 0x40 : 0); // UP UV BE BS [AT]
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts = [sha256(this.rpId), Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, Buffer.from(this.cose));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }

  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(true)],
      ]) as never,
    );
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
    };
  }

  assert(options: { challenge: string }) {
    if (this.counts) this.counter++;
    const authData = this.authData(false);
    const clientData = this.clientData('webauthn.get', options.challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.key);
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

async function addPasskey(client: Client, device = new Authenticator()) {
  const opts = (await client.post('/auth/passkeys/register/options', { password: ADMIN_PASSWORD }))
    .body;
  const res = await client.post('/auth/passkeys', {
    token: opts.token,
    response: device.register(opts.options),
  });
  return { res, device };
}

async function passkeySignIn(device: Authenticator) {
  const guest = new Client(env.app);
  const opts = (await guest.post('/auth/passkeys/login/options', {})).body;
  const response = device.assert(opts.options);
  const res = await guest.post('/auth/passkeys/login', { token: opts.token, response });
  return { guest, res, token: opts.token, options: opts.options, response };
}

describe('passkeys', () => {
  it('registers a passkey and signs in with it, without a password or code', async () => {
    const { res, device } = await addPasskey(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ backedUp: true, lastUsedAt: null });

    const { guest, res: login } = await passkeySignIn(device);
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('ok');
    expect((await guest.get('/auth/me')).status).toBe(200);
    const listed = (await admin.get('/auth/passkeys')).body;
    expect(listed[0].lastUsedAt).not.toBeNull();
  });

  it('refuses replays, wrong origins, removed passkeys and bad signatures', async () => {
    const { device } = await addPasskey(admin);
    // The same signed challenge can't be used twice.
    const first = await passkeySignIn(device);
    expect(first.res.status).toBe(200);
    const again = await new Client(env.app).post('/auth/passkeys/login', {
      token: first.token,
      response: device.assert(first.options),
    });
    expect(again.status).toBe(401);

    // A phishing site on another origin gets an assertion that doesn't verify here.
    const phished = new Authenticator('https://evil.example', RP_ID);
    (phished as unknown as { credId: Buffer }).credId.set(device.credId);
    expect((await passkeySignIn(phished)).res.status).toBe(401);

    // Removed: the passkey no longer signs in.
    const list = (await admin.get('/auth/passkeys')).body as { id: string }[];
    for (const p of list) expect((await admin.del(`/auth/passkeys/${p.id}`)).status).toBe(200);
    expect((await passkeySignIn(device)).res.status).toBe(401);
  });

  it('accepts a challenge once, however its token is written', async () => {
    // A synced passkey's counter stays 0, so only the single-use challenge stops a replay.
    const { device } = await addPasskey(admin, new Authenticator(ORIGIN, RP_ID, false));
    const first = await passkeySignIn(device);
    expect(first.res.status).toBe(200);
    const replay = await new Client(env.app).post('/auth/passkeys/login', {
      token: `${first.token}.x`,
      response: first.response,
    });
    expect(replay.status).toBe(401);
  });

  it('asks for the password before adding a passkey', async () => {
    // A passkey added with a stolen session would outlast a password change and signing out.
    const options = (body: { password?: string }) =>
      admin.post('/auth/passkeys/register/options', body);
    expect((await options({})).status).toBe(400);
    const wrong = await options({ password: 'not my password' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.token).toBeUndefined();
    expect((await options({ password: ADMIN_PASSWORD })).status).toBe(200);
  });

  it('keeps passkeys private to their owner and needs a session to add one', async () => {
    const { res } = await addPasskey(admin);
    const guest = new Client(env.app);
    expect((await guest.post('/auth/passkeys/register/options', { password: 'x' })).status).toBe(
      401,
    );
    expect((await guest.get('/auth/passkeys')).status).toBe(401);
    // Another person can't rename or delete it (404, like any other invisible item).
    const other = await addMemberClient();
    expect((await other.del(`/auth/passkeys/${res.body.id}`)).status).toBe(404);
  });
});

async function addMemberClient() {
  const { addMember } = await import('./helpers');
  return (await addMember(env, admin, `pk-${randomBytes(3).toString('hex')}@example.com`)).client;
}
