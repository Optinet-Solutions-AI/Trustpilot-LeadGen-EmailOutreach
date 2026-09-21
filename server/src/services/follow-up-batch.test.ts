import { describe, test, expect } from 'vitest';
import { planFollowUpBatch } from './follow-up-batch.js';
import type { DayLoad } from './next-step-planner.js';
import type { SendingSchedule } from './schedule-engine.js';

/**
 * When a campaign finished sending, step 2 was scheduled for the whole batch
 * by computing ONE date and writing it to every row:
 *
 *   nextStepAt = planNextStepAt({...}).toISOString();
 *   .update({ next_step_at: nextStepAt }).eq('campaign_id', id)
 *
 * One slot was reserved; N rows were stamped with it. Measured 2026-09-21,
 * that put 91 follow-ups on 24 September at two timestamps — 74 at 11:24:41
 * and 17 at 06:54:41 — on a day whose ceiling is 60. The planner was doing
 * its job; the caller asked it once and then ignored the answer N times.
 *
 * Every row in the batch needs its own slot.
 */

const schedule: SendingSchedule = {
  timezone: 'UTC', startHour: '09:00', endHour: '17:00',
  days: [0, 1, 2, 3, 4, 5, 6], dailyLimit: 20,
};
const EARLIEST = new Date('2026-09-24T06:00:00Z');
const day = (iso: string) => iso.slice(0, 10);

describe('planFollowUpBatch', () => {
  test('every row gets its own slot, not one date copied across the batch', () => {
    const ids = Array.from({ length: 74 }, (_, i) => `row${i}`);
    const plan = planFollowUpBatch({
      ids, schedule, load: new Map(), capacityPerDay: 60, earliest: EARLIEST,
    });

    expect(plan.size).toBe(74);
    const distinct = new Set(plan.values());
    // The old code produced exactly one distinct timestamp for all 74.
    expect(distinct.size).toBeGreaterThan(60);
  });

  test('the batch spills across days instead of piling onto one', () => {
    const ids = Array.from({ length: 91 }, (_, i) => `row${i}`);
    const plan = planFollowUpBatch({
      ids, schedule, load: new Map(), capacityPerDay: 60, earliest: EARLIEST,
    });
    const perDay = new Map<string, number>();
    for (const iso of plan.values()) perDay.set(day(iso), (perDay.get(day(iso)) ?? 0) + 1);

    expect([...perDay.entries()].sort()).toEqual([
      ['2026-09-24', 60], ['2026-09-25', 31],
    ]);
  });

  test('a day other campaigns have already filled is skipped', () => {
    const load: DayLoad = new Map([['2026-09-24', 60]]);
    const ids = ['a', 'b', 'c'];
    const plan = planFollowUpBatch({
      ids, schedule, load, capacityPerDay: 60, earliest: EARLIEST,
    });
    for (const iso of plan.values()) expect(day(iso)).toBe('2026-09-25');
  });

  test('the shared load is updated, so the next campaign sees this batch', () => {
    const load: DayLoad = new Map();
    planFollowUpBatch({
      ids: ['a', 'b', 'c'], schedule, load, capacityPerDay: 60, earliest: EARLIEST,
    });
    expect(load.get('2026-09-24')).toBe(3);
  });

  test('nothing is ever scheduled before the delay has elapsed', () => {
    const plan = planFollowUpBatch({
      ids: ['a'], schedule, load: new Map(), capacityPerDay: 60, earliest: EARLIEST,
    });
    expect([...plan.values()][0] >= '2026-09-24').toBe(true);
  });

  test('an empty batch plans nothing', () => {
    expect(planFollowUpBatch({
      ids: [], schedule, load: new Map(), capacityPerDay: 60, earliest: EARLIEST,
    }).size).toBe(0);
  });

  test('ids are preserved exactly — no row is dropped or duplicated', () => {
    const ids = ['x', 'y', 'z'];
    const plan = planFollowUpBatch({
      ids, schedule, load: new Map(), capacityPerDay: 60, earliest: EARLIEST,
    });
    expect([...plan.keys()].sort()).toEqual(['x', 'y', 'z']);
  });
});
