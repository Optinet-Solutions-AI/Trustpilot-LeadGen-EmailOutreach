import { describe, test, expect } from 'vitest';
import { assignScheduledTimes, type SendingSchedule } from './schedule-engine.js';

/**
 * `dailyLimit` is PER SENDING ACCOUNT, so a day's capacity is
 * dailyLimit x senderCount. These tests exist because this is send volume:
 * getting it wrong either stalls a campaign for weeks or burns a warming
 * domain, and neither is visible from the UI until mail is already out.
 */

const base: SendingSchedule = {
  timezone: 'UTC',
  startHour: '09:00',
  endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6], // every day, so day-of-week never confuses a count
  dailyLimit: 10,
};

/** How many of `times` land on each UTC calendar day, in date order. */
function perDay(times: Date[]): number[] {
  const buckets = new Map<string, number>();
  for (const t of times) {
    const key = t.toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.keys()].sort().map((k) => buckets.get(k)!);
}

// Fixed start: 08:00 UTC, before the 09:00 window opens, so day 1 is a full day.
const FROM = new Date('2026-09-07T08:00:00Z');

describe('dailyLimit is per account', () => {
  test('one account sends dailyLimit per day', () => {
    const times = assignScheduledTimes(30, base, FROM, 1);
    expect(perDay(times)).toEqual([10, 10, 10]);
  });

  test('three accounts send 3x dailyLimit per day', () => {
    // The operator's case: 10 each across three mailboxes = 30/day.
    const times = assignScheduledTimes(30, base, FROM, 3);
    expect(perDay(times)).toEqual([30]);
  });

  test('117 leads at 10/account across 3 accounts takes 4 days', () => {
    const times = assignScheduledTimes(117, base, FROM, 3);
    expect(perDay(times)).toEqual([30, 30, 30, 27]);
  });

  test('omitting senderCount keeps the old single-account behaviour', () => {
    // Guards every caller that has not been taught about the pool yet.
    expect(perDay(assignScheduledTimes(25, base, FROM))).toEqual(
      perDay(assignScheduledTimes(25, base, FROM, 1)),
    );
  });

  test('a bigger pool finishes a fixed list sooner', () => {
    const one = assignScheduledTimes(60, base, FROM, 1);
    const six = assignScheduledTimes(60, base, FROM, 6);
    expect(perDay(one).length).toBeGreaterThan(perDay(six).length);
    expect(one).toHaveLength(60);
    expect(six).toHaveLength(60);
  });

  test('a nonsense sender count degrades to one account, never to zero capacity', () => {
    // 0 or a fraction must not produce an empty plan or an infinite loop.
    expect(assignScheduledTimes(10, base, FROM, 0)).toHaveLength(10);
    expect(assignScheduledTimes(10, base, FROM, 0.4)).toHaveLength(10);
    expect(assignScheduledTimes(10, base, FROM, -3)).toHaveLength(10);
  });

  test('every send still lands inside the configured window', () => {
    for (const t of assignScheduledTimes(90, base, FROM, 3)) {
      const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
      expect(minutes).toBeGreaterThanOrEqual(9 * 60);
      expect(minutes).toBeLessThanOrEqual(17 * 60);
    }
  });

  test('a larger pool never breaks the day-of-week restriction', () => {
    // Weekdays only; nothing may land on Sat (6) or Sun (0).
    const weekdays: SendingSchedule = { ...base, days: [1, 2, 3, 4, 5] };
    for (const t of assignScheduledTimes(200, weekdays, FROM, 3)) {
      expect([1, 2, 3, 4, 5]).toContain(t.getUTCDay());
    }
  });

  test('the plan is chronological', () => {
    const times = assignScheduledTimes(90, base, FROM, 3);
    for (let i = 1; i < times.length; i++) {
      expect(times[i].getTime()).toBeGreaterThanOrEqual(times[i - 1].getTime());
    }
  });
});
