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
  if (res.status === 401 && !opts.quiet401) {
    for (const l of unauthorizedListeners) l();
  }
  throw new ApiError(
    res.status,
    (problem.code ?? 'INTERNAL_ERROR') as ErrorCode,
    problem.detail ?? `Request failed (${res.status})`,
    problem.issues,
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
export const thumbUrl = (nodeId: string, size: 256 | 1600 = 256) =>
  apiUrl(`/nodes/${nodeId}/thumbnail`, { size });
export const zipUrl = (ids: string[]) => apiUrl('/zip', { ids: ids.join(',') });
export const versionUrl = (nodeId: string, versionId: string) =>
  apiUrl(`/nodes/${nodeId}/versions/${versionId}/content`);
