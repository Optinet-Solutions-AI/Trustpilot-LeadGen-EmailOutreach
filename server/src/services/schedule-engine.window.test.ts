import { describe, test, expect } from 'vitest';
import { windowOpeningOnLocalDay, type SendingSchedule } from './schedule-engine.js';

/**
 * Where a sending day actually starts.
 *
 * Both the re-pacer and the follow-up planner kept their own copy of this, and
 * both built the opening as "UTC midnight of the local date, plus the start
 * hour". That is only right for UTC. For a campaign at 00:00-23:59
 * Europe/Paris the real opening is 22:00 UTC the previous day, but the copies
 * returned 00:00 UTC — two hours late and, crucially, on the NEXT budget day.
 *
 * Placements were then spread from that wrong origin: measured against live
 * data on 2026-09-14, 262 of 687 re-paced emails were charged to one day and
 * placed on another, and the calendar showed 65 against a cap of 60. One
 * shared implementation, tested, replaces both copies.
 */

const at = (iso: string) => new Date(iso);

const paris: SendingSchedule = {
  timezone: 'Europe/Paris', startHour: '00:00', endHour: '23:59',
  days: [0, 1, 2, 3, 4, 5, 6], dailyLimit: 20,
};

describe('windowOpeningOnLocalDay', () => {
  test('a UTC campaign opens at its start hour, unsurprisingly', () => {
    const utc: SendingSchedule = { ...paris, timezone: 'UTC', startHour: '09:00', endHour: '17:00' };
    expect(windowOpeningOnLocalDay(utc, at('2026-09-20T10:30:00Z')).toISOString())
      .toBe('2026-09-20T09:00:00.000Z');
  });

  test('a timezone AHEAD of UTC opens on the previous UTC day', () => {
    // 00:30 on 20 September in Paris (UTC+2) is 22:30 UTC on the 19th, and
    // that day's window opened half an hour earlier, at 22:00 UTC.
    expect(windowOpeningOnLocalDay(paris, at('2026-09-19T22:30:00Z')).toISOString())
      .toBe('2026-09-19T22:00:00.000Z');
  });

  test('the same Paris day, asked from the middle of it, gives the same opening', () => {
    // 12:00 Paris on the 20th is 10:00 UTC — still the local day that opened
    // at 22:00 UTC on the 19th.
    expect(windowOpeningOnLocalDay(paris, at('2026-09-20T10:00:00Z')).toISOString())
      .toBe('2026-09-19T22:00:00.000Z');
  });

  test('a timezone BEHIND UTC opens later the same UTC day', () => {
    const ny: SendingSchedule = {
      ...paris, timezone: 'America/New_York', startHour: '16:00', endHour: '23:59',
    };
    // 21:00 on 20 September in New York (UTC-4) is 01:00 UTC on the 21st.
    expect(windowOpeningOnLocalDay(ny, at('2026-09-21T01:00:00Z')).toISOString())
      .toBe('2026-09-20T20:00:00.000Z');
  });

  test('a non-midnight start hour is honoured, not rounded to the local day', () => {
    const dubai: SendingSchedule = {
      ...paris, timezone: 'Asia/Dubai', startHour: '07:00', endHour: '17:00',
    };
    // 07:00 Dubai (UTC+4) is 03:00 UTC.
    expect(windowOpeningOnLocalDay(dubai, at('2026-09-20T08:00:00Z')).toISOString())
      .toBe('2026-09-20T03:00:00.000Z');
  });

  test('a day the campaign does not send on rolls forward to one it does', () => {
    const mondays: SendingSchedule = {
      ...paris, timezone: 'UTC', startHour: '09:00', endHour: '17:00', days: [1],
    };
    // 2026-09-20 is a Sunday; the next sending day opens Monday at 09:00.
    expect(windowOpeningOnLocalDay(mondays, at('2026-09-20T10:00:00Z')).toISOString())
      .toBe('2026-09-21T09:00:00.000Z');
  });

  test('the opening is never after the moment asked about, on a sending day', () => {
    // The property that matters: spreading a day's sends measures from here,
    // so an opening in the future would push every slot past the window.
    const when = at('2026-09-20T10:00:00Z');
    expect(windowOpeningOnLocalDay(paris, when).getTime()).toBeLessThanOrEqual(when.getTime());
  });
});
