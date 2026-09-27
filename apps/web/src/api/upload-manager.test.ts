import type { ChunkResult, FileNode, UploadSession } from '@familycloud/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { UploadManager, type UploadTransport } from './upload-manager';

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
