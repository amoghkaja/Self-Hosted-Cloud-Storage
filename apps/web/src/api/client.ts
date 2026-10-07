import { API_PREFIX, type ErrorCode, type ProblemDetails } from '@familycloud/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly issues?: ProblemDetails['issues'],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Lets the app react globally when the session expires (clear cache, go to /login). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  json?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Don't fire the global 401 handler (e.g. /auth/me probing whether we're signed in). */
  quiet401?: boolean;
}

export function apiUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_PREFIX}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** JSON API call. Errors always surface as ApiError with the server's stable `code`. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path, opts.query), {
      method: opts.method ?? (opts.json === undefined ? 'GET' : 'POST'),
      headers: opts.json === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', "Can't reach the server. Check your connection.");
  }
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  let problem: Partial<ProblemDetails> = {};
  try {
    problem = (await res.json()) as ProblemDetails;
  } catch {
    // non-JSON error (proxy page); fall through with a generic message
  }
  // Only a missing or ended session means signed out. Other 401s are a wrong code, a passkey that
  // didn't verify or a locked link, and must not send someone who is signed in to /login.
  const sessionGone = (problem.code ?? 'UNAUTHENTICATED') === 'UNAUTHENTICATED';
  if (res.status === 401 && sessionGone && !opts.quiet401) {
    for (const l of unauthorizedListeners) l();
  }
  throw new ApiError(
    res.status,
    (problem.code ?? 'INTERNAL_ERROR') as ErrorCode,
    problem.detail ?? `Request failed (${res.status})`,
    problem.issues,
  );
}

/**
 * Whether a link's token itself is no good (removed, expired, used, or cut off when copied: a
 * 4xx), rather than the server being unreachable or busy, when trying again may well work.
 */
export function isUnusableLink(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export const contentUrl = (nodeId: string, inline = false) =>
  apiUrl(`/nodes/${nodeId}/content`, inline ? { inline: 1 } : undefined);
/** A video's streaming version (720p when ready, else the original). */
export const streamUrl = (nodeId: string) => apiUrl(`/nodes/${nodeId}/stream`);
export const previewUrl = (nodeId: string) => apiUrl(`/nodes/${nodeId}/preview`);
/**
 * Browsers keep a thumbnail for good (it's served as immutable), so the address carries the
 * file's `updatedAt`: saving over a file (Replace, a restored version, Rewind) gives its new
 * picture a new address instead of showing the old one.
 */
export const thumbUrl = (nodeId: string, size: 256 | 1600 = 256, version?: string) =>
  apiUrl(`/nodes/${nodeId}/thumbnail`, { size, v: version });
/** An album photo's thumbnail, versioned the same way (AlbumPhoto and AlbumCover `updatedAt`). */
export const albumThumbUrl = (
  albumId: string,
  nodeId: string,
  size: 256 | 1600,
  version?: string,
) => apiUrl(`/albums/${albumId}/photos/${nodeId}/thumbnail`, { size, v: version });
export const zipUrl = (ids: string[]) => apiUrl('/zip', { ids: ids.join(',') });
export const versionUrl = (nodeId: string, versionId: string) =>
  apiUrl(`/nodes/${nodeId}/versions/${versionId}/content`);
