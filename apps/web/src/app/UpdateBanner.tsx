import type { UpdateStatus } from '@familycloud/shared';
import { ArrowUpCircle, TriangleAlert, X } from 'lucide-react';
import { Link } from 'react-router';
import { useAdminUpdates } from '../api/queries';
import { IconButton } from '../components/ui';
import { describeUpdate, recentlyUpdated } from '../features/admin/updateView';
import { cn } from '../lib/cn';
import { usePref } from '../lib/storage';

const FORTNIGHT = 14 * 24 * 3600_000;

interface Notice {
  /** Dismissing hides this one only: anything new about updates shows again. */
  id: string;
  warning: boolean;
  text: string;
  to: string;
  link: string;
}

function noticeFor(s: UpdateStatus, now = Date.now()): Notice | null {
  const view = describeUpdate(s);
  if (view.kind === 'failed' && now - Date.parse(view.last.at) < FORTNIGHT) {
    const { to, at, state } = view.last;
    return {
      id: `failed:${to}:${at}`,
      warning: true,
      text:
        state === 'rolled-back'
          ? `Family Cloud ${to} didn't start, so the cloud went back to ${s.running}.`
          : `The update to Family Cloud ${to} didn't work; the cloud is still on ${s.running}.`,
      to: '/admin',
      link: 'See why',
    };
  }
  if (view.kind === 'needs-steps') {
    return {
      id: `steps:${view.version}`,
      warning: true,
      text: `Family Cloud ${view.version} needs you to do something on the server before it's installed.`,
      to: '/admin',
      link: 'See how',
    };
  }
  if (view.kind === 'available') {
    const tonight = s.auto.enabled && !s.available?.failedBefore;
    return {
      id: `available:${view.version}`,
      warning: false,
      text: `Family Cloud ${view.version} is available.${tonight ? ' It installs itself tonight.' : ''}`,
      to: '/admin',
      link: "See what's new",
    };
  }
  const updated = view.kind === 'updating' ? null : recentlyUpdated(s, now);
  if (updated) {
    return {
      id: `updated:${updated}`,
      warning: false,
      text: `Family Cloud was updated to ${updated}.`,
      to: '/whats-new',
      link: "See what's new",
    };
  }
  return null;
}

/**
 * For admins, on every page: a new version, one that needs them, an update that didn't work, or
 * one just installed. The details and the buttons are in Admin → Overview.
 */
export function UpdateBanner() {
  const s = useAdminUpdates().data;
  const [dismissed, setDismissed] = usePref<string | null>('update-notice-dismissed', null);
  const notice = s ? noticeFor(s) : null;
  if (!notice || notice.id === dismissed) return null;
  const Icon = notice.warning ? TriangleAlert : ArrowUpCircle;
  return (
    <section
      aria-label="Update notice"
      className={cn(
        'flex items-center gap-x-3 border-b px-4 py-2 text-sm md:px-6',
        notice.warning
          ? 'border-warning/30 bg-warning-soft text-warning'
          : 'border-border bg-accent-soft',
      )}
    >
      <Icon size={16} aria-hidden className={cn('shrink-0', !notice.warning && 'text-accent')} />
      <span className="min-w-0 flex-1">
        {notice.text}{' '}
        <Link to={notice.to} className="font-semibold underline underline-offset-2">
          {notice.link}
        </Link>
      </span>
      <IconButton label="Dismiss" icon={<X />} size="sm" onClick={() => setDismissed(notice.id)} />
    </section>
  );
}
