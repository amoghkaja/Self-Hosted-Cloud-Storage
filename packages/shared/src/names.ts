import { NAME_MAX_LENGTH } from './constants';

// Control characters, path separators and NUL are never valid in a node name, nor are
// bidirectional-override characters, which can disguise "photo<RLO>gpj.exe" as "photoexe.jpg".
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const FORBIDDEN = /[/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/** Normalizes a user-supplied name (NFC so macOS NFD names compare equal, trimmed). */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim();
}

/** Returns a human-readable problem with the name, or null when it is valid. Expects a normalized name. */
export function nameProblem(name: string): string | null {
  if (name.length === 0) return 'Name cannot be empty';
  if (name.length > NAME_MAX_LENGTH) return `Name must be at most ${NAME_MAX_LENGTH} characters`;
  if (name === '.' || name === '..') return 'Name cannot be "." or ".."';
  if (FORBIDDEN.test(name)) return 'Name cannot contain / or \\ or control characters';
  return null;
}

/** Splits "photo.final.jpg" into ["photo.final", ".jpg"]; dotfiles and extension-less names keep an empty ext. */
export function splitExtension(name: string): [base: string, ext: string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/** "report.pdf", 2 -> "report (2).pdf". Keeps the result within NAME_MAX_LENGTH. */
export function withCopySuffix(name: string, n: number, label?: string): string {
  const [base, ext] = splitExtension(name);
  const suffix = label ? ` (${label}${n > 1 ? ` ${n}` : ''})` : ` (${n})`;
  const room = NAME_MAX_LENGTH - suffix.length - ext.length;
  return `${base.slice(0, Math.max(1, room))}${suffix}${ext}`;
}
