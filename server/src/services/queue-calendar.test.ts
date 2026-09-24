import { describe, test, expect } from 'vitest';
import { summarizeQueueDays, type QueueEntry } from './queue-calendar.js';
import { resolveScheduleStart, localDayKey, type SendingSchedule } from './schedule-engine.js';

/**
 * The calendar exists because nothing in the app showed a per-day forecast,
 * which is why 5 September 2026 was a surprise: 22 first emails plus 21
 * follow-ups, and the follow-ups appeared in no forecast at all.
 *
 * Two rules it has to get right:
 *  - follow-ups are counted, alongside first touches, not hidden
 *  - every row is bucketed on ONE timeline, so the day's total can be checked
 *    against the one shared daily cap
 *
 * That second rule was the opposite once: days were bucketed in each
 * campaign's own timezone. With six campaign timezones live against a single
 * 60/day pool, the same 24 hours read as two different days and each was
 * allowed its own 60 — measured 2026-09-14, real days reached 65. A per-
 * campaign day is not something a shared cap can be checked against.
 */

const schedule: SendingSchedule = {
  timezone: 'UTC',
  startHour: '09:00',
  endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6],
  dailyLimit: 10,
};

function entry(over: Partial<QueueEntry> & { at: string }): QueueEntry {
  return {
    at: new Date(over.at),
    kind: over.kind ?? 'first_touch',
    state: over.state ?? 'scheduled',
    campaignId: over.campaignId ?? 'c1',
    campaignName: over.campaignName ?? 'Casino | All Countries',
    timezone: over.timezone ?? 'UTC',
    perAccountLimit: 'perAccountLimit' in over ? over.perAccountLimit : 10,
  };
}

describe('localDayKey buckets in the given timezone', () => {
  test('a UTC instant lands on the local calendar day', () => {
    // 22:30 UTC is already the next day in Sydney (UTC+10).
    expect(localDayKey(new Date('2026-09-07T22:30:00Z'), 'UTC')).toBe('2026-09-07');
    expect(localDayKey(new Date('2026-09-07T22:30:00Z'), 'Australia/Sydney')).toBe('2026-09-08');
  });

  test('handles a timezone behind UTC', () => {
    expect(localDayKey(new Date('2026-09-07T02:00:00Z'), 'America/New_York')).toBe('2026-09-06');
  });
});

