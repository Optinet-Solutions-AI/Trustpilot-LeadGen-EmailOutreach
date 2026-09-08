/**
 * Follow-up send budget — the gate the sequence scheduler was missing.
 *
 * Follow-ups used to be dispatched by their own loop with no per-account cap
 * and no sending-window check. On 2026-09-05 that put 43 emails out against a
 * 30/day cap: 22 first-touch sends (correctly capped) plus 21 follow-ups that
 * nobody counted, 20 of them onto a single mailbox which finished the day at
 * 23 sends against a limit of 10.
 *
 * The model is ONE SHARED BUDGET. `sentCounts` comes from campaign_leads and
 * does not distinguish a first-touch send from a follow-up, so both draw on
 * the same per-account allowance. Follow-ups effectively take priority: this
 * gate runs on its own poll tick, and whatever it spends is already visible to
 * the campaign scheduler's `pickSender` on the next tick, which then backs off
 * on its own. A started conversation outranks a new one.
 *
 * A follow-up NEVER switches sender to find headroom. The recipient sees a
 * thread, and swapping the From address mid-thread is worse than arriving a
 * few hours late — so a capped account defers rather than handing off.
 *
 * NOTE on "daily": `sentCounts.daily` is a ROLLING 24-hour count (see
 * loadSentCounts), not a calendar-day count. That is pre-existing behaviour
 * shared with first-touch sends and is deliberately left alone here; it means
 * capacity returns gradually through the day rather than resetting at
 * midnight, which is why a cap defer retries in an hour rather than tomorrow.
 */

import { isWithinSendingWindow, nextWindowOpening, type SendingSchedule } from './schedule-engine.js';

export type FollowUpDeferReason = 'daily_cap' | 'hourly_cap' | 'outside_window';

export type FollowUpDecision =
  | { action: 'send'; viaEnvAccount: boolean }
  | { action: 'defer'; reason: FollowUpDeferReason; until: Date };

export interface FollowUpBudgetInput {
  /** campaign_leads.sender_email — the account that sent the previous step. */
  senderEmail: string | null;
  /** Per-account sent counts, keyed by lowercased email. Rolling 24h / 1h. */
  sentCounts: Record<string, { daily: number; hourly: number }>;
  /**
   * The campaign's own per-account figure (sending_schedule.dailyLimit).
   *
   * It can only ever LOWER the ceiling. The account's warmup ramp is a hard
   * limit the campaign cannot buy its way past: a domain still warming up is
   * protected from an operator typing a bigger number, which is the whole
   * point of a ramp. The effective ceiling is min(campaign, ramp).
   */
  perAccountDailyLimit: number | undefined;
  /** The account's ramped daily cap, used when the campaign sets no figure. */
  accountDailyCap: number;
  accountHourlyCap: number;
  /** The campaign's window, or null when it has none (then no window gate). */
  schedule: SendingSchedule | null;
  now: Date;
}

/** Backoff for a capped account: an hour on, snapped into the next window. */
function retryAfterCap(schedule: SendingSchedule | null, now: Date): Date {
  const inAnHour = new Date(now.getTime() + 60 * 60 * 1000);
  return schedule ? nextWindowOpening(schedule, inAnHour) : inAnHour;
}

export function decideFollowUpSend(input: FollowUpBudgetInput): FollowUpDecision {
  const {
    senderEmail, sentCounts, perAccountDailyLimit,
    accountDailyCap, accountHourlyCap, schedule, now,
  } = input;

  // Caps are checked BEFORE the window: deferring to the next opening does
  // nothing for an account that is already spent, and reporting the window as
  // the reason would hide the real constraint from the logs.
  if (senderEmail) {
    const used = sentCounts[senderEmail.toLowerCase()] ?? { daily: 0, hourly: 0 };
    // Clamp, never override: the warmup ramp wins whenever it is stricter.
    const dailyCeiling = Math.min(
      perAccountDailyLimit ?? Number.POSITIVE_INFINITY,
      accountDailyCap,
    );
    if (used.daily >= dailyCeiling) {
      return { action: 'defer', reason: 'daily_cap', until: retryAfterCap(schedule, now) };
    }
    if (used.hourly >= accountHourlyCap) {
      return { action: 'defer', reason: 'hourly_cap', until: retryAfterCap(schedule, now) };
    }
  }

  if (schedule && !isWithinSendingWindow(schedule, now)) {
    return { action: 'defer', reason: 'outside_window', until: nextWindowOpening(schedule, now) };
  }

  // A row with no recorded sender predates per-account tracking and falls back
  // to the env account, which the caller still gates through the env limiter.
  return { action: 'send', viaEnvAccount: senderEmail === null };
}
