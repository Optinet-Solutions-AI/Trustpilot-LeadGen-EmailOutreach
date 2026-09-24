import { describe, test, expect, vi } from 'vitest';
import { reconcileSentCount, decideAgainstLiveCount } from './send-counts.js';

/**
 * The cap counted `campaign_leads` rows filtered on `sent_at` and attributed
 * by `sender_email`. BOTH of those columns hold one value per lead-campaign
 * pair and are overwritten by every later step in the sequence, so:
 *
 *   - a lead that sends twice inside the 24h window counts once, and
 *   - an earlier step's send is re-attributed to whichever mailbox sent LAST,
 *     leaving the mailbox that really sent it short.
 *
 * Today that costs almost nothing, because every campaign uses a 3-day
 * follow-up delay and two sends for one lead cannot both land inside 24 hours
 * — measured 2026-09-24, exactly one lead in September managed it. That is an
 * accident of configuration, not a property of the code: set a delay to 1 day,
 * retry a send, or add a step, and the ceiling silently develops holes. 272
 * rows already carry a `sender_email` that no longer names the mailbox that
 * sent their first email.
 *
 * `lead_notes` is append-only — one row per email, never rewritten. Counting
 * it is the durable answer. The row count is kept as a FLOOR while older notes
 * are backfilling their sender, so the ceiling can only ever get stricter,
 * never looser, than it is today.
 */

describe('reconcileSentCount', () => {
  test('believes the log when it has seen more sends than the rows have', () => {
    // Two emails to one lead inside the window: the log has both, the row has
    // one. Trusting the row is how the 21st email leaves against a cap of 20.
    expect(reconcileSentCount(20, 19)).toBe(20);
  });

  test('keeps the row count as a floor while old notes have no sender yet', () => {
    // Notes written before the sender was recorded are invisible to the log
    // query. Taking the log alone would read 0 and reopen the whole cap.
    expect(reconcileSentCount(0, 18)).toBe(18);
  });

  test('agrees with either source when they agree', () => {
    expect(reconcileSentCount(12, 12)).toBe(12);
  });

  test('treats an unusable count as zero rather than as permission to send', () => {
    expect(reconcileSentCount(Number.NaN, 15)).toBe(15);
    expect(reconcileSentCount(-4, 0)).toBe(0);
  });
});

describe('the cap, counted from the log', () => {
  test('stops a send that the row count alone would have allowed', async () => {
    // The row count says 19 of 20 used, so the old cap sends. The log knows a
    // second email already went to one of those leads.
    const read = vi.fn(async () => reconcileSentCount(20, 19));
    await expect(decideAgainstLiveCount('grace@rp.rateupdigital.com', 20, read))
      .resolves.toEqual({ send: false, reason: 'at_cap', count: 20 });
  });
});