describe('summarizeQueueDays', () => {
  test('separates first touches from follow-ups on the same day', () => {
    const days = summarizeQueueDays([
      entry({ at: '2026-09-05T10:00:00Z', kind: 'first_touch' }),
      entry({ at: '2026-09-05T11:00:00Z', kind: 'first_touch' }),
      entry({ at: '2026-09-05T12:00:00Z', kind: 'follow_up' }),
    ], { senderCount: 3 });

    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      date: '2026-09-05', firstTouch: 2, followUp: 1, total: 3,
    });
  });

  test('reproduces the 5 September shape and flags it over capacity', () => {
    const rows: QueueEntry[] = [];
    for (let i = 0; i < 22; i++) rows.push(entry({ at: '2026-09-05T10:00:00Z', kind: 'first_touch', state: 'sent' }));
    for (let i = 0; i < 21; i++) rows.push(entry({ at: '2026-09-05T13:00:00Z', kind: 'follow_up', state: 'sent' }));
    for (let i = 0; i < 30; i++) rows.push(entry({ at: '2026-09-06T10:00:00Z', kind: 'first_touch', state: 'sent' }));

    const days = summarizeQueueDays(rows, { senderCount: 3 });
    const fri = days.find((d) => d.date === '2026-09-05')!;
    const sat = days.find((d) => d.date === '2026-09-06')!;

    expect(fri.total).toBe(43);
    expect(fri.followUp).toBe(21);
    expect(fri.overCapacity).toBe(true);
    expect(fri.overBy).toBe(13);

    expect(sat.total).toBe(30);
    expect(sat.overCapacity).toBe(false);
    expect(sat.overBy).toBe(0);
  });

  test('a day exactly at capacity is not over', () => {
    const rows = Array.from({ length: 30 }, () => entry({ at: '2026-09-08T10:00:00Z' }));
    expect(summarizeQueueDays(rows, { senderCount: 3 })[0].overCapacity).toBe(false);
  });

  test('two campaigns in different timezones share ONE day, and one cap', () => {
    // Both instants are the same moment. Bucketing them by each campaign's own
    // timezone put them on different days, and each day then got a full 60 —
    // so the shared pool quietly issued 120 for one 24-hour period.
    const days = summarizeQueueDays([
      entry({ at: '2026-09-07T22:00:00Z', timezone: 'UTC', campaignId: 'utc', campaignName: 'Casino | Germany' }),
      entry({ at: '2026-09-07T22:00:00Z', timezone: 'Australia/Sydney', campaignId: 'syd', campaignName: 'MIX | Australia' }),
    ], { senderCount: 3 });

    expect(days.map((d) => d.date)).toEqual(['2026-09-07']);
    expect(days[0].total).toBe(2);
    // Both campaigns show up as owners of that day, so the operator can still
    // see which ones make up the number.
    expect(days[0].campaigns.map((c) => c.id).sort()).toEqual(['syd', 'utc']);
  });

  test('splits sent from still-scheduled so past and future read differently', () => {
    const days = summarizeQueueDays([
      entry({ at: '2026-09-05T10:00:00Z', state: 'sent' }),
      entry({ at: '2026-09-05T11:00:00Z', state: 'scheduled' }),
      entry({ at: '2026-09-05T12:00:00Z', state: 'scheduled' }),
    ], { senderCount: 3 });

    expect(days[0]).toMatchObject({ sent: 1, scheduled: 2, total: 3 });
  });

  test('attributes each day to the campaigns that make it up, busiest first', () => {
    const days = summarizeQueueDays([
      entry({ at: '2026-09-05T10:00:00Z', campaignId: 'a', campaignName: 'Alpha' }),
      entry({ at: '2026-09-05T10:30:00Z', campaignId: 'b', campaignName: 'Beta' }),
      entry({ at: '2026-09-05T11:00:00Z', campaignId: 'b', campaignName: 'Beta' }),
    ], { senderCount: 3 });

    expect(days[0].campaigns).toEqual([
      { id: 'b', name: 'Beta', count: 2 },
      { id: 'a', name: 'Alpha', count: 1 },
    ]);
  });

  test('returns days in chronological order', () => {
    const days = summarizeQueueDays([
      entry({ at: '2026-09-09T10:00:00Z' }),
      entry({ at: '2026-09-05T10:00:00Z' }),
      entry({ at: '2026-09-07T10:00:00Z' }),
    ], { senderCount: 3 });
    expect(days.map((d) => d.date)).toEqual(['2026-09-05', '2026-09-07', '2026-09-09']);
  });

  test('no entries means no days, not a fabricated row', () => {
    expect(summarizeQueueDays([], { senderCount: 3 })).toEqual([]);
  });

  test('a day whose campaigns state no limit has no capacity to judge', () => {
    // Better than pretending a limit we cannot determine was respected.
    const days = summarizeQueueDays(
      [entry({ at: '2026-09-05T10:00:00Z', perAccountLimit: undefined })],
      { senderCount: 3 },
    );
    expect(days[0].capacity).toBeNull();
    expect(days[0].overCapacity).toBe(false);
    expect(days[0].overBy).toBe(0);
  });

  test('capacity is per DAY, from the campaigns sending that day', () => {
    // Friday has only the 10-per-account campaign -> ceiling 30.
    // Saturday also has a 30-per-account campaign -> ceiling 90, because at
    // send time the cap is read from the row being sent.
    const days = summarizeQueueDays([
      entry({ at: '2026-09-05T10:00:00Z', perAccountLimit: 10 }),
      entry({ at: '2026-09-06T10:00:00Z', perAccountLimit: 10 }),
      entry({ at: '2026-09-06T11:00:00Z', perAccountLimit: 30, campaignId: 'big', campaignName: 'MIX | Australia' }),
    ], { senderCount: 3 });

    expect(days.find((d) => d.date === '2026-09-05')!.capacity).toBe(30);
    expect(days.find((d) => d.date === '2026-09-06')!.capacity).toBe(90);
  });
});

