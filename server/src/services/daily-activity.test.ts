import { describe, test, expect } from 'vitest';
import { summariseDailyActivity } from './daily-activity.js';

/**
 * The Daily Activity chart counted ROWS, not SENDS.
 *
 * campaign_leads carries one `sent_at` per lead-campaign pair, and every later
 * step in the sequence overwrites it. So a first email sent on 3 September
 * vanished from the 3rd the moment its follow-up went out on the 9th — and was
 * counted again on the 9th. Measured 2026-09-16 over 24 Aug - 16 Sep: 483
 * emails really went out, the chart showed 310, and 2, 3, 4, 6 and 8 September
 * each read zero on days that really sent 21, 30, 30, 30 and 27.
 *
 * The operator's conclusion was reasonable and wrong — that sending had
 * stalled. It had not. Counting one event per actual send is the whole fix.
 */

const RANGE = { start: '2026-09-01', end: '2026-09-05' };

describe('summariseDailyActivity', () => {
  test('counts every send, including two for the same lead on different days', () => {
    // The exact shape of the bug: one lead, first email on the 1st, follow-up
    // on the 4th. Both are real sends and both must be counted.
    const days = summariseDailyActivity({
      sends: ['2026-09-01T12:05:32Z', '2026-09-04T17:22:33Z'],
      replies: [],
      ...RANGE,
    });
    expect(days.days.map((d) => [d.date, d.sent])).toEqual([
      ['2026-09-01', 1], ['2026-09-02', 0], ['2026-09-03', 0],
      ['2026-09-04', 1], ['2026-09-05', 0],
    ]);
    expect(days.totals.sent).toBe(2);
  });

  test('several sends on one day add up', () => {
    const days = summariseDailyActivity({
      sends: ['2026-09-03T07:00:00Z', '2026-09-03T09:30:00Z', '2026-09-03T23:59:59Z'],
      replies: [],
      ...RANGE,
    });
    expect(days.days.find((d) => d.date === '2026-09-03')?.sent).toBe(3);
  });

  test('quiet days are zero-filled, not omitted', () => {
    const days = summariseDailyActivity({ sends: [], replies: [], ...RANGE });
    expect(days.days).toHaveLength(5);
    expect(days.days.every((d) => d.sent === 0 && d.replied === 0)).toBe(true);
  });

  test('days are bucketed in UTC', () => {
    // 23:30 UTC belongs to the 2nd, not the 3rd, wherever the viewer sits.
    const days = summariseDailyActivity({
      sends: ['2026-09-02T23:30:00Z'], replies: [], ...RANGE,
    });
    expect(days.days.find((d) => d.date === '2026-09-02')?.sent).toBe(1);
    expect(days.days.find((d) => d.date === '2026-09-03')?.sent).toBe(0);
  });

  test('activity outside the window is ignored, not folded into the edges', () => {
    const days = summariseDailyActivity({
      sends: ['2026-08-30T10:00:00Z', '2026-09-03T10:00:00Z', '2026-09-20T10:00:00Z'],
      replies: [],
      ...RANGE,
    });
    expect(days.totals.sent).toBe(1);
    expect(days.days.find((d) => d.date === '2026-09-01')?.sent).toBe(0);
    expect(days.days.find((d) => d.date === '2026-09-05')?.sent).toBe(0);
  });

  test('replies are counted the same way, per reply', () => {
    const days = summariseDailyActivity({
      sends: [],
      replies: ['2026-09-02T08:00:00Z', '2026-09-02T09:00:00Z', '2026-09-04T08:00:00Z'],
      ...RANGE,
    });
    expect(days.days.find((d) => d.date === '2026-09-02')?.replied).toBe(2);
    expect(days.totals.replied).toBe(3);
  });

  test('a single-day window works', () => {
    const days = summariseDailyActivity({
      sends: ['2026-09-03T10:00:00Z'], replies: [],
      start: '2026-09-03', end: '2026-09-03',
    });
    expect(days.days).toEqual([{ date: '2026-09-03', sent: 1, replied: 0 }]);
  });

  test('an unparseable timestamp is skipped rather than crashing the report', () => {
    const days = summariseDailyActivity({
      sends: ['not a date', '2026-09-03T10:00:00Z'], replies: [], ...RANGE,
    });
    expect(days.totals.sent).toBe(1);
  });
});
