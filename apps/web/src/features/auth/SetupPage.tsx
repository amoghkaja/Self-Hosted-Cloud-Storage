import { type InviteInfo, type Me, PASSWORD_MIN_LENGTH } from '@familycloud/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import { qk, useSetupStatus } from '../../api/queries';
import { Button, ErrorState, PasswordField, Skeleton, TextField } from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';
import { AuthLayout, FormError } from './AuthLayout';

const passwordHint = `At least ${PASSWORD_MIN_LENGTH} characters. A short sentence is easy to remember and hard to guess.`;

function useAccountForm() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;
  return {
    displayName,
    setDisplayName,
    email,
    setEmail,
    password,
    setPassword,
    confirm,
    setConfirm,
    error,
    setError,
    busy,
    setBusy,
    mismatch,
  };
}

function AccountFields({
  f,
  lockedEmail,
}: {
  f: ReturnType<typeof useAccountForm>;
  lockedEmail?: string | null;
}) {
  return (
    <>
      <TextField
        label="Your name"
        autoComplete="name"
        value={f.displayName}
        onChange={(e) => f.setDisplayName(e.target.value)}
        required
        autoFocus
      />
      <TextField
        label="Email"
        type="email"
        autoComplete="username"
        value={lockedEmail ?? f.email}
        readOnly={!!lockedEmail}
        onChange={(e) => f.setEmail(e.target.value)}
        required
      />
      <PasswordField
        label="Password"
        autoComplete="new-password"
        hint={passwordHint}
        minLength={PASSWORD_MIN_LENGTH}
        value={f.password}
        onChange={(e) => f.setPassword(e.target.value)}
        required
      />
      <PasswordField
        label="Confirm password"
        autoComplete="new-password"
        value={f.confirm}
        onChange={(e) => f.setConfirm(e.target.value)}
        error={f.mismatch ? "Passwords don't match" : null}
        required
      />
    </>
  );
}

/** First run: the person installing the server creates the admin account. */
export function SetupPage() {
  const setup = useSetupStatus();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const f = useAccountForm();
  const [token, setToken] = useState('');
  usePageTitle('Set up');

  if (setup.data && !setup.data.needsSetup) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.mismatch) return;
    f.setError(null);
    f.setBusy(true);
    try {
      const me = await api<Me>('/auth/setup', {
        json: {
          setupToken: token,
          email: f.email,
          displayName: f.displayName,
          password: f.password,
        },
      });
      qc.setQueryData(qk.me, me);
      // Refetched rather than patched: the branding and source link come with it too.
      await qc.invalidateQueries({ queryKey: qk.setup });
      navigate('/files', { replace: true });
    } catch (err) {
      f.setError(errorMessage(err));
    } finally {
      f.setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Set up your family cloud"
      subtitle="Create the admin account. You'll invite everyone else after."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormError message={f.error} />
        <TextField
          label="Setup token"
          hint="Printed in the server logs on first start (or run: docker compose exec app node dist/cli.js setup-token)."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <AccountFields f={f} />
        <Button type="submit" variant="primary" size="lg" loading={f.busy} disabled={f.mismatch}>
          Create admin account
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Invite links: a family member picks their name and password. */
export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const f = useAccountForm();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>(`/invites/${token}`),
    retry: false,
  });
  usePageTitle('Join');

  if (invite.isPending) {
    return (
      <AuthLayout title="Join the family cloud">
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      </AuthLayout>
    );
  }
  if (invite.isError) {
    return (
      <AuthLayout title="Invite not valid">
        <ErrorState
          title="This invite can't be used"
          error="It may have expired or already been used. Ask for a new link."
        />
      </AuthLayout>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.mismatch) return;
    f.setError(null);
    f.setBusy(true);
    try {
      const me = await api<Me>(`/invites/${token}/accept`, {
        json: {
          email: invite.data.email ?? f.email,
          displayName: f.displayName,
          password: f.password,
        },
      });
      qc.setQueryData(qk.me, me);
      navigate('/files', { replace: true });
    } catch (err) {
      f.setError(errorMessage(err));
    } finally {
      f.setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Join the family cloud"
      subtitle={`${invite.data.invitedBy} invited you. Create your account to get started.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormError message={f.error} />
        <AccountFields f={f} lockedEmail={invite.data.email} />
        <Button type="submit" variant="primary" size="lg" loading={f.busy} disabled={f.mismatch}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
