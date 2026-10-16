import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  AppVersion,
  IsoDate,
  type ReleaseNotes,
  UpdatePhase,
  UpdateReason,
  type UpdateStatus,
  UpdateTrigger,
} from '@familycloud/shared/all';
import { z } from 'zod';
import { parseChangelog } from '../../lib/changelog';

// The update helper on the host (scripts/update.sh --cron) and the app share cache/updates: the
// helper leaves what it found and did there, and the app leaves it requests, empty files whose
// name is the whole request. The worker has the same folder as the same user, so nothing in it
// is trusted: files are read without following links, size-limited and validated, and requests
// are new files renamed into place, never written through a name someone else put there.

/** status.json, as update.sh writes it. */
const HostStatus = z.object({
  format: z.literal(1),
  channel: z.enum(['stable', 'main']).nullable(),
  // Shown in a command for the admin to copy: plain path characters only.
  checkout: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]{1,200}$/)
    .nullable(),
  timezone: z
    .string()
    .regex(/^[A-Za-z0-9_+/-]{1,64}$/)
    .nullable(),
  /** UPDATES in deploy/.env (auto, notify or manual); null before the admin chose. */
  updates: z.enum(['auto', 'notify', 'manual']).nullable(),
  nextAutoAt: IsoDate.nullable(),
  triedAt: IsoDate.nullable(),
  checkedAt: IsoDate.nullable(),
  problem: z.enum(['offline', 'local-changes']).nullable(),
  latest: AppVersion.nullable(),
  ready: z.boolean(),
  manualSteps: z.boolean(),
  failedVersion: AppVersion.nullable(),
  state: z.enum(['idle', 'updating', 'done', 'rolled-back', 'failed']),
  phase: UpdatePhase.nullable(),
  from: AppVersion.nullable(),
  to: AppVersion.nullable(),
  at: IsoDate.nullable(),
  reason: UpdateReason.nullable(),
  trigger: UpdateTrigger.nullable(),
});
type HostStatus = z.infer<typeof HostStatus>;

export interface HostFiles {
  status: HostStatus | null;
  /** What's new in the versions after the running one (notes.md). */
  notes: ReleaseNotes[];
  /** The end of a failed update's output (update.log). */
  log: string[];
  requests: { name: string; at: number }[];
}

const REQUEST =
  /^request-(check|auto-on|auto-off|office-on|office-off|update-[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/;
const MINUTE = 60_000;

/** A small regular file, or null: never through a link, never a FIFO or device, never too big. */
async function readSmall(file: string, max: number): Promise<string | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await fh.stat()).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    return bytesRead > max ? null : buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

async function isFolder(dir: string): Promise<boolean> {
  return lstat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

function parseStatus(text: string | null): HostStatus | null {
  if (text === null) return null;
  try {
    return HostStatus.safeParse(JSON.parse(text)).data ?? null;
  } catch {
    return null;
  }
}

export async function readHost(dir: string): Promise<HostFiles> {
  if (!(await isFolder(dir))) return { status: null, notes: [], log: [], requests: [] };
  const [status, notes, log, entries] = await Promise.all([
    readSmall(path.join(dir, 'status.json'), 4096).then(parseStatus),
    readSmall(path.join(dir, 'notes.md'), 256 * 1024),
    readSmall(path.join(dir, 'update.log'), 64 * 1024),
    readdir(dir, { withFileTypes: true }).catch(() => []),
  ]);
  const requests = await Promise.all(
    entries
      .filter((e) => e.isFile() && REQUEST.test(e.name))
      .map((e) =>
        lstat(path.join(dir, e.name)).then(
          (s) => ({ name: e.name, at: s.mtimeMs }),
          () => null,
        ),
      ),
  );
  return {
    status,
    notes: notes ? parseChangelog(notes) : [],
    log: (log ?? '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(-80)
      .map((l) => l.slice(0, 500)),
    requests: requests.filter((r) => r !== null),
  };
}

/** What Admin → Overview shows, from what the helper left and the requests still waiting. */
export function toUpdateStatus(running: string, host: HostFiles, now = Date.now()): UpdateStatus {
  const s = host.status;
  const request = (name: string) => host.requests.find((r) => r.name === name);
  const install = host.requests.find((r) => r.name.startsWith('request-update-'));
  const on = request('request-auto-on');
  const off = request('request-auto-off');
  const updating = s?.state === 'updating';
  // It tries a check at least every 6 hours, and answers a request within a minute or so.
  const tried = s?.triedAt ? Date.parse(s.triedAt) : 0;
  const unanswered = !updating && host.requests.some((r) => now - r.at > 3 * MINUTE);
  const latest = s?.latest && s.latest !== running ? s.latest : null;
  const auto = s?.updates === 'auto';
  // Too slow to answer in time, but it got there: that update worked.
  const lateStart = s?.state === 'failed' && s.reason === 'start' && s.to === running;
  const state = lateStart ? 'done' : s?.state;
  return {
    running,
    // No choice made yet means no helper; manual means the admin turned it off.
    updater: !s?.updates
      ? 'missing'
      : s.updates === 'manual'
        ? 'off'
        : now - tried > 13 * 60 * MINUTE || unanswered
          ? 'not-responding'
          : 'ok',
    channel: s?.channel ?? null,
    checkedAt: s?.checkedAt ?? null,
    problem: s?.problem ?? null,
    available:
      s && latest
        ? {
            version: latest,
            releases: host.notes,
            manualSteps: s.manualSteps,
            ready: s.ready,
            failedBefore: s.failedVersion === latest,
          }
        : null,
    auto: {
      enabled: auto,
      nextAt: auto ? (s?.nextAutoAt ?? null) : null,
      timezone: s?.timezone ?? null,
    },
    pending: {
      check: !!request('request-check'),
      install: install ? install.name.slice('request-update-'.length) : null,
      auto: on && (!off || on.at >= off.at) ? true : off ? false : null,
    },
    last:
      s && state && state !== 'idle' && s.to && s.at
        ? {
            state,
            phase: s.phase,
            from: s.from,
            to: s.to,
            at: s.at,
            reason: lateStart ? null : s.reason,
            trigger: s.trigger,
            log: state === 'failed' || state === 'rolled-back' ? host.log : [],
          }
        : null,
    checkout: s?.checkout ?? null,
  };
}

/** Leaves a request for the helper: a new empty file, renamed over anything with that name. */
export async function leaveRequest(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (!(await isFolder(dir))) throw new Error(`${dir} is not a folder`);
  const tmp = path.join(dir, `.${name}.${randomUUID()}`);
  await writeFile(tmp, '', { flag: 'wx' });
  await rename(tmp, path.join(dir, name)).catch(async (err) => {
    await rm(tmp, { force: true });
    throw err;
  });
}

export async function dropRequest(dir: string, name: string): Promise<void> {
  await rm(path.join(dir, name), { force: true }).catch(() => {});
}
