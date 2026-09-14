import { describe, test, expect } from 'vitest';
import { planCampaignSendTimes } from './campaign-send-planner.js';
import type { DayLoad } from './next-step-planner.js';
import type { SendingSchedule } from './schedule-engine.js';

/**
 * A campaign used to lay out its own sends with no idea what other campaigns
 * had already booked. Twelve campaigns launched on 2026-09-14, each asking
 * for 20 per mailbox across 3 mailboxes, each independently filling days to
 * 60 — so the calendar showed 99, 79, 85, 102 and 87 on days whose real
 * ceiling is 60. The send gate held the volume, but the dates were fiction
 * and the excess silently became overdue backlog.
 *
 * Planning now draws from the same shared day-load the follow-up planner and
 * the re-pacer use, so a launch fills the gaps other campaigns left.
 */

const schedule: SendingSchedule = {
  timezone: 'UTC',
  startHour: '09:00',
  endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6],
  dailyLimit: 20,
};

const FROM = new Date('2026-09-14T08:00:00Z'); // before the window opens
const day = (d: Date) => d.toISOString().slice(0, 10);

function perDay(times: Date[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const t of times) m.set(day(t), (m.get(day(t)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

describe('planCampaignSendTimes', () => {
  test('an empty calendar fills days to capacity and rolls over', () => {
    const times = planCampaignSendTimes({
      count: 150, schedule, load: new Map(), capacityPerDay: 60, from: FROM,
    });
    expect(times).toHaveLength(150);
    expect(perDay(times)).toEqual([
      ['2026-09-14', 60], ['2026-09-15', 60], ['2026-09-16', 30],
    ]);
  });

  test('a second campaign fills the gaps the first left, instead of stacking', () => {
    // The actual failure: both campaigns booked 60 on the same day.
    const load: DayLoad = new Map();
    const first = planCampaignSendTimes({ count: 60, schedule, load, capacityPerDay: 60, from: FROM });
    const second = planCampaignSendTimes({ count: 60, schedule, load, capacityPerDay: 60, from: FROM });

    expect(perDay(first)).toEqual([['2026-09-14', 60]]);
    // The 14th is full, so the second campaign starts on the 15th.
    expect(perDay(second)).toEqual([['2026-09-15', 60]]);
  });

  test('twelve campaigns launched at once spread across days, none over cap', () => {
    const load: DayLoad = new Map();
    const all: Date[] = [];
    for (let i = 0; i < 12; i++) {
      all.push(...planCampaignSendTimes({
        count: 50, schedule, load, capacityPerDay: 60, from: FROM,
      }));
    }
    expect(all).toHaveLength(600);
    const days = perDay(all);
    expect(days.every(([, n]) => n <= 60)).toBe(true);
    // 600 at 60/day = exactly ten full days.
    expect(days).toHaveLength(10);
    expect(days.every(([, n]) => n === 60)).toBe(true);
  });

  test('days already part-booked by follow-ups only take what is left', () => {
    // Follow-ups are booked first and share the same budget.
    const load: DayLoad = new Map([['2026-09-14', 45]]);
    const times = planCampaignSendTimes({
      count: 40, schedule, load, capacityPerDay: 60, from: FROM,
    });
    expect(perDay(times)).toEqual([['2026-09-14', 15], ['2026-09-15', 25]]);
  });

  test('the shared load is updated so later callers see this campaign', () => {
    const load: DayLoad = new Map();
    planCampaignSendTimes({ count: 30, schedule, load, capacityPerDay: 60, from: FROM });
    expect(load.get('2026-09-14')).toBe(30);
  });

  test('times land inside the sending window and are spread, not stacked', () => {
    const times = planCampaignSendTimes({
      count: 60, schedule, load: new Map(), capacityPerDay: 60, from: FROM,
    });
    for (const t of times) {
      expect(t.getUTCHours()).toBeGreaterThanOrEqual(9);
      expect(t.getUTCHours()).toBeLessThan(17);
    }
    expect(new Set(times.map((t) => t.toISOString())).size).toBeGreaterThan(40);
  });

  test('days the campaign does not send on are skipped', () => {
    const weekdays = { ...schedule, days: [1, 2, 3, 4, 5] };
    // 2026-09-14 is a Monday; the 19th and 20th are the weekend.
    const times = planCampaignSendTimes({
      count: 330, schedule: weekdays, load: new Map(), capacityPerDay: 60, from: FROM,
    });
    const dates = perDay(times).map(([d]) => d);
    expect(dates).not.toContain('2026-09-19');
    expect(dates).not.toContain('2026-09-20');
  });

  test('a follow-up is booked with its first email, so it cannot be crowded out', () => {
    // delay_days is a SOONEST, not a promise: a follow-up lands on the first
    // day that still has room. Placing 600 first emails first therefore filled
    // every day for a fortnight and pushed every follow-up behind them — a
    // measured median gap of 10 days against a configured 3. Booking each
    // prospect's whole sequence at once inverts that: the follow-up takes its
    // day, and later first emails work around it.
    const load: DayLoad = new Map();
    const times = planCampaignSendTimes({
      count: 240, schedule, load, capacityPerDay: 60, from: FROM,
      followUpSteps: [{ stepNumber: 2, delayDays: 3 }],
    });

    // Three days of first emails, then three days that belong to their
    // follow-ups, then first emails resume.
    expect(perDay(times)).toEqual([
      ['2026-09-14', 60], ['2026-09-15', 60], ['2026-09-16', 60], ['2026-09-20', 60],
    ]);
    // The reserved days are full in the shared load even though no first email
    // sits on them.
    expect(load.get('2026-09-17')).toBe(60);
    expect(load.get('2026-09-18')).toBe(60);
    expect(load.get('2026-09-19')).toBe(60);
  });

  test('no day ever exceeds capacity once reservations are counted', () => {
    const load: DayLoad = new Map();
    planCampaignSendTimes({
      count: 300, schedule, load, capacityPerDay: 60, from: FROM,
      followUpSteps: [{ stepNumber: 2, delayDays: 3 }],
    });
    for (const [, n] of load) expect(n).toBeLessThanOrEqual(60);
  });

  test('a two-step sequence reserves both follow-ups', () => {
    const load: DayLoad = new Map();
    planCampaignSendTimes({
      count: 60, schedule, load, capacityPerDay: 60, from: FROM,
      followUpSteps: [{ stepNumber: 2, delayDays: 3 }, { stepNumber: 3, delayDays: 4 }],
    });
    expect(load.get('2026-09-14')).toBe(60); // the first emails
    expect(load.get('2026-09-17')).toBe(60); // step 2, three days later
    expect(load.get('2026-09-21')).toBe(60); // step 3, four days after step 2
  });

  test('without follow-up steps nothing is reserved', () => {
    const load: DayLoad = new Map();
    planCampaignSendTimes({ count: 120, schedule, load, capacityPerDay: 60, from: FROM });
    expect(load.get('2026-09-14')).toBe(60);
    expect(load.get('2026-09-15')).toBe(60);
    expect(load.get('2026-09-17')).toBeUndefined();
  });

  test('asking for nothing plans nothing', () => {
    expect(planCampaignSendTimes({
      count: 0, schedule, load: new Map(), capacityPerDay: 60, from: FROM,
    })).toEqual([]);
  });

  test('results come back in chronological order', () => {
    const times = planCampaignSendTimes({
      count: 100, schedule, load: new Map(), capacityPerDay: 60, from: FROM,
    });
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    expect(times.map(String)).toEqual(sorted.map(String));
  });
  test('a campaign never exceeds its OWN per-day figure inside the shared budget', () => {
    // 60/day is the shared ceiling, but this campaign is configured to send 15
    // a day. The operator's per-campaign figure is a promise, not a hint.
    const times = planCampaignSendTimes({
      count: 40, schedule, load: new Map(), capacityPerDay: 60, ownCapacityPerDay: 15, from: FROM,
    });
    expect(perDay(times)).toEqual([
      ['2026-09-14', 15], ['2026-09-15', 15], ['2026-09-16', 10],
    ]);
  });

  test('the shared ceiling still wins when it is the stricter of the two', () => {
    const load: DayLoad = new Map([['2026-09-14', 55]]);
    const times = planCampaignSendTimes({
      count: 20, schedule, load, capacityPerDay: 60, ownCapacityPerDay: 15, from: FROM,
    });
    expect(perDay(times)).toEqual([['2026-09-14', 5], ['2026-09-15', 15]]);
  });

  test('a campaign-level figure does not leak into the next campaign', () => {
    const load: DayLoad = new Map();
    planCampaignSendTimes({ count: 15, schedule, load, capacityPerDay: 60, ownCapacityPerDay: 15, from: FROM });
    const second = planCampaignSendTimes({
      count: 15, schedule, load, capacityPerDay: 60, ownCapacityPerDay: 15, from: FROM,
    });
    // Its own 15 are spent, but the shared day still has 45 free for anyone else.
    expect(perDay(second)).toEqual([['2026-09-14', 15]]);
  });
});
