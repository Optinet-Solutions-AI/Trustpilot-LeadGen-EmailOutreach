/**
 * Where a campaign's first-touch emails actually land on the calendar.
 *
 * `assignScheduledTimes` lays out a campaign in isolation: it fills day 1 to
 * `dailyLimit * senderCount`, then day 2, and so on, with no idea what any
 * other campaign has already booked. That is fine for one campaign and wrong
 * for twelve. On 2026-09-14 twelve launches each filled the same days to 60
 * and the calendar read 99, 79, 85, 102, 87 against a real ceiling of 60,
 * while the last week of the run sat empty. The send gate held the volume, so
 * nothing over-sent — but every date past the first day was fiction, and the
 * overflow quietly aged into overdue backlog instead of rolling forward.
 *
 * This plans against the SHARED day load (the same map the follow-up planner
 * and the re-pacer use), so a launch fills the room other campaigns left and
 * spills the remainder onto the next day that has any. That is what "it rolls
 * over when the daily cap is reached" means.
 */

import { planNextStepAt, type DayLoad } from './next-step-planner.js';
import type { SendingSchedule } from './schedule-engine.js';

const DAY_MS = 86_400_000;

export interface FollowUpStep {
  stepNumber: number;
  delayDays: number;
}

export interface PlanCampaignSendInput {
  /** How many first-touch emails to place. */
  count: number;
  schedule: SendingSchedule;
  /**
   * Emails already booked per local day, across EVERY campaign. Mutated as
   * slots are taken, so consecutive calls in one tick see each other — which
   * is the whole point.
   */
  load: DayLoad;
  /** Shared ceiling for one day across all mailboxes and campaigns. */
  capacityPerDay: number;
  /**
   * This campaign's own per-day figure (its `dailyLimit` times its mailbox
   * count). It binds INSIDE the shared ceiling, so a campaign the operator
   * set to 15 a day stays at 15 even on an otherwise empty calendar.
   * Omitted means the shared ceiling is the only limit.
   */
  ownCapacityPerDay?: number;
  /**
   * The campaign's follow-up steps. Each first touch placed here books the
   * days its own follow-ups will need, at the same moment.
   *
   * `delay_days` is a SOONEST, not a promise — a follow-up lands on the first
   * day that still has room. So placing 600 first touches first filled every
   * day for a fortnight and pushed every follow-up behind them: a measured
   * median gap of 10 days against a configured 3. Booking the sequence as a
   * unit inverts it, and costs nothing, because the follow-up was always going
   * to consume that capacity — it was only a question of when.
   *
   * The reservations are NOT returned and never written. They shape the gaps
   * that the follow-ups later drop into, which is what makes the plan and the
   * forecast agree.
   */
  followUpSteps?: FollowUpStep[];
  /** Earliest moment sending may begin (campaign start date, or now). */
  from: Date;
}

export function planCampaignSendTimes({
  count, schedule, load, capacityPerDay, ownCapacityPerDay, followUpSteps, from,
}: PlanCampaignSendInput): Date[] {
  if (count <= 0) return [];

  // Private to this campaign, so one campaign's own figure never counts
  // against another's.
  const ownLoad: DayLoad = new Map();
  const steps = [...(followUpSteps ?? [])].sort((a, b) => a.stepNumber - b.stepNumber);

  const times: Date[] = [];
  for (let i = 0; i < count; i++) {
    // `now` is pinned to `from` so a start date in the future is honoured
    // rather than being clamped up to the current instant.
    const at = planNextStepAt({
      load, schedule, earliest: from, capacityPerDay, now: from,
      ownLoad, ownCapacityPerDay,
    });
    times.push(at);

    // Book the rest of this prospect's sequence while the days after it are
    // still free, so the follow-up keeps its promised date and the first
    // touches that come after work around it.
    let cursor = at;
    for (const step of steps) {
      cursor = planNextStepAt({
        load, schedule, capacityPerDay, now: from,
        earliest: new Date(cursor.getTime() + step.delayDays * DAY_MS),
        ownLoad, ownCapacityPerDay,
      });
    }
  }

  return times.sort((a, b) => a.getTime() - b.getTime());
}
