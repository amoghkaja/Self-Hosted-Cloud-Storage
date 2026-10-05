import type { AlbumPhoto } from '@familycloud/shared';

type Dated = Pick<AlbumPhoto, 'takenAt' | 'createdAt'>;

const WEEKDAY_DAY_MONTH = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const FULL_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const TAKEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The calendar day a photo belongs to: the camera's day, else the day it was uploaded (UTC, the
 * same clock the server sorts undated photos by, so a day's photos stay together).
 */
export function photoDay(p: Dated): string {
  return (p.takenAt ?? p.createdAt).slice(0, 10);
}

/** Splits photos (already in album order) into runs by day. */
export function groupByDay<T extends Dated>(items: T[]): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = photoDay(item);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

const noon = (day: string) => new Date(`${day}T12:00:00`);

/** "Day 2 · Thu, 13 Aug" during the trip; the full date for photos from before or after it. */
export function dayLabel(day: string, startDate: string, endDate: string | null): string {
  const end = endDate ?? startDate;
  if (day < startDate || day > end) return FULL_DAY.format(noon(day));
  const n = Math.round((noon(day).getTime() - noon(startDate).getTime()) / 86_400_000) + 1;
  const date = WEEKDAY_DAY_MONTH.format(noon(day));
  return startDate === end ? date : `Day ${n} · ${date}`;
}

/** The camera's clock as written, not shifted into the viewer's time zone. */
export function formatTaken(takenAt: string): string {
  return TAKEN.format(new Date(takenAt));
}

export function mapUrl({ latitude, longitude }: { latitude: number; longitude: number }) {
  const lat = latitude.toFixed(5);
  const lon = longitude.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
}
