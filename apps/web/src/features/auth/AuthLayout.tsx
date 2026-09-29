import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useSetupStatus } from '../../api/queries';
import { Logo } from '../../app/Logo';

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
  const setup = useSetupStatus().data;
  const home = setup?.homeUrl;
  return (
    <div className="flex min-h-dvh flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <main className="flex flex-1 items-center justify-center py-8">
        <div className="w-full max-w-sm">
          <div className="mb-7 flex flex-col items-center text-center">
            <Logo size="lg" className="mb-6" />
            <h1 className="font-serif text-[32px] leading-tight">{title}</h1>
            {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
          </div>
          <div className="rounded-2xl border border-border bg-surface p-5 shadow-pop sm:p-6">
            {children}
          </div>
        </div>
      </main>
      <footer className="flex flex-wrap items-center justify-center gap-x-5 text-sm text-muted">
        {home && (
          <a href={home} className="inline-flex min-h-11 items-center gap-1.5 hover:text-text">
            <ArrowLeft size={14} aria-hidden />
            {new URL(home).host}
          </a>
        )}
        <Link to="/privacy" className="inline-flex min-h-11 items-center hover:text-text">
          Privacy
        </Link>
        {/* The AGPL's offer of the source code to everyone who uses the server. */}
        {setup?.sourceUrl && (
          <a
            href={setup.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center hover:text-text"
          >
            Source code
          </a>
        )}
      </footer>
    </div>
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
