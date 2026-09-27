import { describe, expect, it } from 'vitest';
import {
  CreateFolderBody,
  fileKind,
  formatBytes,
  guessMimeType,
  nameProblem,
  normalizeName,
  splitExtension,
  withCopySuffix,
  ZipQuery,
} from '../src/all';

describe('formatBytes', () => {
  it('formats with 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('names', () => {
  it('rejects separators, control chars and dot names', () => {
    expect(nameProblem('a/b')).toMatch(/cannot contain/);
    expect(nameProblem('a\\b')).toMatch(/cannot contain/);
    expect(nameProblem('a\u0000b')).toMatch(/cannot contain/);
    expect(nameProblem('..')).toMatch(/cannot be/);
    expect(nameProblem('')).toMatch(/empty/);
    expect(nameProblem('ok name.txt')).toBeNull();
    // Right-to-left override would display "invoice\u202efdp.exe" as "invoiceexe.pdf".
    expect(nameProblem('invoice\u202efdp.exe')).toMatch(/cannot contain/);
  });

  it('normalizes to NFC so macOS names compare equal', () => {
    const nfd = 'Café.txt';
    expect(normalizeName(`  ${nfd} `)).toBe('Café.txt');
  });

  it('splits extensions and builds copy suffixes', () => {
    expect(splitExtension('a.tar.gz')).toEqual(['a.tar', '.gz']);
    expect(splitExtension('.bashrc')).toEqual(['.bashrc', '']);
    expect(withCopySuffix('report.pdf', 2)).toBe('report (2).pdf');
    expect(withCopySuffix('notes', 1, 'restored')).toBe('notes (restored)');
    expect(withCopySuffix('x'.repeat(300), 3).length).toBeLessThanOrEqual(255);
  });

  it('validates names through the zod schema', () => {
    expect(
      CreateFolderBody.safeParse({ parentId: crypto.randomUUID(), name: '../etc' }).success,
    ).toBe(false);
    const ok = CreateFolderBody.parse({ parentId: crypto.randomUUID(), name: '  Photos ' });
    expect(ok.name).toBe('Photos');
  });
});

describe('mime', () => {
  it('prefers a specific client type and falls back to the extension', () => {
    expect(guessMimeType('IMG_1.HEIC', '')).toBe('image/heic');
    expect(guessMimeType('a.bin', 'application/octet-stream')).toBe('application/octet-stream');
    expect(guessMimeType('movie.mp4', 'video/mp4')).toBe('video/mp4');
    expect(guessMimeType('script.py', null)).toBe('text/plain');
  });

  it('classifies kinds', () => {
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind('application/pdf')).toBe('pdf');
    expect(fileKind('text/plain', 'main.ts')).toBe('code');
    expect(fileKind(null, 'x.unknown')).toBe('other');
  });
});

describe('ZipQuery', () => {
  it('parses comma-separated ids', () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(ZipQuery.parse({ ids: `${a},${b}` }).ids).toEqual([a, b]);
    expect(ZipQuery.safeParse({ ids: 'nope' }).success).toBe(false);
  });
});
