import { Cloud } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSetupStatus } from '../../api/queries';

/** Centered card used by sign-in, first-run setup and invite acceptance. */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const setup = useSetupStatus();
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-fg"
          >
            <Cloud size={24} />
          </span>
          <p className="text-sm font-medium text-muted">{setup.data?.appName ?? 'Family Cloud'}</p>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-pop sm:p-6">
          {children}
        </div>
      </div>
    </main>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}
