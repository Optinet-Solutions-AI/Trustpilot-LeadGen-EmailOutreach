/**
 * The follow-ups nobody could see.
 *
 * A follow-up's date is written only when the email before it actually sends
 * — `next_step_at` is set at first-touch send time. So every follow-up behind
 * unsent mail has no date, and anything reading dates (the calendar, the
 * capacity check, the operator) simply cannot see it. Measured 2026-09-14:
 * 664 first touches were on the calendar and 588 follow-ups behind them were
 * not, so the calendar showed roughly half the real workload and the tail of
 * the run looked empty when it was not.
 *
 * This projects them. It is a FORECAST, never a booking: nothing is written,
 * and when the first touch really sends the scheduler re-derives the date.
 * The point is that it forecasts the same way the scheduler will decide —
 * `delay_days` as a soonest, then the first day with room in the shared
 * budget — so the number on the calendar is the number that will happen.
 */

import { planNextStepAt, type DayLoad } from './next-step-planner.js';
import { localDayKey, BUDGET_TIMEZONE, type SendingSchedule } from './schedule-engine.js';

export interface ForecastRow {
  campaignId: string;
  campaignLeadId: string;
  /** When this row's most recent/next email is due — scheduled_at or sent_at. */
  baseAt: Date;
  /** Highest step already sent. 0 or 1 means only the first touch is done. */
  currentStep: number;
}

export interface ForecastStep {
  stepNumber: number;
  delayDays: number;
}

export interface ProjectedFollowUp {
  campaignId: string;
  campaignLeadId: string;
  stepNumber: number;
  at: Date;
}

export interface ProjectFollowUpsInput {
  rows: ForecastRow[];
  /** Follow-up steps per campaign, ascending. Step 1 is the campaign itself. */
  stepsByCampaign: Map<string, ForecastStep[]>;
  scheduleByCampaign: Map<string, SendingSchedule>;
  /** Shared day load, mutated as projections claim room. */
  load: DayLoad;
  capacityPerDay: number;
  now?: Date;
}

const DAY_MS = 86_400_000;

export function projectFollowUps({
  rows, stepsByCampaign, scheduleByCampaign, load, capacityPerDay, now = new Date(),
}: ProjectFollowUpsInput): ProjectedFollowUp[] {
  // Earliest mail claims the earliest slots. Input order is whatever the
  // database handed back, and letting that decide the calendar would make the
  // forecast change shape between two identical requests.
  const ordered = [...rows].sort(
    (a, b) => a.baseAt.getTime() - b.baseAt.getTime()
      || a.campaignLeadId.localeCompare(b.campaignLeadId),
  );

  const out: ProjectedFollowUp[] = [];

  for (const row of ordered) {
    const steps = (stepsByCampaign.get(row.campaignId) ?? [])
      .filter((s) => s.stepNumber > Math.max(row.currentStep, 1))
      .sort((a, b) => a.stepNumber - b.stepNumber);
    if (steps.length === 0) continue;

    const schedule = scheduleByCampaign.get(row.campaignId);

    // Each step's delay runs from where the PREVIOUS step actually landed, not
    // from the first touch — otherwise a step pushed out by a full day drags
    // its successor on top of it.
    let cursor = row.baseAt;
    for (const step of steps) {
      const earliest = new Date(
        Math.max(cursor.getTime() + step.delayDays * DAY_MS, now.getTime()),
      );

      let at: Date;
      if (schedule) {
        at = planNextStepAt({ load, schedule, earliest, capacityPerDay, now });
      } else {
        // No window to place within. Counting it on its flat date is still far
        // better than omitting it — an unplaceable campaign's mail is exactly
        // what the calendar was missing.
        at = earliest;
        const key = localDayKey(at, BUDGET_TIMEZONE);
        load.set(key, (load.get(key) ?? 0) + 1);
      }

      out.push({
        campaignId: row.campaignId,
        campaignLeadId: row.campaignLeadId,
        stepNumber: step.stepNumber,
        at,
      });
      cursor = at;
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