describe('resolveScheduleStart', () => {
  const NOW = new Date('2026-09-07T12:00:00Z'); // Monday, inside the window

  test('with no start date, sending begins now', () => {
    expect(resolveScheduleStart(schedule, NOW).toISOString()).toBe(NOW.toISOString());
  });

  test('a future start date defers to that day\'s window opening', () => {
    const s = { ...schedule, startDate: '2026-09-10' };
    expect(resolveScheduleStart(s, NOW).toISOString()).toBe('2026-09-10T09:00:00.000Z');
  });

  test('a past start date never sends into the past', () => {
    const s = { ...schedule, startDate: '2026-09-01' };
    expect(resolveScheduleStart(s, NOW).toISOString()).toBe(NOW.toISOString());
  });

  test('today as the start date keeps the current mid-window position', () => {
    const s = { ...schedule, startDate: '2026-09-07' };
    expect(resolveScheduleStart(s, NOW).toISOString()).toBe(NOW.toISOString());
  });

  test('a start date on a day the campaign skips moves to the next allowed day', () => {
    // Weekdays only; 2026-09-12 is a Saturday, so start Monday the 14th.
    const s = { ...schedule, days: [1, 2, 3, 4, 5], startDate: '2026-09-12' };
    expect(resolveScheduleStart(s, NOW).toISOString()).toBe('2026-09-14T09:00:00.000Z');
  });

  test('the start date is read in the campaign timezone, not UTC', () => {
    // 09:00 on 10 September in Sydney (UTC+10) is 23:00 UTC on the 9th.
    const s = { ...schedule, timezone: 'Australia/Sydney', startDate: '2026-09-10' };
    expect(resolveScheduleStart(s, NOW).toISOString()).toBe('2026-09-09T23:00:00.000Z');
  });

  test('a malformed start date is ignored rather than throwing', () => {
    const s = { ...schedule, startDate: 'not-a-date' };
    expect(resolveScheduleStart(s, NOW).toISOString()).toBe(NOW.toISOString());
  });
});

describe('capacity never exceeds the mailbox cap', () => {
  test('an old campaign asking 200 per account is clamped to the mailbox cap', () => {
    // Real data: campaigns from June still hold 150 and 200 per account from
    // when the field meant a whole-campaign total. Rendering 600/day would
    // promise volume the sender clamps away.
    const days = summarizeQueueDays(
      [entry({ at: '2026-09-14T10:00:00Z', perAccountLimit: 200 })],
      { senderCount: 3, accountCap: 29 },
    );
    expect(days[0].capacity).toBe(87); // 29 x 3, not 600
  });

  test('a campaign below the mailbox cap keeps its own stricter figure', () => {
    const days = summarizeQueueDays(
      [entry({ at: '2026-09-14T10:00:00Z', perAccountLimit: 10 })],
      { senderCount: 3, accountCap: 29 },
    );
    expect(days[0].capacity).toBe(30);
  });
});

/**
 * Work belonging to a campaign that is not sending.
 *
 * A first email only fires for a campaign whose status is `sending` — the
 * scheduler joins on it. A paused campaign's queued first touches therefore
 * cannot go out at all, yet the calendar drew them as ordinary scheduled mail.
 * Measured 2026-09-24 with every campaign paused: 443 first touches were
 * drawn as if they would send, 120 of them dated in the past, which is what
 * put "53 new" on 21 September and "42 new" on the 23rd — days on which no
 * first email left at all.
 *
 * They are still shown, because the operator needs to know the backlog is
 * there. They are just not counted as work that will happen, and they cannot
 * push a day over its cap.
 *
 * Follow-ups are deliberately NOT treated this way: the sequence scheduler
 * fires any row with a due date regardless of its campaign's status, so a
 * dated follow-up on a paused campaign really does send.
 */
describe('work that cannot send', () => {
  test('is counted apart from the queue rather than added to it', () => {
    const [day] = summarizeQueueDays([
      entry({ at: '2026-09-21T10:00:00Z' }),
      entry({ at: '2026-09-21T11:00:00Z', state: 'paused' }),
      entry({ at: '2026-09-21T12:00:00Z', state: 'paused' }),
    ], { senderCount: 3 });

    expect(day.total).toBe(1);
    expect(day.firstTouch).toBe(1);
    expect(day.scheduled).toBe(1);
    expect(day.paused).toBe(2);
  });

  test('never pushes a day over capacity on its own', () => {
    // 30 paused rows against a ceiling of 30 is not an over-cap day: none of
    // them will leave. Alarming on them is how a paused queue reads as a
    // breach.
    const at = '2026-09-21T10:00:00Z';
    const [day] = summarizeQueueDays(
      Array.from({ length: 40 }, () => entry({ at, state: 'paused' })),
      { senderCount: 3 },
    );
    expect(day.total).toBe(0);
    expect(day.overCapacity).toBe(false);
    expect(day.paused).toBe(40);
  });

  test('still names its campaign, so the backlog can be traced', () => {
    const [day] = summarizeQueueDays([
      entry({ at: '2026-09-21T10:00:00Z', state: 'paused', campaignId: 'uae', campaignName: 'UAE' }),
    ], { senderCount: 3 });
    expect(day.campaigns).toEqual([{ id: 'uae', name: 'UAE', count: 1 }]);
  });
});
