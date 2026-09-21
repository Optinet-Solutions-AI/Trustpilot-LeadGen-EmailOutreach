/**
 * Give every follow-up in a batch its own slot.
 *
 * When a campaign finished sending, step 2 was scheduled for all of its leads
 * by computing ONE date and writing it to every row with a single UPDATE. One
 * slot was reserved; N rows were stamped with it. Measured 2026-09-21: 91
 * follow-ups landed on 24 September across two timestamps — 74 at 11:24:41
 * and 17 at 06:54:41 — against a daily ceiling of 60.
 *
 * The planner was never at fault. It was asked once and its answer reused N
 * times, which is also why the comment at that call site claimed to avoid
 * "landing the whole batch on one hour of one day" while doing exactly that.
 */

import { planCampaignSendTimes } from './campaign-send-planner.js';
import type { DayLoad } from './next-step-planner.js';
import type { SendingSchedule } from './schedule-engine.js';

export interface PlanFollowUpBatchInput {
  /** The campaign_leads rows to schedule, in the order they should go out. */
  ids: string[];
  schedule: SendingSchedule;
  /** Shared day load across every campaign; mutated as slots are taken. */
  load: DayLoad;
  capacityPerDay: number;
  /** Soonest the step may go — usually now + delay_days. */
  earliest: Date;
}

/** Row id -> the ISO timestamp that row's follow-up should be sent at. */
export function planFollowUpBatch({
  ids, schedule, load, capacityPerDay, earliest,
}: PlanFollowUpBatchInput): Map<string, string> {
  const plan = new Map<string, string>();
  if (ids.length === 0) return plan;

  // One slot per row, drawn from the same shared budget every other campaign
  // draws from, so the batch spreads across days instead of stacking.
  const times = planCampaignSendTimes({
    count: ids.length,
    schedule,
    load,
    capacityPerDay,
    from: earliest,
  });

  ids.forEach((id, i) => {
    const at = times[i];
    if (at) plan.set(id, at.toISOString());
  });

  return plan;
}
