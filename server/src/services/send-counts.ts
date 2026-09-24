/**
 * Per-account send counts and caps — shared by BOTH send loops.
 *
 * This lives in its own module because the campaign scheduler and the
 * sequence (follow-up) scheduler each need the same answer to "how much has
 * this mailbox already sent, and what is it allowed to send?". They used to
 * disagree: the campaign scheduler counted and capped, the follow-up loop did
 * neither, and the result was 43 emails against a 30/day cap on 2026-09-05.
 * One implementation, imported twice, is the fix that stays fixed.
 */

import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { getAccountDailyCap } from './rate-limiter.js';

export interface SentCount { daily: number; hourly: number }
export interface AccountCaps { dailyCap: number; hourlyCap: number }

/**
 * Real per-account send counts over the last 24h / 1h, keyed by lowercased
 * sender_email. Counts every `sent` row regardless of which step produced it,
 * which is what makes first-touch and follow-up share one budget.
 *
 * NOTE this is a ROLLING window, not a calendar day: capacity returns
 * gradually through the day rather than resetting at midnight.
 */
export async function loadSentCounts(): Promise<Record<string, SentCount>> {
  const counts: Record<string, SentCount> = {};
  const bump = (key: string | undefined, at: string, since1h: string, into: Record<string, SentCount>) => {
    if (!key) return;
    if (!into[key]) into[key] = { daily: 0, hourly: 0 };
    into[key].daily += 1;
    if (at >= since1h) into[key].hourly += 1;
  };

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since1h  = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const supabase = getSupabase();

    const [rows, log] = await Promise.all([
      supabase
        .from('campaign_leads')
        .select('sender_email, sent_at')
        .eq('status', 'sent')
        .gte('sent_at', since24h),
      supabase
        .from('lead_notes')
        .select('created_at, metadata')
        .eq('type', 'email_sent')
        .gte('created_at', since24h),
    ]);

    const fromRows: Record<string, SentCount> = {};
    for (const row of (rows.data ?? []) as Array<{ sender_email?: string; sent_at?: string }>) {
      if (!row.sent_at) continue;
      bump(row.sender_email?.toLowerCase(), row.sent_at, since1h, fromRows);
    }

    // The append-only side. A note written before the sending mailbox was
    // recorded has no sender and is skipped here; the row count above is what
    // covers it, and the merge below keeps whichever is stricter.
    const fromLog: Record<string, SentCount> = {};
    for (const n of (log.data ?? []) as Array<{ created_at?: string; metadata?: { sender_email?: string } }>) {
      if (!n.created_at) continue;
      bump(n.metadata?.sender_email?.toLowerCase(), n.created_at, since1h, fromLog);
    }

    for (const key of new Set([...Object.keys(fromRows), ...Object.keys(fromLog)])) {
      counts[key] = {
        daily:  Math.max(fromRows[key]?.daily  ?? 0, fromLog[key]?.daily  ?? 0),
        hourly: Math.max(fromRows[key]?.hourly ?? 0, fromLog[key]?.hourly ?? 0),
      };
    }
  } catch {
    // sender_email column missing — skip per-account enforcement
  }
  return counts;
}

/** Record a send against the in-memory counts so one tick can't overspend. */
export function recordSend(counts: Record<string, SentCount>, email: string | null | undefined): void {
  const key = email?.toLowerCase();
  if (!key) return;
  if (!counts[key]) counts[key] = { daily: 0, hourly: 0 };
  counts[key].daily  += 1;
  counts[key].hourly += 1;
}

/**
 * Configured daily + hourly caps for every active sender, keyed by lowercased
 * email. Credential-free, unlike the campaign scheduler's sender pool — the
 * follow-up path resolves its sender by address and only needs the numbers.
 */
export async function loadAccountCaps(): Promise<Record<string, AccountCaps>> {
  const caps: Record<string, AccountCaps> = {};
  try {
    const { data } = await getSupabase()
      .from('email_accounts')
      .select('email, daily_cap, hourly_cap')
      .eq('status', 'active');
    for (const a of (data ?? []) as Array<Record<string, unknown>>) {
      const email = (a.email as string | undefined)?.toLowerCase();
      if (!email) continue;
      caps[email] = {
        dailyCap: getAccountDailyCap({ daily_cap: (a.daily_cap         as number | null | undefined) ?? null }),
        hourlyCap: (a.hourly_cap as number | null | undefined) ?? config.rateLimits.hourlyCap,
      };
    }
  } catch {
    // Table/columns unavailable — caller falls back to its own defaults.
  }
  return caps;
}

/**
 * The stricter of the two counts.
 *
 * `campaign_leads` holds one `sent_at` and one `sender_email` per
 * lead-campaign pair, and both are overwritten by every later step. So a lead
 * that sends twice inside the window counts once, and an earlier step's send
 * is re-attributed to whichever mailbox sent last. `lead_notes` is
 * append-only — one row per email, never rewritten — and is the durable
 * answer, but notes written before the sender was recorded are invisible to
 * it. Keeping the row count as a floor means the ceiling can only get
 * stricter than it is today, never looser.
 */
export function reconcileSentCount(fromLog: number, fromRows: number): number {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return Math.max(safe(fromLog), safe(fromRows));
}

/**
 * How many emails one mailbox has really sent in the last 24 hours, read
 * fresh from the database rather than from a tick-start snapshot.
 *
 * Both sources are asked, because neither alone is complete: see
 * `reconcileSentCount`. A failure in EITHER throws, so the caller fails
 * closed — a silent zero would turn the cap into a suggestion.
 */
export async function liveSentCount(email: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const supabase = getSupabase();

  const [rows, log] = await Promise.all([
    supabase
      .from('campaign_leads')
      .select('id', { count: 'exact', head: true })
      .ilike('sender_email', email)
      .gte('sent_at', since),
    supabase
      .from('lead_notes')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'email_sent')
      .eq('metadata->>sender_email', email.toLowerCase())
      .gte('created_at', since),
  ]);

  if (rows.error) throw new Error(rows.error.message);
  if (log.error) throw new Error(log.error.message);
  return reconcileSentCount(log.count ?? 0, rows.count ?? 0);
}

export type LiveCapDecision =
  | { send: true }
  | { send: false; reason: 'at_cap'; count: number }
  | { send: false; reason: 'count_unavailable' }
  | { send: false; reason: 'no_sender' };

/**
 * The last check before an email leaves.
 *
 * The cap used to be judged against a snapshot taken once per tick. That is
 * safe only while a single tick runs at a time, and this service runs up to
 * ten instances — each snapshotting separately and each allowing a full cap
 * on top of the others. On 2026-09-19 two mailboxes reached 25 against a cap
 * of 20 and 70 emails went out against a ceiling of 60.
 *
 * Asking the database in the instant before the send narrows the race from a
 * whole tick to one send. It is not a distributed lock — two instances can
 * still both read 19 — but the worst case becomes cap + (instances - 1)
 * instead of cap x instances.
 */
export async function decideAgainstLiveCount(
  senderEmail: string | null | undefined,
  ceiling: number,
  read: (email: string) => Promise<number> = liveSentCount,
): Promise<LiveCapDecision> {
  const key = senderEmail?.trim().toLowerCase();
  if (!key) return { send: false, reason: 'no_sender' };

  let count: number;
  try {
    count = await read(key);
  } catch {
    // Fail closed. Assuming zero on a failed read turns the cap into a
    // suggestion for the duration of a database blip.
    return { send: false, reason: 'count_unavailable' };
  }

  return count >= ceiling ? { send: false, reason: 'at_cap', count } : { send: true };
}
