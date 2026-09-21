/**
 * Claim a follow-up before sending it, not after.
 *
 * `lead_notes` carries a unique index on (lead, campaign, step) for exactly
 * one purpose: stop the same follow-up going out twice. It could not do that,
 * because it was consulted in the wrong order — `sendEmail` ran first and the
 * note was written afterwards, so the index rejected the RECORD of an email
 * that had already reached someone. Worse, the rejection threw before the row
 * was advanced, so the lead stayed due and was sent again on the next tick,
 * and the next.
 *
 * Measured from the logs, 18-20 September 2026: 208 duplicate follow-ups
 * delivered to 18 recipients, 48 copies to one address and 24 apiece to four
 * more, 191 of them on the 20th alone.
 *
 * Inserting the row first makes the index authoritative: whoever wins the
 * insert owns the send, everyone else steps aside without sending. It is the
 * only protection that works across instances — this service runs up to ten,
 * and an in-process guard cannot see the other nine.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface FollowUpKey {
  leadId: string;
  campaignId: string;
  stepNumber: number;
  /** Only used for the human-readable note text. */
  to: string;
}

export type ClaimResult =
  | { owned: true }
  | { owned: false; reason: 'already_claimed' };

/** Is this the unique-index rejection, rather than some other failure? */
export function isDuplicateClaim(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  if (e.code === '23505') return true;
  return typeof e.message === 'string'
    && e.message.includes('idx_lead_notes_unique_followup_send');
}

/**
 * Take ownership of one follow-up send. Returns `owned: false` when another
 * worker already holds it — in which case this worker must NOT send.
 */
export async function claimFollowUpSend(
  supabase: SupabaseClient,
  key: FollowUpKey,
): Promise<ClaimResult> {
  const { error } = await supabase.from('lead_notes').insert({
    lead_id: key.leadId,
    type: 'email_sent',
    content: `Follow-up step ${key.stepNumber} sent to ${key.to}`,
    metadata: { campaign_id: key.campaignId, step_number: key.stepNumber },
  });

  if (!error) return { owned: true };
  if (isDuplicateClaim(error)) return { owned: false, reason: 'already_claimed' };

  // Anything else is a real fault. Swallowing it would quietly stop every
  // follow-up in the batch while looking like ordinary contention.
  throw new Error((error as { message?: string }).message ?? 'claim failed');
}

/**
 * Give the claim back after a failed send, so the follow-up can be retried
 * instead of being recorded as sent when nothing left.
 */
export async function releaseFollowUpClaim(
  supabase: SupabaseClient,
  key: FollowUpKey,
): Promise<void> {
  await supabase
    .from('lead_notes')
    .delete()
    .eq('lead_id', key.leadId)
    .eq('type', 'email_sent')
    .eq('metadata->>campaign_id', key.campaignId)
    .eq('metadata->>step_number', String(key.stepNumber));
}
