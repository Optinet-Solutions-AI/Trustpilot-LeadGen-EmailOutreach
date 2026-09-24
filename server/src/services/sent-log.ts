/**
 * The emails that actually left, one entry per send.
 *
 * The send queue calendar used to read `campaign_leads.sent_at`. That is ONE
 * column per lead-campaign pair, and every later step in the sequence
 * overwrites it, so a row contributes exactly one "sent" mark however many
 * emails it has really sent — and that mark moves forward each time, emptying
 * the day the first email actually went out.
 *
 * Measured 2026-09-24 across 1-23 September: 675 emails really went out and
 * the calendar showed 376. The 16th displayed nothing on a day that sent 44;
 * the 15th showed 10 against a real 63. 1,563 of 2,085 sent rows had already
 * had their original date overwritten by a follow-up.
 *
 * This is the same defect the Daily Activity chart had — fixed there on
 * 2026-09-16 by counting `lead_notes`, and left in place here. `lead_notes`
 * holds one immutable row per email sent, with the campaign in
 * `metadata.campaign_id` and the sequence step in `metadata.step_number`
 * (absent on a first touch). Verified before the switch: every one of the 728
 * sends since 1 August carries a campaign id.
 */

import { getSupabase } from '../lib/supabase.js';
import { selectAllRows } from '../lib/paginate.js';

export interface SentNoteRow {
  lead_id: string;
  created_at: string;
  metadata: { campaign_id?: string; step_number?: number } | null;
}

export interface SentEmail {
  campaignId: string;
  leadId: string;
  /** When the email actually left. */
  at: Date;
  /** 1 for the first touch; 2+ for a follow-up. */
  stepNumber: number;
  kind: 'first_touch' | 'follow_up';
}

/** One entry per email in the log, chronological. */
export function sentEmailsFromNotes(rows: SentNoteRow[]): SentEmail[] {
  const out: SentEmail[] = [];

  for (const r of rows) {
    const campaignId = r.metadata?.campaign_id;
    // Without a campaign the send cannot be attributed to a calendar cell, and
    // guessing one would misstate that campaign's share of the day.
    if (!campaignId) continue;

    const at = new Date(r.created_at);
    if (Number.isNaN(at.getTime())) continue;

    // A first touch is logged with no step number at all, so an absent one
    // means step 1 — reading it as 0 or discarding the row would drop 57% of
    // the log.
    const stepNumber = typeof r.metadata?.step_number === 'number' && r.metadata.step_number > 0
      ? r.metadata.step_number
      : 1;

    out.push({
      campaignId,
      leadId: r.lead_id,
      at,
      stepNumber,
      kind: stepNumber > 1 ? 'follow_up' : 'first_touch',
    });
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Every send logged in a window. Paged, because PostgREST caps a response at
 * 1,000 rows however high the limit is — the trap that made the queue
 * re-pacer rewrite 11 dates out of 692 and report success.
 */
export async function loadSentEmails(loIso: string, hiIso: string): Promise<SentEmail[]> {
  const supabase = getSupabase();
  const rows = await selectAllRows<SentNoteRow>((from, to) => supabase
    .from('lead_notes')
    .select('lead_id, created_at, metadata')
    .eq('type', 'email_sent')
    .gte('created_at', loIso)
    .lte('created_at', hiIso)
    .order('created_at', { ascending: true })
    .range(from, to));
  return sentEmailsFromNotes(rows);
}

/**
 * The stricter of two count maps, key by key.
 *
 * Every per-day and per-mailbox send count in this service is now taken from
 * BOTH sources: `campaign_leads`, which under-reports as soon as a sequence
 * moves on, and `lead_notes`, which is append-only but silent for entries
 * written before the sending mailbox was recorded. Taking the higher of the
 * two is the safety property — a count can only ever come out stricter than
 * today's behaviour, never looser, whichever source is incomplete.
 */
export function mergeCounts(
  fromRows: ReadonlyMap<string, number>,
  fromLog: ReadonlyMap<string, number>,
): Map<string, number> {
  const safe = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  const out = new Map<string, number>();
  for (const key of new Set([...fromRows.keys(), ...fromLog.keys()])) {
    out.set(key, Math.max(safe(fromRows.get(key)), safe(fromLog.get(key))));
  }
  return out;
}

/**
 * Sends per day in a window, from the log, bucketed with the caller's own day
 * rule so it lines up with whatever it is being merged into.
 */
export async function loadSentCountsByDay(
  loIso: string,
  hiIso: string,
  dayKey: (at: Date) => string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const email of await loadSentEmails(loIso, hiIso)) {
    const key = dayKey(email.at);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}
