/**
 * The words of a search as a full-text query: every word must be in the file, each as the start
 * of a word ('tax':* & '2024':*), so results come as you type. Only letters and digits reach
 * to_tsquery, so nothing typed can change the query's syntax. Null when no word is long enough to
 * be worth looking for inside files (one letter matches nearly everything).
 */
export function wordQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  if (!words.some((w) => w.length >= 2)) return null;
  return words.map((w) => `'${w}':*`).join(' & ');
}

/** Snippets: a dozen or so words around the match, as plain text. */
export const HEADLINE = 'MaxWords=18, MinWords=8, MaxFragments=1, StartSel="", StopSel=""';
/** Snippets come from the start of a document; enough for the match in most, and quick. */
export const HEADLINE_CHARS = 100_000;
