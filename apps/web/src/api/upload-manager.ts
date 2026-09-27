import type { ChunkResult, FileNode, UploadSession } from '@familycloud/shared';
import { ApiError, api, apiUrl } from './client';

export type UploadStatus = 'queued' | 'uploading' | 'finalizing' | 'done' | 'error' | 'canceled';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  /** Folder the user dropped onto. */
  parentId: string;
  /** Sub-path for folder uploads ("Holiday/Day 1"). */
  relativeDir: string;
  error?: string;
  nodeId?: string;
}

export interface UploadTransport {
  createUpload(body: {
    parentId: string;
    name: string;
    size: number;
    mimeType?: string;
  }): Promise<UploadSession>;
  getUpload(id: string): Promise<UploadSession>;
  putChunk(
    sessionId: string,
    index: number,
    data: Blob,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<ChunkResult>;
  abortUpload(id: string): Promise<void>;
  ensureFolder(parentId: string, name: string): Promise<{ id: string }>;
}

export interface UploadManagerOptions {
  fileConcurrency: number;
  chunkConcurrency: number;
  maxRetries: number;
  retryBaseMs: number;
}

const DEFAULTS: UploadManagerOptions = {
  fileConcurrency: 3,
  chunkConcurrency: 3,
  maxRetries: 6,
  retryBaseMs: 1000,
};

// Only transient failures: network drops, rate limits and gateway/server hiccups. Quota
// (507), validation and permission errors won't fix themselves, so they fail fast.
const RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);
const isRetryable = (err: unknown) => err instanceof ApiError && RETRYABLE.has(err.status);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

const waitForOnline = (signal: AbortSignal) =>
  typeof navigator === 'undefined' || navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        window.addEventListener('online', () => resolve(), { once: true });
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });

const schedule =
  typeof requestAnimationFrame === 'function'
    ? (fn: () => void) => requestAnimationFrame(fn)
    : (fn: () => void) => setTimeout(fn, 16);

/**
 * Upload queue living outside React. Components read it with useSyncExternalStore; progress
 * notifications are batched to one per animation frame so hundreds of photos don't cause a
 * render storm. Resumable: chunks the server already has are skipped, failed chunks retry with
 * backoff, and a dropped connection waits for the browser to come back online.
 */
export class UploadManager {
  private items: UploadItem[] = [];
  private snapshot: readonly UploadItem[] = [];
  private readonly files = new Map<string, File>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly sessions = new Map<string, string>();
  private readonly folders = new Map<string, Promise<string>>();
  private readonly listeners = new Set<() => void>();
  private active = 0;
  private emitPending = false;
  private nextId = 1;
  private readonly opts: UploadManagerOptions;

  /** Called when a file lands in a folder (used to refresh that folder's listing). */
  onFolderChanged?: (folderId: string) => void;

