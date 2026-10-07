import { PASSWORD_MIN_LENGTH, type PasswordResetInfo } from '@familycloud/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, errorMessage, isUnusableLink } from '../../api/client';
import { qk } from '../../api/queries';
import { Button, ErrorState, PasswordField, Skeleton } from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';
import { AuthLayout, FormError } from './AuthLayout';

/** A one-time link from an admin: the person picks a new password, then signs in with it. */
export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  usePageTitle('Choose a new password');
  const info = useQuery({
    queryKey: ['password-reset', token],
    queryFn: () => api<PasswordResetInfo>(`/password-resets/${token}`),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const reset = useMutation({
    mutationFn: () => api(`/password-resets/${token}`, { json: { password } }),
    // Every session of this account just ended, possibly including this browser's.
    onSuccess: () => qc.removeQueries({ queryKey: qk.me }),
  });
  const mismatch = confirm.length > 0 && confirm !== password;

  if (info.isPending) {
    return (
      <AuthLayout title="Choose a new password">
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      </AuthLayout>
    );
  }
  if (info.isError && !isUnusableLink(info.error)) {
    return (
      <AuthLayout title="Choose a new password">
        <ErrorState
          title="Couldn't open this link"
          error={info.error}
          onRetry={() => void info.refetch()}
        />
      </AuthLayout>
    );
  }
  if (info.isError) {
    return (
      <AuthLayout title="Link not valid">
        <ErrorState
          title="This link can't be used"
          error="It may have expired, been used already, or been replaced by a newer link. Ask your admin for a new one."
        />
        <Button asChild className="mt-2 w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }
  if (reset.isSuccess) {
    return (
      <AuthLayout title="Password changed">
        <div className="flex flex-col gap-4 text-center">
          <p className="text-sm">
            Sign in with your new password. You've been signed out on your other devices.
          </p>
          <Button asChild variant="primary" size="lg">
            <Link to="/login" replace>
              Sign in
            </Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || !password) return;
    setError(null);
    try {
      await reset.mutateAsync();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle={`For ${info.data.displayName} (${info.data.email}).`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormError message={error} />
        {/* Lets password managers file the new password under the right account. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={info.data.email}
          readOnly
          hidden
        />
        <PasswordField
          label="New password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence is easy to remember and hard to guess.`}
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
        />
        <PasswordField
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? "Passwords don't match" : null}
          required
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={reset.isPending}
          disabled={mismatch || password.length < PASSWORD_MIN_LENGTH}
        >
          Save new password
        </Button>
      </form>
    </AuthLayout>
  );
}
