import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { useLogin, useLoginTotp, useMe, useSetupStatus } from '../../api/queries';
import { Button, PasswordField, TextField } from '../../components/ui';
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Sign in · Family Cloud';
  }, []);

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

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await totp.mutateAsync({ mfaToken: mfaToken!, code });
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    }
  };

  if (mfaToken) {
    return (
      <AuthLayout
        title="Two-factor check"
        subtitle="Enter the 6-digit code from your authenticator app."
      >
        <form onSubmit={submitCode} className="flex flex-col gap-4" noValidate>
          <FormError message={error} />
          <TextField
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
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={totp.isPending}
            disabled={code.length !== 6}
          >
            Verify
          </Button>
          <Button variant="ghost" onClick={() => setMfaToken(null)}>
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
          autoComplete="username"
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
        <p className="text-center text-xs text-muted">
          Forgot your password? Ask a family admin to reset it.
        </p>
      </form>
    </AuthLayout>
  );
}
