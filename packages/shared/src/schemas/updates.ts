import { z } from 'zod';
import { ReleaseNotes } from './about';
import { IsoDate } from './common';

/** A version as git describes it: `v0.7.0`, or `v0.7.0-3-gabc1234` built after it. */
export const AppVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);

export const UpdatePhase = z.enum(['download', 'backup', 'restart']);
/**
 * Why an update failed: getting the new version (`build`), the database backup, the new version
 * never answering (`start`), going back after it crashed (`rollback`), or it was cut short.
 */
export const UpdateReason = z.enum(['build', 'backup', 'start', 'rollback', 'error']);
/** Who started it: someone on the server, Admin → Overview, or automatic updates at night. */
export const UpdateTrigger = z.enum(['manual', 'browser', 'auto']);

/**
 * What the update helper on the server (`scripts/update.sh --cron`) last found and did, for
 * Admin → Overview. The helper runs every minute; the app can only leave it requests.
 */
export const UpdateStatus = z.object({
  /** The version this server runs. */
  running: z.string(),
  /**
   * The update helper: answering, not set up yet, not answering (cron stopped, say), or off
   * because the admin chose to update by hand (UPDATES=manual on the server).
   */
  updater: z.enum(['ok', 'missing', 'not-responding', 'off']),
  /** `stable` follows releases; `main` builds the latest code on the server. */
  channel: z.enum(['stable', 'main']).nullable(),
  checkedAt: IsoDate.nullable(),
  /** Why the last check couldn't tell or updating can't go ahead. */
  problem: z.enum(['offline', 'local-changes']).nullable(),
  /** A newer version, with what's new in each release since this one. */
  available: z
    .object({
      version: AppVersion,
      releases: z.array(ReleaseNotes),
      /** It lists steps under "Before you update", so it's installed only by hand. */
      manualSteps: z.boolean(),
      /** Its image is published: a release's follows the release itself by some minutes. */
      ready: z.boolean(),
      /** It failed to start here before; automatic updates skip it. */
      failedBefore: z.boolean(),
    })
    .nullable(),
  auto: z.object({
    enabled: z.boolean(),
    /** When automatic updates next run. */
    nextAt: IsoDate.nullable(),
    /** The server's time zone ("at night" goes by its clock), e.g. `Etc/UTC`. */
    timezone: z.string().nullable(),
  }),
  /** Requests the helper hasn't answered yet. */
  pending: z.object({
    check: z.boolean(),
    install: AppVersion.nullable(),
    auto: z.boolean().nullable(),
  }),
  /** The update under way, or how the last one went. */
  last: z
    .object({
      state: z.enum(['updating', 'done', 'rolled-back', 'failed']),
      phase: UpdatePhase.nullable(),
      from: z.string().nullable(),
      to: AppVersion,
      at: IsoDate,
      reason: UpdateReason.nullable(),
      trigger: UpdateTrigger.nullable(),
      /** The end of a failed update's output. */
      log: z.array(z.string()),
    })
    .nullable(),
  /** Where Family Cloud is on the server, for commands to copy. */
  checkout: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export const InstallUpdateBody = z.object({ version: AppVersion });
export const AutoUpdateBody = z.object({ enabled: z.boolean() });
