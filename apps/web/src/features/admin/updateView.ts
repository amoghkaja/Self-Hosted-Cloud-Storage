import type { UpdateStatus } from '@familycloud/shared';

type Last = NonNullable<UpdateStatus['last']>;

/** What the update status comes down to, for Admin → Overview and the notice for admins. */
export type UpdateView =
  /** The update helper isn't set up on the server yet. */
  | { kind: 'missing' }
  | { kind: 'not-responding' }
  /** Asked for (not started yet) or under way. */
  | { kind: 'updating'; version: string; phase: Last['phase']; started: boolean }
  /** The last update didn't work, and that version is still the newest. */
  | { kind: 'failed'; last: Last }
  /** A newer version that needs someone to do something on the server first. */
  | { kind: 'needs-steps'; version: string; steps: string[] }
  | { kind: 'available'; version: string }
  | { kind: 'up-to-date' };

const MANUAL = 'Before you update';

export function describeUpdate(s: UpdateStatus): UpdateView {
  if (s.updater === 'missing') return { kind: 'missing' };
  const { last, available: a } = s;
  if (last?.state === 'updating') {
    return { kind: 'updating', version: last.to, phase: last.phase, started: true };
  }
  if (s.updater === 'not-responding') return { kind: 'not-responding' };
  if (s.pending.install) {
    return { kind: 'updating', version: s.pending.install, phase: null, started: false };
  }
  if (
    last &&
    (last.state === 'failed' || last.state === 'rolled-back') &&
    last.to !== s.running &&
    (!a || a.version === last.to)
  ) {
    return { kind: 'failed', last };
  }
  if (a?.manualSteps) {
    const steps = a.releases.flatMap((r) =>
      r.groups.filter((g) => g.title === MANUAL).flatMap((g) => g.items),
    );
    return { kind: 'needs-steps', version: a.version, steps };
  }
  if (a) return { kind: 'available', version: a.version };
  return { kind: 'up-to-date' };
}

/** The version installed in the last three days, if any: "Updated to v0.8.0". */
export function recentlyUpdated(s: UpdateStatus, now = Date.now()): string | null {
  const l = s.last;
  return l?.state === 'done' && l.to === s.running && now - Date.parse(l.at) < 3 * 24 * 3600_000
    ? l.to
    : null;
}

/** Whether the version on offer can be installed from the browser right now. */
export function installable(s: UpdateStatus): boolean {
  const a = s.available;
  return (
    s.updater === 'ok' &&
    !!a &&
    !a.manualSteps &&
    a.ready &&
    s.problem !== 'local-changes' &&
    !s.pending.install &&
    s.last?.state !== 'updating'
  );
}

/** A command to run on the server, in the Family Cloud folder when the helper said where. */
export function serverCommand(s: UpdateStatus, command: string): string {
  return s.checkout ? `cd ${s.checkout} && ${command}` : command;
}
