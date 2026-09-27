import type { Me } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { Navigate, useLocation, useNavigate, useOutletContext } from 'react-router';
import { onUnauthorized } from '../api/client';
import { qk, useMe, useSetupStatus } from '../api/queries';
import { Button, ErrorState, Spinner } from '../components/ui';

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center text-muted">
      <Spinner size={28} label={label} />
    </div>
  );
}

/**
 * Gate for signed-in pages. Sends first-run installs to /setup and signed-out users to /login
 * (remembering where they were going). Also reacts to a session expiring mid-use.
 */
export function RequireAuth({ children }: { children: (me: Me) => ReactNode }) {
  const me = useMe();
  const setup = useSetupStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(
    () =>
      onUnauthorized(() => {
        qc.removeQueries({ queryKey: qk.me });
        navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, {
          replace: true,
        });
      }),
    [qc, navigate, location.pathname, location.search],
  );

  if (me.isPending || setup.isPending) return <FullPageSpinner />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (me.isError || !me.data) {
    const status = (me.error as { status?: number } | null)?.status;
    if (status === 401 || status === undefined) {
      return (
        <Navigate
          to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
          replace
        />
      );
    }
    return (
      <ErrorState
        title="Can't reach Family Cloud"
        error={me.error}
        onRetry={() => void me.refetch()}
      />
    );
  }
  return <>{children(me.data)}</>;
}

export interface ShellContext {
  me: Me;
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useShell();
  if (me.role !== 'admin') {
    return (
      <ErrorState title="Admins only" error="Ask a family admin if you need something changed." />
    );
  }
  return <>{children}</>;
}

export function NotFound() {
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-muted">That link may be old or mistyped.</p>
      <Button asChild className="mt-5">
        <a href="/files">Go to My Files</a>
      </Button>
    </div>
  );
}
