import type { ChunkResult, FileNode, UploadSession } from '@familycloud/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { memoryPendingStore, UploadManager, type UploadTransport } from './upload-manager';

const node = (id: string): FileNode => ({
  id,
  type: 'file',
  name: id,
  size: 0,
  mimeType: null,
  parentId: 'p',
  ownerId: 'o',
  thumb: 'none',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function fakeTransport(opts: { chunkSize?: number; received?: number[]; failFirst?: number } = {}) {
  const chunkSize = opts.chunkSize ?? 4;
  const put: number[] = [];
  let failures = opts.failFirst ?? 0;
  const folders: string[] = [];
  const t: UploadTransport = {
    createUpload: vi.fn(
      async (body): Promise<UploadSession> => ({
        id: `s-${body.name}`,
        name: body.name,
        size: body.size,
        chunkSize,
        totalChunks: Math.max(1, Math.ceil(body.size / chunkSize)),
        receivedChunks: opts.received ?? [],
        status: 'uploading',
        expiresAt: new Date().toISOString(),
        node: null,
      }),
    ),
    getUpload: vi.fn(),
    abortUpload: vi.fn(async () => {}),
    ensureFolder: vi.fn(async (parentId: string, name: string) => {
      folders.push(`${parentId}/${name}`);
      return { id: `${parentId}/${name}` };
    }),
    putChunk: vi.fn(
      async (
        _sessionId: string,
        index: number,
        data: Blob,
        onProgress: (n: number) => void,
      ): Promise<ChunkResult> => {
        if (failures > 0) {
          failures--;
          throw new ApiError(503, 'INTERNAL_ERROR', 'busy');
        }
        onProgress(data.size);
        put.push(index);
        // Never returns the node: the manager then asks getUpload, like a racing final chunk.
        return { receivedCount: put.length, totalChunks: 999, status: 'uploading', node: null };
      },
    ),
  };
  return { t, put, folders };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function waitIdle(m: UploadManager) {
  for (let i = 0; i < 200 && m.busy; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('UploadManager', () => {
  it('asks the server to save over the existing file only for files marked "replace"', async () => {
    const { t } = fakeTransport();
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('n'),
      status: 'completed',
    });
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('p', [
      { file: new File(['abcd'], 'report.docx'), relativeDir: '', replace: true },
      { file: new File(['efgh'], 'photo.jpg'), relativeDir: '' },
    ]);
    await waitIdle(m);
    const bodies = (t.createUpload as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(bodies.find((b) => b.name === 'report.docx')).toMatchObject({ onConflict: 'replace' });
    expect(bodies.find((b) => b.name === 'photo.jpg')).not.toHaveProperty('onConflict');
  });

  it('uploads every chunk, skips ones the server already has, and reports progress', async () => {
    const { t, put } = fakeTransport({ received: [1] });
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('n1'),
      status: 'completed',
    });
    const m = new UploadManager(t, { retryBaseMs: 1 });
    const file = new File(['0123456789ab'], 'a.bin'); // 12 bytes -> 3 chunks of 4
    m.add('p', [{ file, relativeDir: '' }]);
    await waitIdle(m);
    expect(put.sort()).toEqual([0, 2]);
    const [item] = m.getSnapshot();
    expect(item).toMatchObject({ status: 'done', loaded: 12, nodeId: 'n1' });
  });

  it('retries transient server errors with backoff', async () => {
    const { t, put } = fakeTransport({ failFirst: 2 });
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('n2'),
      status: 'completed',
    });
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('p', [{ file: new File(['abc'], 'b.bin'), relativeDir: '' }]);
    await waitIdle(m);
    expect(put).toEqual([0]);
    expect(t.putChunk).toHaveBeenCalledTimes(3);
    expect(m.getSnapshot()[0]!.status).toBe('done');
  });

  it('does not retry client errors and surfaces the message', async () => {
    const { t } = fakeTransport();
    (t.createUpload as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(507, 'QUOTA_EXCEEDED', 'Not enough storage left'),
    );
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('p', [{ file: new File(['abc'], 'c.bin'), relativeDir: '' }]);
    await waitIdle(m);
    expect(t.createUpload).toHaveBeenCalledTimes(1);
    expect(m.getSnapshot()[0]).toMatchObject({ status: 'error', error: 'Not enough storage left' });
  });

  it('creates each folder of a folder upload once, even for many files', async () => {
    const { t, folders } = fakeTransport();
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('x'),
      status: 'completed',
    });
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('root', [
      { file: new File(['1'], '1.jpg'), relativeDir: 'Trip/Day 1' },
      { file: new File(['2'], '2.jpg'), relativeDir: 'Trip/Day 1' },
      { file: new File(['3'], '3.jpg'), relativeDir: 'Trip/Day 2' },
    ]);
    await waitIdle(m);
    expect(folders.sort()).toEqual(['root/Trip', 'root/Trip/Day 1', 'root/Trip/Day 2']);
    expect(
      (t.createUpload as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].parentId).sort(),
    ).toEqual(['root/Trip/Day 1', 'root/Trip/Day 1', 'root/Trip/Day 2']);
  });

  it('retries creating a folder of a folder upload when the connection drops', async () => {
    const { t, folders } = fakeTransport();
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('x'),
      status: 'completed',
    });
    const ensure = vi.mocked(t.ensureFolder);
    const real = ensure.getMockImplementation()!;
    ensure.mockImplementationOnce(async () => {
      throw new ApiError(0, 'NETWORK_ERROR', "Can't reach the server. Check your connection.");
    });
    ensure.mockImplementation(real);
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('root', [
      { file: new File(['1'], '1.jpg'), relativeDir: 'Trip' },
      { file: new File(['2'], '2.jpg'), relativeDir: 'Trip' },
    ]);
    await waitIdle(m);
    expect(m.getSnapshot().map((i) => i.status)).toEqual(['done', 'done']);
    expect(folders).toEqual(['root/Trip']);
  });

  it('cancel aborts the server session and marks the item', async () => {
    const { t } = fakeTransport();
    (t.putChunk as ReturnType<typeof vi.fn>).mockImplementation(
      (_s: string, _i: number, _d: Blob, _p: unknown, signal: AbortSignal) =>
        new Promise((_res, rej) =>
          signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))),
        ),
    );
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('p', [{ file: new File(['abcdef'], 'd.bin'), relativeDir: '' }]);
    await settle();
    await settle();
    const id = m.getSnapshot()[0]!.id;
    m.cancel(id);
    await waitIdle(m);
    expect(t.abortUpload).toHaveBeenCalledWith('s-d.bin');
    expect(m.getSnapshot()[0]!.status).toBe('canceled');
  });

  it('cancelling while the session is being created sends nothing and releases it', async () => {
    const { t } = fakeTransport();
    let createDone!: () => void;
    const created = new Promise<void>((r) => (createDone = r));
    const create = vi.mocked(t.createUpload);
    const real = create.getMockImplementation()!;
    create.mockImplementation(async (body) => {
      await created;
      return real(body);
    });
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('p', [{ file: new File(['abcdef'], 'late.bin'), relativeDir: '' }]);
    await settle();
    m.cancel(m.getSnapshot()[0]!.id);
    createDone();
    await waitIdle(m);
    for (let i = 0; i < 5; i++) await settle();
    expect(t.putChunk).not.toHaveBeenCalled();
    expect(t.abortUpload).toHaveBeenCalledWith('s-late.bin');
    expect(m.getSnapshot()[0]!.status).toBe('canceled');
  });

  it('retrying a failed upload resumes the server session instead of starting over', async () => {
    const { t, put } = fakeTransport();
    const chunk = t.putChunk as ReturnType<typeof vi.fn>;
    const real = chunk.getMockImplementation()!;
    chunk.mockImplementationOnce(async () => {
      throw new ApiError(400, 'CHUNK_INVALID', 'Chunk rejected');
    });
    const get = t.getUpload as ReturnType<typeof vi.fn>;
    const m = new UploadManager(t, { retryBaseMs: 1, chunkConcurrency: 1 });
    m.add('p', [{ file: new File(['abcdefgh'], 'r.bin'), relativeDir: '' }]); // 2 chunks
    await waitIdle(m);
    expect(m.getSnapshot()[0]).toMatchObject({ status: 'error', error: 'Chunk rejected' });

    chunk.mockImplementation(real);
    // The server still has the session open, with chunk 1 already received.
    get.mockImplementation(async (id: string) =>
      put.length === 0
        ? { id, chunkSize: 4, totalChunks: 2, receivedChunks: [1], status: 'uploading', node: null }
        : { id, status: 'completed', node: node('r') },
    );
    m.retry(m.getSnapshot()[0]!.id);
    await waitIdle(m);
    expect(t.createUpload).toHaveBeenCalledTimes(1);
    expect(put).toEqual([0]);
    expect(m.getSnapshot()[0]).toMatchObject({ status: 'done', nodeId: 'r' });
  });

  it('stops sending a file’s other pieces once one of them fails', async () => {
    const { t, put } = fakeTransport();
    const chunk = vi.mocked(t.putChunk);
    const real = chunk.getMockImplementation()!;
    let slowAborted = false;
    chunk.mockImplementation(async (sessionId, index, data, onProgress, signal) => {
      if (index === 0) throw new ApiError(400, 'CHUNK_INVALID', 'Chunk rejected');
      if (index === 1) {
        // Still sending when chunk 0 fails.
        await new Promise<void>((resolve, reject) => {
          const done = setTimeout(resolve, 30);
          signal.addEventListener('abort', () => {
            clearTimeout(done);
            slowAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return real(sessionId, index, data, onProgress, signal);
    });
    const m = new UploadManager(t, { retryBaseMs: 1, chunkConcurrency: 2 });
    m.add('p', [{ file: new File(['abcdefghijklmnop'], 'four.bin'), relativeDir: '' }]); // 4 chunks
    await waitIdle(m);
    expect(m.getSnapshot()[0]).toMatchObject({ status: 'error', error: 'Chunk rejected' });
    await new Promise((r) => setTimeout(r, 80));
    // The failed upload sends nothing more in the background (a retry resumes it instead).
    expect(slowAborted).toBe(true);
    expect(put).toEqual([]);
  });

  it('keeps what was sent when the connection drops while checking where to carry on', async () => {
    const { t, put } = fakeTransport();
    const chunk = vi.mocked(t.putChunk);
    const real = chunk.getMockImplementation()!;
    chunk.mockImplementationOnce(async () => {
      throw new ApiError(400, 'CHUNK_INVALID', 'Chunk rejected');
    });
    const m = new UploadManager(t, { retryBaseMs: 1, chunkConcurrency: 1 });
    m.add('p', [{ file: new File(['abcdefgh'], 'big.mov'), relativeDir: '' }]); // 2 chunks
    await waitIdle(m);
    expect(m.getSnapshot()[0]!.status).toBe('error');

    chunk.mockImplementation(real);
    const get = vi.mocked(t.getUpload);
    get.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Connection lost'));
    get.mockImplementation(async (id: string) =>
      put.length === 0
        ? ({
            id,
            chunkSize: 4,
            totalChunks: 2,
            receivedChunks: [1],
            status: 'uploading',
            node: null,
          } as unknown as UploadSession)
        : ({ id, status: 'completed', node: node('big') } as unknown as UploadSession),
    );
    m.retry(m.getSnapshot()[0]!.id);
    await waitIdle(m);
    // Same session, only the missing piece: not a fresh upload from the start.
    expect(t.createUpload).toHaveBeenCalledTimes(1);
    expect(put).toEqual([0]);
    expect(m.getSnapshot()[0]).toMatchObject({ status: 'done', nodeId: 'big' });
  });

  it('closing the panel dismisses failures and releases their reserved space', async () => {
    const { t } = fakeTransport();
    (t.putChunk as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(400, 'CHUNK_INVALID', 'Chunk rejected'),
    );
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('p', [{ file: new File(['abc'], 'f.bin'), relativeDir: '' }]);
    await waitIdle(m);
    expect(m.getSnapshot()[0]!.status).toBe('error');
    m.clearFinished();
    expect(m.getSnapshot()).toEqual([]);
    expect(t.abortUpload).toHaveBeenCalledWith('s-f.bin');
  });

  it('refreshes the folder a folder upload creates its first folder in', async () => {
    const { t } = fakeTransport();
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('x'),
      status: 'completed',
    });
    const m = new UploadManager(t, { retryBaseMs: 1 });
    const changed: string[] = [];
    m.onFolderChanged = (id) => changed.push(id);
    m.add('root', [{ file: new File(['1'], '1.jpg'), relativeDir: 'Trip/Day 1' }]);
    await waitIdle(m);
    // "Trip" appears in the folder the user is looking at, not just "Day 1" deep inside.
    expect(changed).toContain('root');
    expect(changed).toContain('root/Trip/Day 1');
  });

  it('reset stops everything and forgets the list', async () => {
    const { t } = fakeTransport();
    (t.putChunk as ReturnType<typeof vi.fn>).mockImplementation(
      (_s: string, _i: number, _d: Blob, _p: unknown, signal: AbortSignal) =>
        new Promise((_res, rej) =>
          signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))),
        ),
    );
    const m = new UploadManager(t, { retryBaseMs: 1 });
    m.add('p', [{ file: new File(['abcdef'], 'g.bin'), relativeDir: '' }]);
    await settle();
    await settle();
    m.reset();
    await waitIdle(m);
    expect(m.getSnapshot()).toEqual([]);
    expect(m.busy).toBe(false);
  });

  it('keeps unchanged items identical between snapshots', async () => {
    const { t } = fakeTransport();
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('n'),
      status: 'completed',
    });
    const m = new UploadManager(t, { retryBaseMs: 1, fileConcurrency: 1 });
    m.add('p', [
      { file: new File(['a'], 'one.bin'), relativeDir: '' },
      { file: new File(['b'], 'two.bin'), relativeDir: '' },
    ]);
    const first = m.getSnapshot();
    await waitIdle(m);
    const done = m.getSnapshot();
    expect(done[0]).not.toBe(first[0]);
    m.add('p', [{ file: new File(['c'], 'three.bin'), relativeDir: '' }]);
    const next = m.getSnapshot();
    expect(next).toHaveLength(3);
    expect(next[0]).toBe(done[0]);
    expect(next[1]).toBe(done[1]);
    await waitIdle(m);
  });

  it('batches progress notifications instead of emitting per byte', async () => {
    const { t } = fakeTransport({ chunkSize: 1 });
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('n'),
      status: 'completed',
    });
    const m = new UploadManager(t, { retryBaseMs: 1 });
    const listener = vi.fn();
    m.subscribe(listener);
    m.add('p', [{ file: new File(['x'.repeat(40)], 'e.bin'), relativeDir: '' }]);
    await waitIdle(m);
    // 40 chunk completions + progress events, but far fewer notifications.
    expect(listener.mock.calls.length).toBeLessThan(40);
  });
});

