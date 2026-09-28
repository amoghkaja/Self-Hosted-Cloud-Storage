import { type AdminOverview, type AdminUser, formatBytes, GiB } from '@familycloud/shared';
import { PieChart } from 'lucide-react';
import { type CSSProperties, useMemo, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useAdminMutations } from '../../api/queries';
import { Button, Dialog, toast } from '../../components/ui';
import { ByteSizeInput } from './ByteSizeInput';

export interface Segment {
  key: string;
  label: string;
  bytes: number;
  /** A CSS colour, or a pattern for "reserved"-type space. */
  fill: string;
  note?: string;
}

const HATCH =
  'repeating-linear-gradient(135deg, var(--surface-3) 0 5px, var(--border-strong) 5px 7px)';

/** People's shares of the family bar, distinct in both themes and never red/green alone. */
const PERSON_COLORS = ['#b08d57', '#4f7d6b', '#c26e4a', '#5a7fa8', '#8e6aa8', '#a1864c', '#6f8f3e'];

export const personColor = (i: number) => PERSON_COLORS[i % PERSON_COLORS.length]!;

/**
 * One horizontal bar split into labelled parts, with a legend underneath that carries the same
 * information in words (the bar alone is decoration for screen readers).
 */
export function StackedBar({
  segments,
  total,
  label,
}: {
  segments: Segment[];
  total: number;
  label: string;
}) {
  const visible = segments.filter((s) => s.bytes > 0);
  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`${label}: ${visible.map((s) => `${s.label} ${formatBytes(s.bytes)}`).join(', ')}`}
        className="flex h-4 w-full overflow-hidden rounded-full bg-surface-3"
      >
        {visible.map((s) => (
          <span
            key={s.key}
            title={`${s.label}: ${formatBytes(s.bytes)}`}
            className="h-full min-w-[3px] border-r border-surface last:border-r-0"
            style={{ width: `${(s.bytes / Math.max(total, 1)) * 100}%`, background: s.fill }}
          />
        ))}
      </div>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {segments.map((s) => (
          <li key={s.key} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-1 size-3 shrink-0 rounded-sm"
              style={{ background: s.fill } as CSSProperties}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{s.label}</span>
              {s.note && <span className="block text-xs text-muted">{s.note}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-muted">{formatBytes(s.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Where the space on the computer's disks goes, including what the family may not use. */
export function DiskBreakdown({ d }: { d: AdminOverview }) {
  const t = d.totals;
  const familyFiles = d.volumes.reduce(
    (s, v) => s + (v.online && v.status !== 'retired' ? v.usedByAppBytes : 0),
    0,
  );
  const other = Math.max(0, t.diskTotalBytes - t.diskFreeBytes - familyFiles);
  const outside = Math.max(0, t.diskFreeBytes - t.reserveBytes - t.usableFreeBytes);
  const limited = d.volumes.some((v) => v.capacityLimitBytes !== null);
  return (
    <StackedBar
      label="Disk space"
      total={t.diskTotalBytes}
      segments={[
        { key: 'family', label: 'Family files', bytes: familyFiles, fill: 'var(--accent)' },
        {
          key: 'free',
          label: 'Free for family files',
          bytes: t.usableFreeBytes,
          fill: 'var(--success)',
        },
        {
          key: 'other',
          label: 'Other things on this computer',
          bytes: other,
          fill: 'var(--muted)',
          note: 'The operating system, apps and anything outside the cloud.',
        },
        {
          key: 'reserve',
          label: 'Kept free for the computer',
          bytes: t.reserveBytes,
          fill: HATCH,
          note: 'Set per disk under Storage → Limits.',
        },
        ...(outside > 0
          ? [
              {
                key: 'outside',
                label: 'Free, but outside the cloud’s limit',
                bytes: outside,
                fill: 'var(--surface-2)',
                note: limited
                  ? 'A disk has a size limit. Raise it under Storage → Limits to use this too.'
                  : undefined,
              },
            ]
          : []),
      ]}
    />
  );
}

/** The family's pool: who uses what, what's promised in quotas, and what nobody has yet. */
export function FamilyBreakdown({ d }: { d: AdminOverview }) {
  const t = d.totals;
  const people = d.users.filter((u) => !u.disabled);
  const promisedUnused = people.reduce(
    (s, u) => s + (u.quotaBytes === null ? 0 : Math.max(0, u.quotaBytes - u.usedBytes)),
    0,
  );
  const used = people.reduce((s, u) => s + u.usedBytes, 0);
  const unallocated = Math.max(0, t.familyCapacityBytes - used - promisedUnused);
  return (
    <StackedBar
      label="Family storage"
      total={Math.max(t.familyCapacityBytes, used + promisedUnused)}
      segments={[
        ...people.map((u, i) => ({
          key: u.id,
          label: u.displayName,
          bytes: u.usedBytes,
          fill: personColor(i),
          note:
            u.quotaBytes === null ? 'No personal limit' : `Allowed ${formatBytes(u.quotaBytes)}`,
        })),
        {
          key: 'promised',
          label: 'Given to people, not used yet',
          bytes: promisedUnused,
          fill: HATCH,
        },
        {
          key: 'unallocated',
          label: 'Not given to anyone',
          bytes: unallocated,
          fill: 'var(--surface-2)',
        },
      ]}
    />
  );
}

/**
 * Hand out the family's space: set everyone's allowance side by side, split it evenly, and see
 * the total against what the family has before saving.
 */
export function AllocateDialog({ d, onClose }: { d: AdminOverview; onClose: () => void }) {
  const m = useAdminMutations();
  const people = useMemo(() => d.users.filter((u) => !u.disabled), [d.users]);
  const pool = d.totals.familyCapacityBytes;
  const [quotas, setQuotas] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(people.map((u) => [u.id, u.quotaBytes])),
  );
  const [saving, setSaving] = useState(false);
  const allocated = people.reduce((s, u) => s + (quotas[u.id] ?? 0), 0);
  const unlimited = people.filter((u) => quotas[u.id] === null).length;
  const left = pool - allocated;

  const splitEvenly = () => {
    // Whole GB each, and never below what someone already stores.
    const share = Math.floor(pool / Math.max(people.length, 1) / GiB) * GiB;
    setQuotas(Object.fromEntries(people.map((u) => [u.id, Math.max(share, roundUp(u.usedBytes))])));
  };
  const giveRestTo = (u: AdminUser) =>
    setQuotas((q) => ({ ...q, [u.id]: Math.max(0, (q[u.id] ?? 0) + left) }));

  const save = async () => {
    setSaving(true);
    const changed = people.filter((u) => quotas[u.id] !== u.quotaBytes);
    const failed: string[] = [];
    for (const u of changed) {
      try {
        await m.updateUser.mutateAsync({ id: u.id, quotaBytes: quotas[u.id] ?? null });
      } catch (err) {
        failed.push(`${u.displayName}: ${errorMessage(err)}`);
      }
    }
    setSaving(false);
    if (failed.length) toast.error(failed.join('\n'));
    else {
      toast.success(changed.length ? 'Space re-allocated' : 'Nothing changed');
      onClose();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Allocate family space"
      description={`The family has ${formatBytes(pool)} to share. Give each person an allowance; they can't upload past it.`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save allowances
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="rounded-xl bg-surface-2 p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span>
              <span className="font-semibold tabular-nums">{formatBytes(allocated)}</span> of{' '}
              {formatBytes(pool)} given out
              {unlimited > 0 && ` · ${unlimited} without a limit`}
            </span>
            <span
              className={left < 0 ? 'font-medium text-warning' : 'text-muted'}
              aria-live="polite"
            >
              {left >= 0
                ? `${formatBytes(left)} left to give`
                : `${formatBytes(-left)} more than the family has`}
            </span>
          </div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
            {people.map((u, i) => (
              <span
                key={u.id}
                style={{
                  width: `${((quotas[u.id] ?? 0) / Math.max(pool, allocated, 1)) * 100}%`,
                  background: personColor(i),
                }}
              />
            ))}
          </div>
          {left < 0 && (
            <p className="mt-2 text-xs text-muted">
              Over-allocating is allowed: it works as long as not everyone fills up at once.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" icon={<PieChart size={14} />} onClick={splitEvenly}>
              Split evenly
            </Button>
          </div>
        </div>
        <ul className="flex flex-col gap-4">
          {people.map((u, i) => (
            <li
              key={u.id}
              className="flex flex-col gap-2 border-b border-border pb-4 last:border-0"
            >
              <div className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className="size-3 rounded-sm"
                  style={{ background: personColor(i) }}
                />
                <span className="font-medium">{u.displayName}</span>
                <span className="text-muted">· uses {formatBytes(u.usedBytes)}</span>
                {left > 0 && quotas[u.id] !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => giveRestTo(u)}
                  >
                    Give the rest
                  </Button>
                )}
              </div>
              <ByteSizeInput
                label={`Allowance for ${u.displayName}`}
                value={quotas[u.id] ?? null}
                onChange={(v) => setQuotas((q) => ({ ...q, [u.id]: v }))}
                unlimitedLabel="No personal limit (only the family limit applies)"
              />
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

const roundUp = (bytes: number) => Math.ceil(bytes / GiB) * GiB;
