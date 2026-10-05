import { describe, expect, it } from 'vitest';
import { dayLabel, groupByDay, photoDay } from './days';

const at = (takenAt: string | null, createdAt = '2026-09-01T10:00:00.000Z') => ({
  takenAt,
  createdAt,
});

describe('album days', () => {
  it('puts a photo on the camera’s day, else the day it was uploaded', () => {
    expect(photoDay(at('2026-08-12T23:59:00'))).toBe('2026-08-12');
    expect(photoDay(at(null, '2026-09-01T10:00:00.000Z'))).toBe('2026-09-01');
  });

  it('groups consecutive photos of the same day', () => {
    const items = [
      at('2026-08-12T09:00:00'),
      at('2026-08-12T18:00:00'),
      at('2026-08-13T08:00:00'),
      at(null),
    ];
    expect(groupByDay(items).map((g) => [g.day, g.items.length])).toEqual([
      ['2026-08-12', 2],
      ['2026-08-13', 1],
      ['2026-09-01', 1],
    ]);
  });

  it('numbers the days of a trip and dates the rest in full', () => {
    expect(dayLabel('2026-08-12', '2026-08-12', '2026-08-14')).toMatch(/^Day 1 · /);
    expect(dayLabel('2026-08-14', '2026-08-12', '2026-08-14')).toMatch(/^Day 3 · /);
    expect(dayLabel('2026-08-12', '2026-08-12', null)).not.toMatch(/Day/);
    expect(dayLabel('2026-09-01', '2026-08-12', '2026-08-14')).toMatch(/2026/);
  });
});
