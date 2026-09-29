import type { LoginResponse, Me } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import { qk, useLogin, useLoginTotp, useMe, useSetupStatus } from '../../api/queries';
import { Button, PasswordField, TextField } from '../../components/ui';
import {
  cancelPasskeyRequest,
  passkeyAutofillSupported,
  passkeyError,
  passkeysSupported,
  signInWithPasskey,
} from '../../lib/passkeys';
import { usePageTitle } from '../../lib/usePageTitle';
import { AuthLayout, FormError } from './AuthLayout';

/** Only follow same-app relative redirects after sign-in (no open redirect). */
function safeNext(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/files';
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const setup = useSetupStatus();
  const login = useLogin();
  const totp = useLoginTotp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const qc = useQueryClient();
  const signedIn = me.data !== undefined;
  const needsSetup = setup.data?.needsSetup;

  usePageTitle('Sign in');

  const finish = (res: LoginResponse) => {
    if (res.status !== 'ok') return;
    qc.setQueryData<Me>(qk.me, res.user);
    navigate(next, { replace: true });
  };

  // Offer saved passkeys right in the email field's suggestions (iOS/macOS/Chrome autofill).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per visit to the page
  useEffect(() => {
    if (signedIn || needsSetup) return;
    let active = true;
    void passkeyAutofillSupported().then((ok) => {
      if (!ok || !active) return;
      signInWithPasskey(true).then(finish, (err) => {
        const message = passkeyError(err);
        if (active && message) setError(message);
      });
    });
    return () => {
      active = false;
      cancelPasskeyRequest();
    };
  }, [signedIn, needsSetup]);

  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.data) return <Navigate to={next} replace />;

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await login.mutateAsync({ email, password });
      if (res.status === 'mfa_required') setMfaToken(res.mfaToken);
      else navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const passkeySignIn = async () => {
    setError(null);
    setPasskeyBusy(true);
    try {
      finish(await signInWithPasskey());
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (useRecovery) {
        finish(await api<LoginResponse>('/auth/login/recovery', { json: { mfaToken, code } }));
      } else {
        await totp.mutateAsync({ mfaToken: mfaToken!, code });
        navigate(next, { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    }
  };

  if (mfaToken) {
    return (
      <AuthLayout
        title="Two-factor check"
        subtitle={
          useRecovery
            ? 'Enter one of your recovery codes. Each works once.'
            : 'Enter the 6-digit code from your authenticator app.'
        }
      >
        <form onSubmit={submitCode} className="flex flex-col gap-4" noValidate>
          <FormError message={error} />
          {useRecovery ? (
            <TextField
              key="recovery"
              label="Recovery code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={40}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
            />
          ) : (
            <TextField
              key="totp"
              label="Authentication code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
          )}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={totp.isPending}
            disabled={useRecovery ? code.trim().length < 10 : code.length !== 6}
          >
            Verify
          </Button>
          <button
            type="button"
            className="text-sm text-accent underline-offset-2 hover:underline"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              setError(null);
            }}
          >
            {useRecovery ? 'Use the code from your app' : 'Lost your phone? Use a recovery code'}
          </button>
          <Button
            variant="ghost"
            onClick={() => {
              setMfaToken(null);
              setUseRecovery(false);
            }}
          >
            Back
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your family's files.">
      <form onSubmit={submitPassword} className="flex flex-col gap-4">
        <FormError message={error} />
        <TextField
          label="Email"
          type="email"
          // "webauthn" lets the browser list saved passkeys among the email suggestions.
          autoComplete="username webauthn"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" variant="primary" size="lg" loading={login.isPending}>
          Sign in
        </Button>
        {passkeysSupported() && (
          <Button
            size="lg"
            icon={<Fingerprint size={18} />}
            loading={passkeyBusy}
            onClick={passkeySignIn}
          >
            Sign in with a passkey
          </Button>
        )}
        <p className="text-center text-xs text-muted">
          Forgot your password? Ask a family admin for a reset link.
        </p>
      </form>
    </AuthLayout>
  );
}
