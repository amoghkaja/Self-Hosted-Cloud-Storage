import { createReadStream } from 'node:fs';
import { connect } from 'node:net';

export interface Clamd {
  host: string;
  port: number;
}

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  /** The scanner refused it as too big for one stream. */
  | { status: 'too-large' };

/** clamd's default StreamMaxLength; bigger files aren't sent at all. */
export const MAX_SCAN_BYTES = 100 * 1024 * 1024;

/** One clamd command over TCP: sends `write`'s bytes and resolves with the reply line. */
function exchange(
  clamd: Clamd,
  timeoutMs: number,
  write: (socket: import('node:net').Socket) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(clamd.port, clamd.host);
    let reply = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(reply.replace(/\0/g, '').trim());
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('The virus scanner did not answer')));
    socket.on('error', finish);
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      // The reply is one null-terminated line; clamd may answer before the stream ends
      // (size limit), so don't wait for our own writes to finish.
      if (reply.includes('\0')) finish();
    });
    socket.on('end', () => finish());
    socket.on('connect', () => write(socket));
  });
}

/** The scanner's version and virus-list date, e.g. "ClamAV 1.4.2/27700/Thu Oct 1 09:00:00 2026". */
export function clamdVersion(clamd: Clamd): Promise<string> {
  return exchange(clamd, 5_000, (s) => s.write('zVERSION\0'));
}

/**
 * Streams a file to clamd (INSTREAM: length-prefixed chunks, then a zero length). The scanner
 * needs no access to the storage disks, so it can run anywhere.
 */
export async function scanFile(clamd: Clamd, file: string): Promise<ScanResult> {
  const reply = await exchange(clamd, 10 * 60_000, (socket) => {
    socket.write('zINSTREAM\0');
    const input = createReadStream(file, { highWaterMark: 64 * 1024 });
    input.on('data', (chunk) => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(chunk.length);
      socket.write(size);
      if (!socket.write(chunk)) {
        input.pause();
        socket.once('drain', () => input.resume());
      }
    });
    input.on('end', () => socket.write(Buffer.alloc(4)));
    input.on('error', (err) => socket.destroy(err));
    socket.on('close', () => input.destroy());
  });
  if (reply.endsWith('OK')) return { status: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { status: 'infected', signature: found[1]! };
  if (/size limit exceeded/i.test(reply)) return { status: 'too-large' };
  throw new Error(`Unexpected reply from the virus scanner: ${reply.slice(0, 200)}`);
}
