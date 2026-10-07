import { describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test/utils';
import { api, onUnauthorized } from './client';

describe('api', () => {
  it('signs you out only when the session itself is gone', async () => {
    mockFetch({
      // Adding a passkey whose check fails (e.g. the 5-minute challenge ran out).
      'POST /auth/passkeys': () => ({
        status: 401,
        json: { code: 'PASSKEY_INVALID', detail: 'That passkey could not be verified. Try again.' },
      }),
      'GET /recent': () => ({
        status: 401,
        json: { code: 'UNAUTHENTICATED', detail: 'Please sign in' },
      }),
    });
    const signedOut = vi.fn();
    const off = onUnauthorized(signedOut);
    try {
      await expect(api('/auth/passkeys', { json: {} })).rejects.toMatchObject({
        status: 401,
        code: 'PASSKEY_INVALID',
        message: 'That passkey could not be verified. Try again.',
      });
      expect(signedOut).not.toHaveBeenCalled();

      await expect(api('/recent')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(signedOut).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});
