import { describe, test, expect } from 'vitest';
import { planNextStepAt, type DayLoad } from './next-step-planner.js';
import type { SendingSchedule } from './schedule-engine.js';

/**
 * Follow-ups were scheduled at a flat `now + delay_days`, with no idea what
 * else was already booked. A batch sent at 20:00 therefore all came due at
 * 20:00 three days later — 27 of them stacked on one hour, on a day that
 * already held 30. Re-pacing fixed the queue once; this stops it re-bunching
 * in the first place.
 *
 * Same rules the re-pacer follows: inside the window, on an allowed day,
 * never over capacity, never in the past.
 */

const schedule: SendingSchedule = {
  timezone: 'UTC',
  startHour: '09:00',
  endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6],
  dailyLimit: 10,
};

const CAP = 30;
const NOW = new Date('2026-09-10T12:00:00Z');
/** now + 3 days, the flat date the old code used. */
const IDEAL = new Date('2026-09-13T12:00:00Z');

const day = (d: Date) => d.toISOString().slice(0, 10);

describe('planNextStepAt', () => {
  test('an empty day gets the ideal date', () => {
    const load: DayLoad = new Map();
    const at = planNextStepAt({ load, schedule, earliest: IDEAL, capacityPerDay: CAP, now: NOW });
    expect(day(at)).toBe('2026-09-13');
  });

  test('a full day pushes to the next one', () => {
    const load: DayLoad = new Map([['2026-09-13', 30]]);
    const at = planNextStepAt({ load, schedule, earliest: IDEAL, capacityPerDay: CAP, now: NOW });
    expect(day(at)).toBe('2026-09-14');
  });

  test('consecutive full days are skipped until there is room', () => {
    const load: DayLoad = new Map([
      ['2026-09-13', 30], ['2026-09-14', 30], ['2026-09-15', 29],
    ]);
    const at = planNextStepAt({ load, schedule, earliest: IDEAL, capacityPerDay: CAP, now: NOW });
    expect(day(at)).toBe('2026-09-15');
  });

  test('booking increments the load so the next call sees it', () => {
    // This is what stops a single tick stacking a whole batch on one day.
    const load: DayLoad = new Map([['2026-09-13', 29]]);
    const first = planNextStepAt({ load, schedule, earliest: IDEAL, capacityPerDay: CAP, now: NOW });
    const second = planNextStepAt({ load, schedule, earliest: IDEAL, capacityPerDay: CAP, now: NOW });
    expect(day(first)).toBe('2026-09-13');
    expect(day(second)).toBe('2026-09-14');
    expect(load.get('2026-09-13')).toBe(30);
  });

  test('a whole batch spreads instead of stacking on one hour', () => {
    // The exact failure: 27 follow-ups all landing at 20:00 on one day.
    const load: DayLoad = new Map();
    const placed = Array.from({ length: 70 }, () =>
      planNextStepAt({ load, schedule, earliest: IDEAL, capacityPerDay: CAP, now: NOW }));
    const perDay = new Map<string, number>();
    for (const p of placed) perDay.set(day(p), (perDay.get(day(p)) ?? 0) + 1);
    expect([...perDay.values()].every((n) => n <= CAP)).toBe(true);
    expect([...perDay.entries()].sort()).toEqual([
      ['2026-09-13', 30], ['2026-09-14', 30], ['2026-09-15', 10],
    ]);
    // And within a day they are spread across the window, not stacked.
    const sameDay = placed.filter((p) => day(p) === '2026-09-13');
    expect(new Set(sameDay.map((p) => p.toISOString())).size).toBeGreaterThan(20);
  });

  test('placements land inside the sending window', () => {
    const load: DayLoad = new Map();
    for (let i = 0; i < 40; i++) {
      const at = planNextStepAt({ load, schedule, earliest: IDEAL, capacityPerDay: CAP, now: NOW });
      expect(at.getUTCHours()).toBeGreaterThanOrEqual(9);
      expect(at.getUTCHours()).toBeLessThan(17);
    }
  });

  test('days the campaign does not send on are skipped', () => {
    const weekdays = { ...schedule, days: [1, 2, 3, 4, 5] };
    // 2026-09-12 is a Saturday.
    const at = planNextStepAt({
      load: new Map(), schedule: weekdays,
      earliest: new Date('2026-09-12T12:00:00Z'), capacityPerDay: CAP, now: NOW,
    });
    expect(day(at)).toBe('2026-09-14');
  });

  test('an ideal date in the past is pulled forward to now, not backdated', () => {
    const at = planNextStepAt({
      load: new Map(), schedule,
      earliest: new Date('2026-09-01T12:00:00Z'), capacityPerDay: CAP, now: NOW,
    });
    expect(at.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    expect(day(at)).toBe('2026-09-10');
  });

  test('a campaign timezone is honoured, not UTC', () => {
    const sydney = { ...schedule, timezone: 'Australia/Sydney' };
    const at = planNextStepAt({
      load: new Map(), schedule: sydney, earliest: IDEAL, capacityPerDay: CAP, now: NOW,
    });
    // 09:00-17:00 Sydney on the 13th is 23:00 UTC on the 12th -> 07:00 UTC 13th.
    const hourUtc = at.getUTCHours();
    expect(hourUtc >= 23 || hourUtc < 7).toBe(true);
  });
});
