import { z } from 'zod';

export const ReleaseNotes = z.object({
  /** `v0.4.0`, or `Unreleased` for changes newer than the latest release. */
  version: z.string(),
  /** YYYY-MM-DD; null for Unreleased. */
  date: z.string().nullable(),
  groups: z.array(z.object({ title: z.string(), items: z.array(z.string()) })),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotes>;

export const About = z.object({
  /** The version this server is running, e.g. `v0.4.0`, or `v0.4.0-5-gabc1234` built after it. */
  version: z.string(),
  /** What changed in each release, newest first. Items keep the changelog's `**bold**` marks. */
  releases: z.array(ReleaseNotes),
});
export type About = z.infer<typeof About>;
