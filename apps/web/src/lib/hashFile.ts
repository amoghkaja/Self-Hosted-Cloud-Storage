import { createSHA256 } from 'hash-wasm';

const SLICE = 8 * 1024 * 1024;

/**
 * SHA-256 of a file, read in 8 MB slices so even multi-GB videos never sit in memory at once.
 * Yields between slices, so the page stays responsive; honours `signal`.
 */
export async function hashFile(
  file: Blob,
  signal: AbortSignal,
  onProgress?: (hashedBytes: number) => void,
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += SLICE) {
    signal.throwIfAborted();
    const chunk = new Uint8Array(await file.slice(offset, offset + SLICE).arrayBuffer());
    hasher.update(chunk);
    onProgress?.(Math.min(offset + SLICE, file.size));
  }
  return hasher.digest('hex');
}
