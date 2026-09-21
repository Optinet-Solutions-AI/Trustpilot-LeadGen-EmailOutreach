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
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since1h  = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data } = await getSupabase()
      .from('campaign_leads')
      .select('sender_email, sent_at')
      .eq('status', 'sent')
      .gte('sent_at', since24h);
    for (const row of (data ?? []) as Array<{ sender_email?: string; sent_at?: string }>) {
      const key = row.sender_email?.toLowerCase();
      if (!key || !row.sent_at) continue;
      if (!counts[key]) counts[key] = { daily: 0, hourly: 0 };
      counts[key].daily += 1;
      if (row.sent_at >= since1h) counts[key].hourly += 1;
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
 * How many emails one mailbox has really sent in the last 24 hours, read
 * fresh from the database rather than from a tick-start snapshot.
 */
export async function liveSentCount(email: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await getSupabase()
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .ilike('sender_email', email)
    .gte('sent_at', since);
  if (error) throw new Error(error.message);
  return count ?? 0;
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
