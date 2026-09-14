import { describe, test, expect } from 'vitest';
import { projectFollowUps, type ForecastRow } from './queue-forecast.js';
import type { DayLoad } from './next-step-planner.js';
import type { SendingSchedule } from './schedule-engine.js';

/**
 * A follow-up gets its date only when the email before it actually sends, so
 * every follow-up behind unsent mail is invisible until the day it appears.
 * Measured 2026-09-14: 664 first touches were on the calendar and 588
 * follow-ups behind them were not — the calendar showed 692 of 1280 emails,
 * and the operator's question was precisely "why don't my follow-ups show?".
 *
 * The projection answers it by placing them the way the sequence scheduler
 * will: delay_days as a SOONEST, then the first day with room. It is a
 * forecast, not a booking — nothing is written — but it draws from the same
 * shared day-load, so a day that is full of first touches pushes the
 * follow-ups outward instead of silently doubling the day.
 */

const schedule: SendingSchedule = {
  timezone: 'UTC', startHour: '09:00', endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6], dailyLimit: 20,
};
const NOW = new Date('2026-09-14T08:00:00Z');
const day = (d: Date) => d.toISOString().slice(0, 10);

const base = {
  stepsByCampaign: new Map([['c1', [{ stepNumber: 2, delayDays: 3 }]]]),
  scheduleByCampaign: new Map([['c1', schedule]]),
  capacityPerDay: 60,
  now: NOW,
};

const row = (over: Partial<ForecastRow> = {}): ForecastRow => ({
  campaignId: 'c1',
  campaignLeadId: 'l1',
  baseAt: new Date('2026-09-14T10:00:00Z'),
  currentStep: 0,
  ...over,
});

describe('projectFollowUps', () => {
  test('a first touch that has not sent yet still shows its follow-up', () => {
    const out = projectFollowUps({ ...base, rows: [row()], load: new Map() });
    expect(out).toHaveLength(1);
    expect(out[0].stepNumber).toBe(2);
    expect(day(out[0].at)).toBe('2026-09-17'); // 14th + 3 days
    expect(out[0].campaignLeadId).toBe('l1');
  });

  test('the delay is a soonest, not an exact date — a full day pushes it out', () => {
    const load: DayLoad = new Map([['2026-09-17', 60]]);
    const out = projectFollowUps({ ...base, rows: [row()], load });
    expect(day(out[0].at)).toBe('2026-09-18');
  });

  test('projections consume the shared budget, so they cannot double a day', () => {
    const load: DayLoad = new Map();
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({ campaignLeadId: `l${i}` }));
    const out = projectFollowUps({ ...base, rows, load });
    expect(out).toHaveLength(100);
    const perDay = new Map<string, number>();
    for (const p of out) perDay.set(day(p.at), (perDay.get(day(p.at)) ?? 0) + 1);
    expect([...perDay.entries()].sort()).toEqual([
      ['2026-09-17', 60], ['2026-09-18', 40],
    ]);
  });

  test('first touches already booked on the day take priority over follow-ups', () => {
    // 50 first touches already hold the 17th; only 10 follow-ups fit.
    const load: DayLoad = new Map([['2026-09-17', 50]]);
    const rows = Array.from({ length: 20 }, (_, i) => row({ campaignLeadId: `l${i}` }));
    const out = projectFollowUps({ ...base, rows, load });
    const on17 = out.filter((p) => day(p.at) === '2026-09-17');
    expect(on17).toHaveLength(10);
  });

  test('a later step is measured from where the previous step actually landed', () => {
    const out = projectFollowUps({
      ...base,
      stepsByCampaign: new Map([['c1', [
        { stepNumber: 2, delayDays: 3 },
        { stepNumber: 3, delayDays: 4 },
      ]]]),
      rows: [row()],
      load: new Map(),
    });
    expect(out.map((p) => [p.stepNumber, day(p.at)])).toEqual([
      [2, '2026-09-17'], [3, '2026-09-21'],
    ]);
  });

  test('steps already sent are not projected again', () => {
    const out = projectFollowUps({
      ...base,
      stepsByCampaign: new Map([['c1', [
        { stepNumber: 2, delayDays: 3 },
        { stepNumber: 3, delayDays: 4 },
      ]]]),
      rows: [row({ currentStep: 2 })],
      load: new Map(),
    });
    expect(out.map((p) => p.stepNumber)).toEqual([3]);
  });

  test('a campaign with no follow-up steps projects nothing', () => {
    const out = projectFollowUps({
      ...base, stepsByCampaign: new Map(), rows: [row()], load: new Map(),
    });
    expect(out).toEqual([]);
  });

  test('earlier mail claims the earlier slots', () => {
    const load: DayLoad = new Map();
    const rows = [
      row({ campaignLeadId: 'late',  baseAt: new Date('2026-09-20T10:00:00Z') }),
      row({ campaignLeadId: 'early', baseAt: new Date('2026-09-14T10:00:00Z') }),
    ];
    const out = projectFollowUps({ ...base, rows, load });
    // Input order must not decide the calendar; the base date does.
    expect(out.map((p) => p.campaignLeadId)).toEqual(['early', 'late']);
    expect(day(out[0].at)).toBe('2026-09-17');
    expect(day(out[1].at)).toBe('2026-09-23');
  });

  test('nothing is ever projected into the past', () => {
    const out = projectFollowUps({
      ...base,
      rows: [row({ baseAt: new Date('2026-08-01T10:00:00Z') })],
      load: new Map(),
    });
    expect(out[0].at.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  });

  test('a campaign with no usable window still contributes to the day count', () => {
    // It cannot be placed properly, but pretending it is not there is what
    // made the calendar under-report in the first place.
    const load: DayLoad = new Map();
    const out = projectFollowUps({
      ...base, scheduleByCampaign: new Map(), rows: [row()], load,
    });
    expect(out).toHaveLength(1);
    expect(day(out[0].at)).toBe('2026-09-17');
    expect(load.get('2026-09-17')).toBe(1);
  });
});
