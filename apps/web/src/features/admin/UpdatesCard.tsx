import type { UpdateStatus } from '@familycloud/shared';
import { Check, CheckCircle2, Circle, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { updatedSinceLoad, useAdminUpdates, useUpdateMutations } from '../../api/queries';
import { Button, Skeleton, SwitchField, toast } from '../../components/ui';
import { formatDateTime, formatRelative } from '../../lib/format';
import { Line, ReleaseGroups } from '../about/WhatsNewPage';
import { describeUpdate, installable, recentlyUpdated, serverCommand } from './updateView';

const STEPS = [
  { phase: 'download', label: 'Getting the new version' },
  { phase: 'backup', label: 'Backing up the database' },
  { phase: 'restart', label: 'Restarting' },
] as const;

/** "The update to v0.8.0 …", by why it failed. */
const FAILED = {
  build: "couldn't be downloaded or built, so nothing changed.",
  backup: "didn't go ahead: the database backup before it failed, so nothing changed.",
  start: "didn't answer after the restart.",
  rollback: "didn't start, and going back to the version before didn't work either.",
  error: 'was cut short.',
} as const;

const run = (p: Promise<unknown>) => void p.catch((err) => toast.error(errorMessage(err)));

function Notice({ tone, children }: { tone: 'warning' | 'danger'; children: ReactNode }) {
  const colours =
    tone === 'danger'
      ? 'border-danger/30 bg-danger-soft text-danger'
      : 'border-warning/30 bg-warning-soft text-warning';
  return (
    <div className={`flex gap-2 rounded-xl border px-3 py-2 text-sm ${colours}`}>
      <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Command({ children }: { children: string }) {
  return <code className="font-mono text-[13px] break-all">{children}</code>;
}

/** What's new in the versions on offer, folded away until asked for. */
function WhatsNew({ s }: { s: UpdateStatus }) {
  const releases = s.available?.releases ?? [];
  if (!releases.length) return null;
  return (
    <details className="rounded-xl bg-surface-2 px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">What's new</summary>
      <div className="mt-3 flex flex-col gap-4">
        {releases.map((r) => (
          <div key={r.version}>
            {releases.length > 1 && (
              <p className="mb-2 text-sm font-semibold">
                {r.version === 'Unreleased' ? 'Latest changes' : r.version}
              </p>
            )}
            <ReleaseGroups release={r} />
          </div>
        ))}
      </div>
    </details>
  );
}

function Steps({ phase, started }: { phase: string | null; started: boolean }) {
  if (!started) return <p>Waiting for the server to start it, within a minute.</p>;
  const current = STEPS.findIndex((s) => s.phase === phase);
  return (
    <ol className="flex flex-col gap-1.5">
      {STEPS.map((step, i) => (
        <li
          key={step.phase}
          aria-current={i === current ? 'step' : undefined}
          className={`flex items-center gap-2 ${i > current ? 'text-muted' : ''}`}
        >
          {i < current ? (
            <Check size={16} className="text-success" aria-hidden />
          ) : i === current ? (
            <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden />
          ) : (
            <Circle size={16} aria-hidden />
          )}
          {step.label}
          {i < current && <span className="sr-only">(done)</span>}
        </li>
      ))}
    </ol>
  );
}

/** The switch for automatic updates at night, and when they next run in the admin's time. */
function AutoUpdates({ s }: { s: UpdateStatus }) {
  const m = useUpdateMutations();
  const saving = s.pending.auto !== null || m.setAuto.isPending;
  const next = s.auto.enabled && s.auto.nextAt && !saving ? s.auto.nextAt : null;
  // "At night" goes by the server's clock, which on UTC can be the middle of the day here.
  const hour = next ? new Date(next).getHours() : 0;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <SwitchField
        label="Install updates automatically"
        description={
          saving
            ? 'Saving… the server picks this up within a minute.'
            : "At night, around 4:30 by the server's clock, with a database backup first. Updates that need you to do something are left for you."
        }
        checked={s.pending.auto ?? s.auto.enabled}
        disabled={saving || s.updater !== 'ok'}
        onCheckedChange={(on) => run(m.setAuto.mutateAsync(on))}
      />
      {next && <p className="text-xs text-muted">Next: {formatDateTime(next)}, your time.</p>}
      {next && hour >= 7 && hour < 23 && (
        <Notice tone="warning">
          That's during the day where you are: the server's clock is set to{' '}
          {s.auto.timezone ?? 'another time zone'}. To make it your night, run{' '}
          <Command>{`sudo timedatectl set-timezone ${zone} && sudo systemctl restart cron`}</Command>{' '}
          on the server.
        </Notice>
      )}
    </div>
  );
}

function Updates({ s, unreachable }: { s: UpdateStatus; unreachable: boolean }) {
  const m = useUpdateMutations();
  const view = describeUpdate(s);
  const recent = recentlyUpdated(s);
  const install = () => s.available && run(m.install.mutateAsync(s.available.version));
  const command = (c: string) => <Command>{serverCommand(s, c)}</Command>;
  const restartNote = (
    <p className="text-muted">
      The family can't use the cloud for a minute or two while it restarts.
    </p>
  );
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        This server runs Family Cloud {s.running} ·{' '}
        <Link to="/whats-new" className="underline underline-offset-2 hover:text-text">
          What's new
        </Link>
      </p>
      {recent && view.kind !== 'updating' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex items-center gap-2">
            <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden />
            Updated to {recent} {formatRelative(s.last?.at ?? '')}.
          </p>
          {updatedSinceLoad(s) && (
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload this page
            </Button>
          )}
        </div>
      )}

      {view.kind === 'missing' && (
        <p className="text-muted">
          To see new versions here and install them with a click, run{' '}
          <Command>./scripts/update.sh --updates notify</Command> on the server (or{' '}
          <Command>auto</Command> to have them installed at night). That adds the update helper to
          the server's crontab: it looks for new versions on GitHub every few hours and answers this
          page.
        </p>
      )}

      {view.kind === 'off' && (
        <p className="text-muted">
          Updates on this server are done by hand: run {command('./scripts/update.sh')} there, and
          it shows what's new before it updates. To see new versions here and install them with a
          click, run <Command>./scripts/update.sh --updates notify</Command> there.
        </p>
      )}

      {view.kind === 'not-responding' && (
        <Notice tone="warning">
          The update helper on the server isn't answering
          {s.checkedAt ? ` (it last looked for updates ${formatRelative(s.checkedAt)})` : ''}. Its
          line should be in the server's crontab (<Command>crontab -l</Command>); to add it again,
          run {command(`./scripts/update.sh --updates ${s.auto.enabled ? 'auto' : 'notify'}`)}{' '}
          there.
        </Notice>
      )}

      {view.kind === 'updating' && (
        <div role="status" className="flex flex-col gap-2">
          <p className="font-medium">Updating to {view.version}</p>
          {unreachable ? (
            <p>Restarting… This page reconnects by itself.</p>
          ) : (
            <Steps phase={view.phase} started={view.started} />
          )}
          {restartNote}
        </div>
      )}

      {view.kind === 'failed' && (
        <div className="flex flex-col gap-3">
          <Notice tone="danger">
            {view.last.state === 'rolled-back'
              ? `${view.last.to} didn't start, so the cloud went back to ${view.last.from ?? 'the version it had'}, with everything as it was before.`
              : `The update to ${view.last.to} ${FAILED[view.last.reason ?? 'error']}`}{' '}
            ({formatRelative(view.last.at)})
          </Notice>
          {s.available?.failedBefore && (
            <p className="text-muted">
              Automatic updates won't try it again: they wait for a newer version.
            </p>
          )}
          {view.last.log.length > 0 && (
            <details>
              <summary className="cursor-pointer">What the server said</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap">
                {view.last.log.join('\n')}
              </pre>
            </details>
          )}
          <WhatsNew s={s} />
          {installable(s) && (
            <div>
              <Button onClick={install} loading={m.install.isPending}>
                Try again
              </Button>
            </div>
          )}
        </div>
      )}

      {view.kind === 'needs-steps' && (
        <div className="flex flex-col gap-2">
          <p className="font-medium">{view.version} is available</p>
          <p>
            It needs you to do something on the server first, so it's never installed by itself:
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            {view.steps.map((step) => (
              <li key={step}>
                <Line text={step} />
              </li>
            ))}
          </ul>
          <p>Then run {command('./scripts/update.sh')} there.</p>
          <WhatsNew s={s} />
        </div>
      )}

      {view.kind === 'available' && (
        <div className="flex flex-col gap-3">
          <p className="font-medium">{view.version} is available</p>
          <WhatsNew s={s} />
          {s.problem === 'local-changes' && (
            <Notice tone="warning">
              Files in the Family Cloud folder on the server were changed, so it can't update. To
              see which, run {command('git status')} there.
            </Notice>
          )}
          {!s.available?.ready && (
            <p className="text-muted">
              It's still being published: you can install it in a few minutes.
            </p>
          )}
          {s.available?.failedBefore && (
            <p className="text-muted">
              It didn't start here last time, so automatic updates skip it.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              variant="primary"
              onClick={install}
              disabled={!installable(s)}
              loading={m.install.isPending}
            >
              Update now
            </Button>
            {s.auto.enabled && s.auto.nextAt && !s.available?.failedBefore && (
              <span className="text-muted">
                or it installs by itself {formatRelative(s.auto.nextAt)}
              </span>
            )}
          </div>
          {restartNote}
        </div>
      )}

      {view.kind === 'up-to-date' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex items-center gap-2">
            <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden />
            Up to date{s.checkedAt ? `, checked ${formatRelative(s.checkedAt)}` : ''}.
          </p>
          <Button
            size="sm"
            variant="ghost"
            loading={s.pending.check || m.check.isPending}
            onClick={() => run(m.check.mutateAsync())}
          >
            Check now
          </Button>
        </div>
      )}
      {s.problem === 'offline' && view.kind !== 'updating' && (
        <p className="text-muted">
          The last check couldn't reach the internet. It tries again in a few hours.
        </p>
      )}

      {view.kind !== 'missing' && view.kind !== 'off' && <AutoUpdates s={s} />}
    </div>
  );
}

/** Admin → Overview: the version this server runs, new versions and installing them. */
export function UpdatesCard() {
  const q = useAdminUpdates();
  return (
    <section
      aria-labelledby="updates-title"
      className="rounded-2xl border border-border bg-surface p-5"
    >
      <h2 id="updates-title" className="mb-4 text-base font-semibold">
        Updates
      </h2>
      {q.data ? (
        // Kept while the server restarts for an update: it answers again by itself.
        <Updates s={q.data} unreachable={q.isError} />
      ) : q.isError ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p>{errorMessage(q.error)}</p>
          <Button size="sm" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <Skeleton className="h-24" />
      )}
    </section>
  );
}
