import { z } from 'zod';

/** For everyone: whether files can be opened in the document editor right now. */
export const OfficeInfo = z.object({ available: z.boolean() });
export type OfficeInfo = z.infer<typeof OfficeInfo>;

/**
 * Opens a file in the editor: the page posts `accessToken` to `url` in a frame. The token lets
 * the editor read and save that one file, as the person who opened it.
 */
export const EditSession = z.object({
  url: z.string(),
  /** The editor's origin, the only one the page accepts messages from. */
  origin: z.string(),
  accessToken: z.string(),
  /** When the token stops working, in milliseconds since 1970 (WOPI's access_token_ttl). */
  accessTokenTtl: z.number().int(),
});
export type EditSession = z.infer<typeof EditSession>;

/**
 * Admin → Settings: the document editor. It runs in a container of its own (Collabora Online)
 * that needs about 1–2 GB of memory, so turning it off from here also removes that container.
 */
export const OfficeStatus = z.object({
  /** Set up on the server (OFFICE_PUBLIC_URL); until then only ./scripts/office.sh can add it. */
  configured: z.boolean(),
  /** The editor's address, e.g. https://office.example.com. */
  publicUrl: z.string().nullable(),
  /** The switch: people can open files in the editor. */
  enabled: z.boolean(),
  /** The editor container answered just now. Null when not set up. */
  running: z.boolean().nullable(),
  /** Waiting for the update helper to start or remove the editor container. */
  pending: z.enum(['on', 'off']).nullable(),
  /**
   * The update helper that starts and removes the container: answering, not set up, or not
   * answering. Without it the switch still works, but the memory only comes back after
   * ./scripts/office.sh off on the server.
   */
  helper: z.enum(['ok', 'missing', 'not-responding']),
  /** Files opened or saved in the editor in the last 10 minutes. */
  openDocuments: z.number().int(),
  memory: z.object({ totalBytes: z.number(), availableBytes: z.number() }),
});
export type OfficeStatus = z.infer<typeof OfficeStatus>;

export const SetOfficeBody = z.object({ enabled: z.boolean() });
export type SetOfficeBody = z.infer<typeof SetOfficeBody>;