describe('UploadManager: instant uploads and resuming', () => {
  it('adds a file the server already has without sending any bytes', async () => {
    const { t, put } = fakeTransport();
    t.instantUpload = vi.fn(async () => node('dup'));
    const m = new UploadManager(t, {
      retryBaseMs: 1,
      instantMinBytes: 1,
      hash: async () => 'h'.repeat(64),
    });
    m.add('p', [{ file: new File(['same bytes'], 'copy.jpg'), relativeDir: '' }]);
    await waitIdle(m);
    expect(t.createUpload).not.toHaveBeenCalled();
    expect(put).toEqual([]);
    expect(m.getSnapshot()[0]).toMatchObject({ status: 'done', instant: true, nodeId: 'dup' });
  });

  it('uploads normally when the server has no copy, or the checksum fails', async () => {
    const { t, put } = fakeTransport();
    t.instantUpload = vi.fn(async () => null);
    (t.getUpload as ReturnType<typeof vi.fn>).mockResolvedValue({
      node: node('n'),
      status: 'completed',
    });
    const m = new UploadManager(t, {
      retryBaseMs: 1,
      instantMinBytes: 1,
      hash: async (f) => (f.size > 4 ? 'a'.repeat(64) : Promise.reject(new Error('no wasm'))),
    });
    m.add('p', [
      { file: new File(['0123456789'], 'new.jpg'), relativeDir: '' },
      { file: new File(['ab'], 'tiny.txt'), relativeDir: '' },
    ]);
    await waitIdle(m);
    expect(t.instantUpload).toHaveBeenCalledTimes(1);
    expect(t.createUpload).toHaveBeenCalledTimes(2);
    expect(put.length).toBeGreaterThan(0);
    expect(m.getSnapshot().every((i) => i.status === 'done' && !i.instant)).toBe(true);
  });

  it('remembers unfinished uploads and resumes them with only the missing pieces', async () => {
    const pending = memoryPendingStore();
    const file = new File(['0123456789ab'], 'movie.mov', { lastModified: 42 });

    // First page load: the upload starts and the tab closes before it finishes.
    const first = fakeTransport();
    const m1 = new UploadManager(first.t, { retryBaseMs: 1, pending });
    (first.t.putChunk as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    m1.add('folder', [{ file, relativeDir: '' }]);
    await settle();
    await settle();
    expect(pending.list()).toMatchObject([
      { name: 'movie.mov', size: 12, lastModified: 42, folderId: 'folder' },
    ]);

    // Next page load: the server still has the session with chunk 0.
    const second = fakeTransport({ received: [0] });
    (second.t.getUpload as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
      id,
      name: 'movie.mov',
      size: 12,
      chunkSize: 4,
      totalChunks: 3,
      receivedChunks: [0],
      status: 'uploading',
      expiresAt: new Date().toISOString(),
      node: null,
    }));
    const m2 = new UploadManager(second.t, { retryBaseMs: 1, pending });
    const list = await m2.interrupted();
    expect(list).toHaveLength(1);
    // A different file with the same name isn't accepted.
    expect(m2.resume(list, [new File(['x'], 'movie.mov')])).toBe(0);
    (second.t.getUpload as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...(await second.t.getUpload('x')), id: list[0]!.sessionId })
      .mockResolvedValue({ node: node('movie'), status: 'completed' });
    expect(m2.resume(list, [file])).toBe(1);
    await waitIdle(m2);
    expect(second.t.createUpload).not.toHaveBeenCalled();
    expect(second.put.sort()).toEqual([1, 2]);
    expect(m2.getSnapshot()[0]).toMatchObject({ status: 'done', nodeId: 'movie' });
    expect(pending.list()).toEqual([]);
  });
});