  constructor(
    private readonly transport: UploadTransport,
    opts: Partial<UploadManagerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  get busy(): boolean {
    return this.items.some(
      (i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'finalizing',
    );
  }

  add(parentId: string, picked: { file: File; relativeDir: string }[]): void {
    for (const { file, relativeDir } of picked) {
      const id = `u${this.nextId++}`;
      this.files.set(id, file);
      this.items.push({
        id,
        name: file.name,
        size: file.size,
        loaded: 0,
        status: 'queued',
        parentId,
        relativeDir,
      });
    }
    this.emit(true);
    this.pump();
  }

  cancel(id: string): void {
    const item = this.find(id);
    if (!item || item.status === 'done') return;
    this.controllers.get(id)?.abort();
    const session = this.sessions.get(id);
    if (session) void this.transport.abortUpload(session).catch(() => {});
    this.patch(id, { status: 'canceled' }, true);
  }

  cancelAll(): void {
    for (const i of this.items) if (i.status !== 'done') this.cancel(i.id);
  }

  retry(id: string): void {
    const item = this.find(id);
    if (!item || (item.status !== 'error' && item.status !== 'canceled')) return;
    this.patch(id, { status: 'queued', error: undefined }, true);
    this.pump();
  }

  clearFinished(): void {
    this.items = this.items.filter((i) => {
      const keep = i.status !== 'done' && i.status !== 'canceled';
      if (!keep) this.files.delete(i.id);
      return keep;
    });
    this.emit(true);
  }

  private find(id: string) {
    return this.items.find((i) => i.id === id);
  }

  private patch(id: string, patch: Partial<UploadItem>, immediate = false) {
    const item = this.find(id);
    if (!item) return;
    Object.assign(item, patch);
    this.emit(immediate);
  }

  private emit(immediate = false) {
    const flush = () => {
      this.emitPending = false;
      this.snapshot = this.items.map((i) => ({ ...i }));
      for (const l of this.listeners) l();
    };
    if (immediate) return flush();
    if (this.emitPending) return;
    this.emitPending = true;
    schedule(flush);
  }

  private pump() {
    while (this.active < this.opts.fileConcurrency) {
      const next = this.items.find((i) => i.status === 'queued');
      if (!next) return;
      this.active++;
      next.status = 'uploading';
      void this.run(next).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  /** Creates (or reuses) each folder along `relativeDir`, memoized per upload batch. */
  private ensurePath(parentId: string, relativeDir: string): Promise<string> {
    const parts = relativeDir.split('/').filter(Boolean);
    let chain = Promise.resolve(parentId);
    let key = parentId;
    for (const name of parts) {
      key = `${key}/${name}`;
      const k = key;
      let cached = this.folders.get(k);
      if (!cached) {
        const prev = chain;
        cached = prev.then((pid) => this.transport.ensureFolder(pid, name).then((f) => f.id));
        cached.catch(() => this.folders.delete(k));
        this.folders.set(k, cached);
      }
      chain = cached;
    }
    return chain;
  }

  private async withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        await waitForOnline(signal);
        return await fn();
      } catch (err) {
        if (signal.aborted || !isRetryable(err) || attempt >= this.opts.maxRetries) throw err;
        const backoff = this.opts.retryBaseMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
        await sleep(Math.min(backoff, 30_000), signal);
      }
    }
  }

  private async run(item: UploadItem): Promise<void> {
    const file = this.files.get(item.id);
    if (!file) return;
    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    const { signal } = controller;
    try {
      this.patch(item.id, { status: 'uploading', loaded: 0 }, true);
      const folderId = item.relativeDir
        ? await this.ensurePath(item.parentId, item.relativeDir)
        : item.parentId;
      const session = await this.withRetry(
        () =>
          this.transport.createUpload({
            parentId: folderId,
            name: file.name,
            size: file.size,
            ...(file.type ? { mimeType: file.type } : {}),
          }),
        signal,
      );
      this.sessions.set(item.id, session.id);

      const { chunkSize, totalChunks } = session;
      const have = new Set(session.receivedChunks);
      const pending = Array.from({ length: totalChunks }, (_, i) => i).filter((i) => !have.has(i));
      const inflight = new Map<number, number>();
      let doneBytes = [...have].reduce(
        (s, i) => s + Math.min(chunkSize, file.size - i * chunkSize),
        0,
      );
      const report = () => {
        let sum = doneBytes;
        for (const v of inflight.values()) sum += v;
        this.patch(item.id, { loaded: Math.min(sum, file.size) });
      };

      let node: FileNode | null = null;
      const worker = async () => {
        for (let idx = pending.shift(); idx !== undefined; idx = pending.shift()) {
          const index = idx;
          const start = index * chunkSize;
          const end = Math.min(file.size, start + chunkSize);
          const res = await this.withRetry(
            () =>
              this.transport.putChunk(
                session.id,
                index,
                file.slice(start, end),
                (loaded) => {
                  inflight.set(index, loaded);
                  report();
                },
                signal,
              ),
            signal,
          );
          inflight.delete(index);
          doneBytes += end - start;
          report();
          if (res.node) node = res.node;
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.max(1, Math.min(this.opts.chunkConcurrency, pending.length)) },
          worker,
        ),
      );

      if (!node) {
        // Another request finished the file (or finalizing is in progress): ask the server.
        this.patch(item.id, { status: 'finalizing' }, true);
        for (let i = 0; i < 30 && !node; i++) {
          const s = await this.transport.getUpload(session.id);
          if (s.node) node = s.node;
          else if (s.status === 'aborted' || s.status === 'expired')
            throw new Error('Upload was cancelled on the server');
          else await sleep(500, signal);
        }
        if (!node) throw new Error('The server is taking too long to finish this file');
      }
      const finished = node as FileNode;
      this.patch(item.id, { status: 'done', loaded: file.size, nodeId: finished.id }, true);
      this.files.delete(item.id);
      this.onFolderChanged?.(folderId);
    } catch (err) {
      if (signal.aborted || (err as Error).name === 'AbortError') {
        this.patch(item.id, { status: 'canceled' }, true);
      } else {
        this.patch(
          item.id,
          { status: 'error', error: err instanceof Error ? err.message : 'Upload failed' },
          true,
        );
      }
    } finally {
      this.controllers.delete(item.id);
    }
  }
}

/** Browser transport: JSON via fetch, chunks via XHR (the only API with upload progress). */
export const httpTransport: UploadTransport = {
  createUpload: (body) => api<UploadSession>('/uploads', { json: body }),
  getUpload: (id) => api<UploadSession>(`/uploads/${id}`),
  abortUpload: (id) => api(`/uploads/${id}`, { method: 'DELETE' }),
  ensureFolder: (parentId, name) =>
    api<{ id: string }>('/folders', { json: { parentId, name, reuseExisting: true } }),
  putChunk: (sessionId, index, data, onProgress, signal) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', apiUrl(`/uploads/${sessionId}/chunks/${index}`));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let body: { detail?: string; code?: string } & Partial<ChunkResult> = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as ChunkResult);
        else
          reject(
            new ApiError(
              xhr.status,
              (body.code ?? 'INTERNAL_ERROR') as never,
              body.detail ?? `Upload failed (${xhr.status})`,
            ),
          );
      };
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Connection lost'));
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', () => xhr.abort());
      xhr.send(data);
    }),
};
