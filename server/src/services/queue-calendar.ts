/**
 * Queue calendar — what is going to be sent, per day, before it happens.
 *
 * The app had no per-day forecast anywhere. The wizard showed a single-day
 * capacity figure, the analytics chart showed history bucketed in UTC, and
 * follow-ups appeared in neither. That is why 5 September 2026 was a surprise:
 * 22 first emails plus 21 follow-ups on one day against a cap of 30, with the
 * follow-up half invisible until after it had gone out.
 *
 * Two things this module insists on:
 *
 *  - **Follow-ups are counted.** They are separate from first touches in the
 *    output, because a day's shape ("mostly chasing" vs "mostly new") is what
 *    the operator actually needs to see, but they are never omitted.
 *
 *  - **Days belong to the campaign's timezone.** A campaign sending
 *    07:00-23:00 in Australia/Sydney runs from 21:00 UTC the previous day, so
 *    bucketing by UTC splits one sending day across two rows and makes both
 *    look under cap. Each entry carries its own campaign's timezone and is
 *    bucketed with it.
 */

import { localDayKey } from './schedule-engine.js';

export type QueueKind = 'first_touch' | 'follow_up';
/** `sent` already happened; `scheduled` is still ahead of the scheduler. */
export type QueueState = 'sent' | 'scheduled';

export interface QueueEntry {
  at: Date;
  kind: QueueKind;
  state: QueueState;
  campaignId: string;
  campaignName: string;
  /** The owning campaign's sending timezone — the day this entry belongs to. */
  timezone: string;
  /**
   * The owning campaign's per-account dailyLimit, when it has one. Capacity is
   * resolved per DAY from the campaigns actually sending that day, because a
   * quiet campaign's figure should not raise or lower another day's ceiling.
   */
  perAccountLimit?: number;
}

export interface QueueCampaignShare {
  id: string;
  name: string;
  count: number;
}

export interface QueueDay {
  /** YYYY-MM-DD in the campaign timezone the entries were bucketed with. */
  date: string;
  firstTouch: number;
  followUp: number;
  sent: number;
  scheduled: number;
  total: number;
  /** Daily ceiling across all mailboxes, or null when it can't be determined. */
  capacity: number | null;
  overCapacity: boolean;
  overBy: number;
  /** Which campaigns make up this day, busiest first. */
  campaigns: QueueCampaignShare[];
}

export interface SummarizeOptions {
  /** Active cold-sending mailboxes. Capacity is per-account times this. */
  senderCount: number;
  /**
   * The strictest warmup ramp across those mailboxes. A campaign figure cannot
   * exceed it at send time, so the calendar must not display a ceiling above
   * it either — old campaigns still hold figures like 150 and 200 per account,
   * which would render a 600/day cap that can never happen.
   */
  rampCap?: number | null;
}

export function summarizeQueueDays(
  entries: QueueEntry[],
  { senderCount, rampCap = null }: SummarizeOptions,
): QueueDay[] {
  const byDay = new Map<string, QueueEntry[]>();

  for (const e of entries) {
    const key = localDayKey(e.at, e.timezone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(e);
    else byDay.set(key, [e]);
  }

  const days: QueueDay[] = [];

  for (const [date, rows] of byDay) {
    const shares = new Map<string, QueueCampaignShare>();
    const limits: number[] = [];
    let firstTouch = 0;
    let followUp = 0;
    let sent = 0;
    let scheduled = 0;

    for (const r of rows) {
      if (r.kind === 'follow_up') followUp += 1;
      else firstTouch += 1;
      if (r.state === 'sent') sent += 1;
      else scheduled += 1;

      if (typeof r.perAccountLimit === 'number' && r.perAccountLimit > 0) {
        limits.push(r.perAccountLimit);
      }

      const share = shares.get(r.campaignId);
      if (share) share.count += 1;
      else shares.set(r.campaignId, { id: r.campaignId, name: r.campaignName, count: 1 });
    }

    const total = rows.length;
    const capacity = resolveDailyCapacity(limits, senderCount, rampCap);
    const over = capacity !== null && total > capacity;

    days.push({
      date,
      firstTouch,
      followUp,
      sent,
      scheduled,
      total,
      capacity,
      overCapacity: over,
      overBy: over ? total - (capacity as number) : 0,
      campaigns: [...shares.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name),
      ),
    });
  }

  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The day's ceiling across all mailboxes.
 *
 * `dailyLimit` is per account, so capacity is it times the mailbox count. When
 * campaigns on the same day disagree, the ceiling is the LARGEST of them, not
 * an average and not "unknown": at send time the cap is evaluated against the
 * figure on the row being sent, so a campaign allowing 30 per account really
 * does let a mailbox reach 30 that day regardless of a quieter campaign's 10.
 * Reporting the max is what the machine will actually permit.
 *
 * Null only when no campaign on that day states a figure at all.
 */
export function resolveDailyCapacity(
  perAccountLimits: Array<number | undefined>,
  senderCount: number,
  rampCap: number | null = null,
): number | null {
  const known = perAccountLimits.filter(
    (n): n is number => typeof n === 'number' && n > 0,
  );
  if (known.length === 0 || senderCount < 1) return null;
  // The largest figure among the day's campaigns, but never above the warmup
  // ramp — a campaign cannot buy past the ramp, so neither can the display.
  const perAccount = rampCap !== null && rampCap > 0
    ? Math.min(Math.max(...known), rampCap)
    : Math.max(...known);
  return perAccount * senderCount;
}
