import { ErrorCode, splitExtension } from '@familycloud/shared/all';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { officeSessions, sessions, type UserRow, users } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';

/**
 * The document editor (Collabora Online), in a container of its own. Browsers reach it at
 * OFFICE_PUBLIC_URL through the app (proxy.ts); it reads and saves files through the WOPI
 * listener (wopi.ts) with a token per opened file, made here.
 */

/** The admin's switch. Kept apart from Settings, which the settings form saves whole. */
const SWITCH_KEY = 'officeEditing';
const SWITCH_TTL_MS = 5_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
/** Not answering: asked again this soon, so a starting editor shows up quickly. */
const DISCOVERY_RETRY_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 3_000;
/** How long one opened file stays editable without opening it again. */
export const OFFICE_SESSION_MS = 10 * 60 * 60_000;
const TOUCH_EVERY_MS = 60_000;

export interface Discovery {
  /** Extension (".docx") → the editor page for it, as path and query (e.g. /browser/…/cool.html?). */
  editPages: Map<string, string>;
}

interface State {
  enabled?: { at: number; value: boolean };
  discovery?: { at: number; value: Discovery | null };
  inflight?: Promise<Discovery | null>;
}
const states = new WeakMap<AppContext, State>();
const stateOf = (ctx: AppContext) => {
  let s = states.get(ctx);
  if (!s) {
    s = {};
    states.set(ctx, s);
  }
  return s;
};

export async function editingEnabled(ctx: AppContext): Promise<boolean> {
  if (!ctx.config.office) return false;
  const s = stateOf(ctx);
  if (s.enabled && Date.now() - s.enabled.at < SWITCH_TTL_MS) return s.enabled.value;
  const value = (await ctx.settings.getRaw<boolean>(SWITCH_KEY)) === true;
  s.enabled = { at: Date.now(), value };
  return value;
}

export async function setEditingEnabled(ctx: AppContext, on: boolean): Promise<void> {
  await ctx.settings.setRaw(SWITCH_KEY, on);
  stateOf(ctx).enabled = { at: Date.now(), value: on };
}

/** The editor pages it offers, from its discovery document. */
export function parseDiscovery(xml: string): Discovery {
  const editPages = new Map<string, string>();
  for (const [tag] of xml.matchAll(/<action\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
    const ext = attr('ext');
    const src = attr('urlsrc');
    if (attr('name') !== 'edit' || !ext || !src || !URL.canParse(src)) continue;
    const url = new URL(src.replaceAll('&amp;', '&'));
    editPages.set(`.${ext.toLowerCase()}`, `${url.pathname}${url.search || '?'}`);
  }
  return { editPages };
}

/** The editor's discovery document: null while it isn't running (or isn't set up). */
export async function discovery(
  ctx: AppContext,
  opts: { fresh?: boolean } = {},
): Promise<Discovery | null> {
  const office = ctx.config.office;
  if (!office) return null;
  const s = stateOf(ctx);
  const cached = s.discovery;
  const ttl = cached?.value ? DISCOVERY_TTL_MS : DISCOVERY_RETRY_MS;
  if (!opts.fresh && cached && Date.now() - cached.at < ttl) return cached.value;
  s.inflight ??= fetch(`${office.internalUrl}/hosting/discovery`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
    .then(async (res) => (res.ok ? parseDiscovery(await res.text()) : null))
    .catch(() => null)
    .then((value) => {
      s.discovery = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      s.inflight = undefined;
    });
  return s.inflight;
}

/** Whether people can open files in the editor right now. */
export async function editorAvailable(ctx: AppContext): Promise<boolean> {
  return (await editingEnabled(ctx)) && (await discovery(ctx)) !== null;
}

/** The editor page for a file, or why it can't be opened. */
export async function editPage(ctx: AppContext, name: string): Promise<string> {
  const unavailable = (why: string) => new AppError(409, ErrorCode.OFFICE_UNAVAILABLE, why);
  if (!ctx.config.office || !(await editingEnabled(ctx))) {
    throw unavailable('Editing documents in the browser is turned off on this server.');
  }
  const found = await discovery(ctx);
  if (!found) {
    throw unavailable(
      "The document editor isn't answering. It may still be starting: try again in a minute.",
    );
  }
  const page = found.editPages.get(splitExtension(name)[1].toLowerCase());
  if (!page) throw unavailable("The document editor can't edit this kind of file.");
  return page;
}

export async function createOfficeSession(
  ctx: AppContext,
  input: { userId: string; sessionId: string; nodeId: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + OFFICE_SESSION_MS);
  await ctx.db.insert(officeSessions).values({ ...input, tokenHash: sha256(token), expiresAt });
  return { token, expiresAt };
}

export type OfficeSessionRow = typeof officeSessions.$inferSelect;

/**
 * The editing session a WOPI request's token belongs to, for that one file. Only while it lasts,
 * the sign-in it came from lasts, and the person isn't disabled.
 */
export async function resolveOfficeToken(
  ctx: AppContext,
  token: unknown,
  nodeId: string,
): Promise<{ office: OfficeSessionRow; user: UserRow } | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const now = new Date();
  const [row] = await ctx.db
    .select({ office: officeSessions, user: users })
    .from(officeSessions)
    .innerJoin(sessions, eq(sessions.id, officeSessions.sessionId))
    .innerJoin(users, eq(users.id, officeSessions.userId))
    .where(
      and(
        eq(officeSessions.tokenHash, sha256(token)),
        eq(officeSessions.nodeId, nodeId),
        gt(officeSessions.expiresAt, now),
        gt(sessions.expiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
        isNull(users.disabledAt),
      ),
    );
  if (!row) return null;
  if (now.getTime() - row.office.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await ctx.db
      .update(officeSessions)
      .set({ lastUsedAt: now })
      .where(eq(officeSessions.id, row.office.id));
  }
  return row;
}

/** Files opened or saved in the editor in the last 10 minutes. */
export async function openDocuments(ctx: AppContext): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(distinct ${officeSessions.nodeId})::int` })
    .from(officeSessions)
    .where(
      and(
        gt(officeSessions.lastUsedAt, new Date(Date.now() - 10 * 60_000)),
        gt(officeSessions.expiresAt, new Date()),
      ),
    );
  return row?.n ?? 0;
}

export async function deleteExpiredOfficeSessions(ctx: AppContext): Promise<void> {
  await ctx.db.delete(officeSessions).where(lt(officeSessions.expiresAt, new Date()));
}
