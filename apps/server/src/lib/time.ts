/**
 * Normalizes a timestamp from either Drizzle (Date) or a raw query (Postgres text such as
 * "2026-09-26 09:14:23.123456+00") into an ISO-8601 UTC string with millisecond precision.
 */
export function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  let s = value.trim().replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  if (/[+-]\d\d$/.test(s)) s += ':00';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable timestamp: ${value}`);
  return d.toISOString();
}

export function toIsoOrNull(value: Date | string | null | undefined): string | null {
  return value == null ? null : toIso(value);
}

export const DAY_MS = 24 * 60 * 60 * 1000;
