import type { LoginResponse, Passkey, PasskeyOptions } from '@familycloud/shared';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { api } from '../api/client';

export const passkeysSupported = () => browserSupportsWebAuthn();
export const passkeyAutofillSupported = () => browserSupportsWebAuthnAutofill();

/**
 * Signs in with a passkey (Face ID / Touch ID). With `autofill`, the request waits quietly for
 * the person to pick a passkey from the email field's suggestions instead of opening a sheet.
 */
export async function signInWithPasskey(autofill = false): Promise<LoginResponse> {
  const { options, token } = await api<PasskeyOptions>('/auth/passkeys/login/options', {
    json: {},
  });
  const response = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
    useBrowserAutofill: autofill,
  });
  return api<LoginResponse>('/auth/passkeys/login', { json: { token, response } });
}

/** The password is checked before the device is asked: see ConfirmPasswordDialog. */
export async function addPasskey(password: string): Promise<Passkey> {
  const { options, token } = await api<PasskeyOptions>('/auth/passkeys/register/options', {
    json: { password },
  });
  const response = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  return api<Passkey>('/auth/passkeys', { json: { token, response } });
}

export const cancelPasskeyRequest = () => WebAuthnAbortService.cancelCeremony();

/** Turns the browser's WebAuthn errors into something a person can act on (or null: ignore). */
export function passkeyError(err: unknown): string | null {
  const name = err instanceof Error ? err.name : '';
  // The person closed the sheet, or a newer request replaced this one: not an error to show.
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (name === 'SecurityError') return 'Passkeys only work on the secure (https) address.';
  return err instanceof Error ? err.message : 'That didn’t work. Try again.';
}
