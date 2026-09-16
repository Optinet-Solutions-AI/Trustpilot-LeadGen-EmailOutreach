/**
 * Per-day sent and replied counts, from events rather than rows.
 *
 * The chart used to bucket `campaign_leads.sent_at`, which is ONE column per
 * lead-campaign pair and is overwritten by every later step in the sequence. A
 * first email sent on 3 September therefore disappeared from the 3rd the
 * moment its follow-up went out on the 9th, and was counted again on the 9th.
 * Measured 2026-09-16 across 24 Aug - 16 Sep: 483 emails really went out, the
 * chart showed 310, and five days that had really sent 21 to 30 emails each
 * read zero. The operator concluded sending had stalled. It had not.
 *
 * `lead_notes` records one row per actual send (and one per reply) and is
 * never overwritten, so counting those answers the question the chart asks.
 * Verified complete before the switch: across every campaign, the log never
 * holds fewer sends than there are stamped rows.
 */

export interface DailyActivityInput {
  /** ISO timestamps, one per email actually sent. */
  sends: string[];
  /** ISO timestamps, one per human reply received. */
  replies: string[];
  /** First day, inclusive (YYYY-MM-DD, UTC). */
  start: string;
  /** Last day, inclusive (YYYY-MM-DD, UTC). */
  end: string;
}

export interface DailyActivityDay {
  date: string;
  sent: number;
  replied: number;
}

export interface DailyActivity {
  days: DailyActivityDay[];
  totals: { sent: number; replied: number };
}

/** The UTC calendar day an instant belongs to, or null if it isn't a date. */
function utcDay(iso: string): string | null {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

export function summariseDailyActivity({
  sends, replies, start, end,
}: DailyActivityInput): DailyActivity {
  const tally = (times: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const iso of times) {
      const day = utcDay(iso);
      // A malformed timestamp is dropped rather than taking the report down —
      // one bad row should not cost the operator the whole month.
      if (!day || day < start || day > end) continue;
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return counts;
  };

  const sentBy = tally(sends);
  const repliedBy = tally(replies);

  const days: DailyActivityDay[] = [];
  for (
    let cursor = new Date(`${start}T00:00:00.000Z`);
    cursor.toISOString().slice(0, 10) <= end;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    days.push({
      date,
      sent: sentBy.get(date) ?? 0,
      replied: repliedBy.get(date) ?? 0,
    });
  }

  return {
    days,
    totals: {
      sent: days.reduce((n, d) => n + d.sent, 0),
      replied: days.reduce((n, d) => n + d.replied, 0),
    },
  };
}
