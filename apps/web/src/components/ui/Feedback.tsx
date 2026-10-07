import { formatBytes, percent } from '@familycloud/shared';
import { CircleAlert, WifiOff } from 'lucide-react';
import { Progress as P } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

// ── Progress ────────────────────────────────────────────────────────────────

export interface ProgressProps {
  value: number;
  max?: number;
  /** Accessible name, e.g. "Uploading photo.jpg". */
  label: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

const toneBg = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
} as const;

export function Progress({
  value,
  max = 100,
  label,
  tone = 'accent',
  size = 'sm',
  className,
}: ProgressProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <P.Root
      value={value}
      max={max}
      aria-label={label}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-surface-3',
        size === 'sm' ? 'h-1.5' : 'h-2.5',
        className,
      )}
    >
      <P.Indicator
        className={cn('h-full rounded-full transition-[width] duration-300', toneBg[tone])}
        style={{ width: `${pct}%` }}
      />
    </P.Root>
  );
}

/** Storage bar that turns amber at 80% and red at 95% (or when over quota). */
export function UsageBar({
  used,
  total,
  label,
  showText = true,
  className,
}: {
  used: number;
  total: number | null;
  label: string;
  showText?: boolean;
  className?: string;
}) {
  const pct = percent(used, total);
  const tone =
    total && used > total ? 'danger' : pct >= 95 ? 'danger' : pct >= 80 ? 'warning' : 'accent';
  if (total === null) {
    // Unlimited: an always-empty bar would be misleading, so show the number only.
    return showText ? (
      <p className={cn('text-xs text-muted', className)}>{formatBytes(used)} used · no limit</p>
    ) : null;
  }
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Progress
        value={total ? Math.min(used, total) : 0}
        max={total ?? 1}
        label={label}
        tone={tone}
      />
      {showText && (
        <p className="text-xs text-muted">
          {formatBytes(used)} {total ? `of ${formatBytes(total)}` : 'used'}
          {total && used > total && <span className="font-medium text-danger"> · over limit</span>}
        </p>
      )}
    </div>
  );
}

// ── Skeleton / Badge / Avatar ───────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton rounded-md', className)} />;
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-surface-2 text-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// Muted to sit with the palette; each keeps white initials above 4.5:1.
const AVATAR_COLORS = [
  '#46688f',
  '#2f6b4f',
  '#8a5a1c',
  '#6a4f86',
  '#9a3f52',
  '#2f6f6a',
  '#6b5b2e',
  '#a04a26',
];

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length],
      }}
    >
      {initials || '?'}
    </span>
  );
}

// ── Empty / Error states ────────────────────────────────────────────────────

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted [&>svg]:size-7"
        >
          {icon}
        </div>
      )}
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  onRetry,
  className,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}
    >
      <div
        aria-hidden="true"
        className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-danger-soft text-danger"
      >
        <CircleAlert size={28} />
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      {message && <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>}
      {onRetry && (
        <Button className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ── QueryState ──────────────────────────────────────────────────────────────

interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  /** "paused": TanStack Query is waiting for the network to come back. */
  fetchStatus?: 'fetching' | 'paused' | 'idle';
  refetch: () => unknown;
}

export interface QueryStateProps<T> {
  query: QueryLike<T>;
  /** Rendered while the first load is in flight (usually a Skeleton matching the final layout). */
  loading: ReactNode;
  /** Rendered when `isEmpty(data)` is true. */
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  errorTitle?: string;
  children: (data: T) => ReactNode;
}

/**
 * The standard loading → error → empty → data switch, so every data view handles all four
 * states the same way.
 */
export function QueryState<T>({
  query,
  loading,
  empty,
  isEmpty,
  errorTitle,
  children,
}: QueryStateProps<T>) {
  // Offline, a first load waits for the connection instead of failing: say so rather than
  // showing the skeleton forever. It loads by itself once the phone is back online.
  if (query.isPending && query.fetchStatus === 'paused') {
    return (
      <div aria-live="polite">
        <EmptyState
          icon={<WifiOff />}
          title="You're offline"
          description="This will load as soon as you're connected again."
        />
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading…</span>
        {loading}
      </div>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <ErrorState title={errorTitle} error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  if (empty && isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}

export function formatQuota(quota: number | null) {
  return quota === null ? 'Unlimited' : formatBytes(quota);
}
