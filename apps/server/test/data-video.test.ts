import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, nodes } from '../src/db/schema';
import { readMediaInfo } from '../src/jobs/media-info';
import { generateThumbnail } from '../src/jobs/thumbnail';
import { makeVideoStream } from '../src/jobs/video';
import { type Client, createTestEnv, setupAdmin, type TestEnv, uploadFile } from './helpers';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let env: TestEnv;
let c: Client;
let root: string;
const dir = mkdtempSync(path.join(tmpdir(), 'fc-video-'));

/** A 2-second test clip made by ffmpeg, with the given codec and height. */
function clip(name: string, args: string[]) {
  const out = path.join(dir, name);
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=1920x1080:rate=25',
    ...args,
    '-y',
    out,
  ]);
  return readFileSync(out);
}

async function upload(name: string, data: Buffer, mimeType: string) {
  const node = (await uploadFile(c, root, name, data, { mimeType })).final!.body.node;
  const [row] = await env.ctx.db
    .select({ blobId: nodes.blobId })
    .from(nodes)
    .where(eq(nodes.id, node.id));
  return { node, blobId: row!.blobId! };
}

const status = async (blobId: string) =>
  (await env.ctx.db.select().from(blobs).where(eq(blobs.id, blobId)))[0]!.streamStatus;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await setupAdmin(env);
  c = a.client;
  root = a.me.rootNodeId;
});
afterAll(async () => {
  await env.close();
});

describe.skipIf(!hasFfmpeg)('video streaming copies', () => {
  it('makes a 720p H.264 copy of a large or unusual video and streams it', async () => {
    const data = clip('big.mkv', ['-c:v', 'mpeg4', '-q:v', '2']);
    const { node, blobId } = await upload('holiday.mkv', data, 'video/x-matroska');
    expect(await status(blobId)).toBe('pending');
    expect(env.jobs.take('video-stream')).toHaveLength(1);

    await makeVideoStream(env.ctx, blobId);
    expect(await status(blobId)).toBe('ready');

    const res = await c.get(`/nodes/${node.id}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    const copy = Buffer.from(res.raw.rawPayload);
    expect(copy.length).toBeGreaterThan(0);
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-'], {
        input: copy,
      }).toString(),
    );
    const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    expect(v).toMatchObject({ codec_name: 'h264', height: 720 });

    // Seeking works on the copy.
    const part = await c.req('GET', `/nodes/${node.id}/stream`, {
      headers: { range: 'bytes=0-99' },
    });
    expect(part.status).toBe(206);

    // The original is still one request away.
    const original = await c.get(`/nodes/${node.id}/content`);
    expect(Buffer.from(original.raw.rawPayload).equals(data)).toBe(true);
  });

  it('streams a small H.264 MP4 as it is', async () => {
    const data = clip('small.mp4', [
      '-vf',
      'scale=-2:480',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-b:v',
      '800k',
      '-movflags',
      '+faststart',
    ]);
    const { node, blobId } = await upload('phone.mp4', data, 'video/mp4');
    await makeVideoStream(env.ctx, blobId);
    expect(await status(blobId)).toBe('original');
    const res = await c.get(`/nodes/${node.id}/stream`);
    expect(Buffer.from(res.raw.rawPayload).equals(data)).toBe(true);
  });

  it('marks unreadable videos as failed and still serves the original', async () => {
    const { node, blobId } = await upload(
      'broken.mp4',
      Buffer.from('not a video at all'),
      'video/mp4',
    );
    await makeVideoStream(env.ctx, blobId);
    expect(await status(blobId)).toBe('failed');
    expect((await c.get(`/nodes/${node.id}/stream`)).status).toBe(200);
  });

  it('never fetches the addresses in a streaming manifest dressed up as a video', async () => {
    const fetched: string[] = [];
    const server = createServer((req, res) => {
      fetched.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // A DASH manifest: ffmpeg recognises it by its contents, whatever the file is called.
      const manifest = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
     type="static" mediaPresentationDuration="PT10S" minBufferTime="PT1S">
  <BaseURL>http://127.0.0.1:${port}/</BaseURL>
  <Period><AdaptationSet mimeType="video/mp4">
    <Representation id="1" bandwidth="1000" width="64" height="64" codecs="avc1.42c01e">
      <BaseURL>internal.mp4</BaseURL>
    </Representation>
  </AdaptationSet></Period>
</MPD>
`;
      const { blobId } = await upload('trap.mp4', Buffer.from(manifest), 'video/mp4');
      await makeVideoStream(env.ctx, blobId);
      await generateThumbnail(env.ctx, blobId);
      await readMediaInfo(env.ctx, blobId);
      expect(fetched).toEqual([]);
      const [row] = await env.ctx.db.select().from(blobs).where(eq(blobs.id, blobId));
      expect(row).toMatchObject({ streamStatus: 'failed', thumbStatus: 'failed' });
    } finally {
      server.close();
    }
  });
});
