import { formatBytes } from '@familycloud/shared';
import { Link } from 'react-router';
import { useStorage } from '../api/queries';
import { Progress, Skeleton } from '../components/ui';

/**
 * Your space: what you use and what's left for you. "Left" is the tightest of your allowance,
 * the family limit and the free disk space, so it's the same number the network drive shows.
 */
export function StorageSummary({
  detailed = false,
  cleanupLink = true,
}: {
  detailed?: boolean;
  /** A link to "Free up space" (not on that page itself). */
  cleanupLink?: boolean;
}) {
  const s = useStorage().data;
  if (!s) return <Skeleton className="h-9" />;
  // The bar runs to what they could reach: their allowance, or used + what's left for them.
  const total = Math.max(s.quotaBytes ?? s.usedBytes + s.availableBytes, 1);
  const ratio = s.usedBytes / total;
  const limitedByFamily = s.quotaBytes !== null && s.availableBytes < s.quotaBytes - s.usedBytes;
  return (
    <div className="flex flex-col gap-1.5">
      <Progress
        value={Math.min(s.usedBytes, total)}
        max={total}
        label="Your storage use"
        tone={s.availableBytes === 0 ? 'danger' : ratio > 0.8 ? 'warning' : 'accent'}
      />
      <p className="text-xs text-muted tabular-nums">
        {formatBytes(s.usedBytes)} used · {formatBytes(s.availableBytes)} left
      </p>
      {cleanupLink && s.usedBytes > 0 && (
        <Link
          to="/storage"
          className={`self-start text-xs underline-offset-2 hover:underline pointer-coarse:py-2 ${ratio > 0.8 ? 'font-medium text-accent' : 'text-muted'}`}
        >
          Free up space
        </Link>
      )}
      {detailed && s.versionsBytes > 0 && (
        <p className="text-xs text-muted tabular-nums">
          {formatBytes(s.versionsBytes)} of that is older versions of files, kept for a while in
          case you need them back. They make way on their own when you run out of space.
        </p>
      )}
      {detailed && (
        <p className="text-xs text-muted">
          {s.quotaBytes === null
            ? 'You have no personal limit; what’s left is the family’s shared space.'
            : `Your allowance is ${formatBytes(s.quotaBytes)}.`}
          {limitedByFamily &&
            ' The family space or the disks are nearly full, so less is left than your allowance.'}
          {s.quotaBytes !== null &&
            s.usedBytes > s.quotaBytes &&
            ' You are over your allowance: delete something (and empty the trash) to upload again.'}
        </p>
      )}
    </div>
  );
}
