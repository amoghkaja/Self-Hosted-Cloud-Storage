const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Human-readable byte size using 1024-based units (the convention most file managers use).
 * formatBytes(1536) === '1.5 KB'
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 ? Math.round(value) : Number(value.toFixed(decimals));
  return `${rounded} ${UNITS[unit]}`;
}

/** Percentage (0-100, clamped) of `used` against `total`; 0 when total is 0 or unknown. */
export function percent(used: number, total: number | null | undefined): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}
