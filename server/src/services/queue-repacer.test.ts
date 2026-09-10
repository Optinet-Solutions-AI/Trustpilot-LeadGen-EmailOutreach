import { describe, test, expect } from 'vitest';
import { repaceQueue, type RepaceItem } from './queue-repacer.js';
import type { SendingSchedule } from './schedule-engine.js';

/**
 * The queue was built before follow-ups counted against the cap, so it holds
 * days like 2026-09-09 with 53 follow-ups and 09-10 with 64, against a real
 * ceiling of 30. The send-time gate would drip those out an hour at a time,
 * but the queue itself would still SAY 53 — and an operator planning from a
 * calendar that lies is the problem this whole exercise started with.
 *
 * Re-pacing rewrites the stored times so the plan matches what can happen.
 */

const schedule: SendingSchedule = {
  timezone: 'UTC',
  startHour: '09:00',
  endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6],
  dailyLimit: 10,
};

const FROM = new Date('2026-09-08T08:00:00Z'); // Tue, before the window opens

function items(n: number, at: string, kind: RepaceItem['kind'] = 'follow_up'): RepaceItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${kind}-${at}-${i}`,
    kind,
    at: new Date(at),
    schedule,
  }));
}

/** How many placements land on each day, in date order. */
function perDay(res: { to: Date }[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of res) {
    const k = r.to.toISOString().slice(0, 10);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

describe('repaceQueue', () => {
  test('a day within capacity is left alone', () => {
    const res = repaceQueue(items(20, '2026-09-09T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    expect(perDay(res)).toEqual([['2026-09-09', 20]]);
  });

  test('the real backlog: 53 on one day spills to 30 + 23', () => {
    const res = repaceQueue(items(53, '2026-09-09T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    expect(perDay(res)).toEqual([['2026-09-09', 30], ['2026-09-10', 23]]);
  });

  test('53 then 64 on consecutive days cascade without ever exceeding the cap', () => {
    const res = repaceQueue(
      [...items(53, '2026-09-09T10:00:00Z'), ...items(64, '2026-09-10T10:00:00Z')],
      { capacityPerDay: 30, from: FROM },
    );
    const days = perDay(res);
    expect(days.every(([, n]) => n <= 30)).toBe(true);
    expect(days.reduce((s, [, n]) => s + n, 0)).toBe(117);
    // 117 over 30/day = four full days and a remainder.
    expect(days).toEqual([
      ['2026-09-09', 30], ['2026-09-10', 30], ['2026-09-11', 30], ['2026-09-12', 27],
    ]);
  });

  test('nothing is ever moved earlier than it was scheduled', () => {
    const res = repaceQueue(items(53, '2026-09-09T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    for (const r of res) expect(r.to.getTime()).toBeGreaterThanOrEqual(new Date('2026-09-09T00:00:00Z').getTime());
  });

  test('nothing is scheduled into the past', () => {
    // A backlog whose times have already gone by must land from now on, not
    // stay in the past where the scheduler would fire it all at once.
    const res = repaceQueue(items(40, '2026-09-01T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    for (const r of res) expect(r.to.getTime()).toBeGreaterThanOrEqual(FROM.getTime());
    expect(perDay(res)).toEqual([['2026-09-08', 30], ['2026-09-09', 10]]);
  });

  test('every placement lands inside the sending window', () => {
    const res = repaceQueue(items(53, '2026-09-09T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    for (const r of res) {
      const h = r.to.getUTCHours();
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(17);
    }
  });

  test('days the campaign does not send on are skipped', () => {
    const weekdays = { ...schedule, days: [1, 2, 3, 4, 5] };
    const res = repaceQueue(
      Array.from({ length: 40 }, (_, i) => ({
        id: `x${i}`, kind: 'follow_up' as const,
        at: new Date('2026-09-11T10:00:00Z'), schedule: weekdays,
      })),
      { capacityPerDay: 30, from: FROM },
    );
    // Fri 11th takes 30; the 12th is Saturday, so the rest go to Monday 14th.
    expect(perDay(res)).toEqual([['2026-09-11', 30], ['2026-09-14', 10]]);
  });

  test('earlier items keep their place ahead of later ones', () => {
    const res = repaceQueue(
      [...items(30, '2026-09-10T10:00:00Z', 'first_touch'), ...items(5, '2026-09-09T10:00:00Z')],
      { capacityPerDay: 30, from: FROM },
    );
    // The 09-09 follow-ups were due first, so they keep the earlier day.
    const early = res.filter((r) => r.to.toISOString().slice(0, 10) === '2026-09-09');
    expect(early).toHaveLength(5);
    expect(early.every((r) => r.kind === 'follow_up')).toBe(true);
  });

  test('reports only the rows it actually moved', () => {
    const res = repaceQueue(items(53, '2026-09-09T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    expect(res).toHaveLength(53);
    const moved = res.filter((r) => r.to.getTime() !== r.from.getTime());
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThanOrEqual(53);
  });

  test('an empty queue produces no writes', () => {
    expect(repaceQueue([], { capacityPerDay: 30, from: FROM })).toEqual([]);
  });

  test('a capacity of zero would strand everything, so it is refused', () => {
    expect(() => repaceQueue(items(5, '2026-09-09T10:00:00Z'), { capacityPerDay: 0, from: FROM }))
      .toThrow(/capacityPerDay/);
  });

  test('placements within a day are spread, not stacked on one minute', () => {
    const res = repaceQueue(items(30, '2026-09-09T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    const times = new Set(res.map((r) => r.to.toISOString()));
    // A burst of identical timestamps is what the old follow-up loop produced.
    expect(times.size).toBeGreaterThan(20);
  });
});

describe('regression: timezones behind UTC with sparse sending days', () => {
  test('a New York campaign sending one day a week still advances', () => {
    // This combination hung the placer: building UTC midnight from the day key
    // lands on the PREVIOUS local day in a negative-offset zone, so a full day
    // could be revisited forever. Real data — two campaigns look like this.
    const ny: SendingSchedule = {
      timezone: 'America/New_York',
      startHour: '09:00', endHour: '17:00',
      days: [1], // Mondays only
      dailyLimit: 10,
    };
    const res = repaceQueue(
      Array.from({ length: 70 }, (_, i) => ({
        id: `ny${i}`, kind: 'follow_up' as const,
        at: new Date('2026-09-14T13:00:00Z'), schedule: ny,
      })),
      { capacityPerDay: 30, from: new Date('2026-09-08T08:00:00Z') },
    );
    expect(res).toHaveLength(70);
    const days = perDay(res);
    expect(days.every(([, n]) => n <= 30)).toBe(true);
    // Mondays only, so three consecutive weeks.
    expect(days.map(([d]) => d)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
  });

  test('mixed timezones in one queue all place without stalling', () => {
    const mk = (tz: string, days: number[]): SendingSchedule => ({
      timezone: tz, startHour: '09:00', endHour: '17:00', days, dailyLimit: 10,
    });
    const mixed: RepaceItem[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, kind: 'follow_up' as const, at: new Date('2026-09-09T10:00:00Z'), schedule: mk('America/New_York', [1]) })),
      ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, kind: 'follow_up' as const, at: new Date('2026-09-09T10:00:00Z'), schedule: mk('Australia/Sydney', [0,1,2,3,4,5,6]) })),
      ...Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, kind: 'first_touch' as const, at: new Date('2026-09-09T10:00:00Z'), schedule: mk('Europe/Athens', [3]) })),
    ];
    const res = repaceQueue(mixed, { capacityPerDay: 30, from: new Date('2026-09-08T08:00:00Z') });
    expect(res).toHaveLength(120);
  });
});

describe('days that have already sent something', () => {
  test('placements leave room for what already went out that day', () => {
    // Real failure: re-pacing on 2026-09-10 filled the day to 30 while 5 had
    // already been sent that morning, leaving the day at 31. The counter has
    // to start from what the day has already spent, not from zero.
    const res = repaceQueue(items(40, '2026-09-09T10:00:00Z'), {
      capacityPerDay: 30,
      from: FROM,
      alreadySent: { '2026-09-09': 5 },
    });
    expect(perDay(res)).toEqual([['2026-09-09', 25], ['2026-09-10', 15]]);
  });

  test('a day already at capacity takes nothing more', () => {
    const res = repaceQueue(items(10, '2026-09-09T10:00:00Z'), {
      capacityPerDay: 30,
      from: FROM,
      alreadySent: { '2026-09-09': 30 },
    });
    expect(perDay(res)).toEqual([['2026-09-10', 10]]);
  });

  test('a day already OVER capacity still takes nothing more', () => {
    const res = repaceQueue(items(5, '2026-09-09T10:00:00Z'), {
      capacityPerDay: 30,
      from: FROM,
      alreadySent: { '2026-09-09': 43 },
    });
    expect(perDay(res)).toEqual([['2026-09-10', 5]]);
  });

  test('omitting alreadySent behaves as before', () => {
    const res = repaceQueue(items(40, '2026-09-09T10:00:00Z'), { capacityPerDay: 30, from: FROM });
    expect(perDay(res)).toEqual([['2026-09-09', 30], ['2026-09-10', 10]]);
  });
});
