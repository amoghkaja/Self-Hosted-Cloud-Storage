import { z } from 'zod';
import { Bytes } from './common';
import { FileNode } from './files';

/** A file on the "Free up space" page, with the folder it's in ("" = the top of My Files). */
export const CleanupFile = FileNode.extend({ folder: z.string() });
export type CleanupFile = z.infer<typeof CleanupFile>;

/** Copies of the same contents in one person's files: every copy counts toward their space. */
export const DuplicateGroup = z.object({
  size: Bytes,
  /** How many copies there are (only the first few are listed). */
  count: z.number().int(),
  files: z.array(CleanupFile),
});
export type DuplicateGroup = z.infer<typeof DuplicateGroup>;

export const CleanupReport = z.object({
  largest: z.array(CleanupFile),
  duplicates: z.array(DuplicateGroup),
  versions: z.object({
    count: z.number().int(),
    bytes: Bytes,
    files: z.array(z.object({ file: CleanupFile, count: z.number().int(), bytes: Bytes })),
  }),
  trash: z.object({ count: z.number().int(), bytes: Bytes }),
});
export type CleanupReport = z.infer<typeof CleanupReport>;

export const Freed = z.object({ count: z.number().int(), bytes: Bytes });
export type Freed = z.infer<typeof Freed>;
