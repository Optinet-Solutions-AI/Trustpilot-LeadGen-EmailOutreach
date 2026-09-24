import { describe, test, expect, vi } from 'vitest';
import { claimFollowUpSend, releaseFollowUpClaim, isDuplicateClaim } from './follow-up-claim.js';

/**
 * The unique index on (lead, campaign, step) was added to stop the same
 * follow-up going out twice. It could not, because it was consulted in the
 * wrong order: the email was sent first and the log row written afterwards,
 * so the index rejected the RECORD of an email that had already left.
 *
 * Measured from the logs, 18-20 September: 208 duplicate follow-ups were
 * delivered to 18 recipients — 48 copies to one address, 24 apiece to four
 * others. Every one of those appears in the logs as
 * "duplicate key ... idx_lead_notes_unique_followup_send", and every one is
 * an email that reached a real person.
 *
 * Writing the row BEFORE the send turns the index into what it was meant to
 * be: whoever inserts it owns the send, and everyone else steps aside. If the
 * send then fails, the claim is released so a later tick can retry.
 */

const OK = { error: null };
const DUPLICATE = { error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_lead_notes_unique_followup_send"' } };
const OTHER = { error: { code: '42501', message: 'permission denied' } };

function fakeDb(result: { error: unknown }) {
  const insert = vi.fn(async () => result);
  return { insert, client: { from: () => ({ insert }) } };
}

describe('claimFollowUpSend', () => {
  test('an uncontested claim succeeds, so this worker may send', async () => {
    const db = fakeDb(OK);
    const claim = await claimFollowUpSend(db.client as never, {
      leadId: 'l1', campaignId: 'c1', stepNumber: 2, to: 'a@b.com',
    });
    expect(claim).toEqual({ owned: true });
    expect(db.insert).toHaveBeenCalledOnce();
  });

  test('a duplicate means someone else owns it — do NOT send', async () => {
    // This is the whole point: the second worker finds out BEFORE sending.
    const db = fakeDb(DUPLICATE);
    const claim = await claimFollowUpSend(db.client as never, {
      leadId: 'l1', campaignId: 'c1', stepNumber: 2, to: 'a@b.com',
    });
    expect(claim).toEqual({ owned: false, reason: 'already_claimed' });
  });

  test('the claim row carries the step, or the index cannot see it', async () => {
    const db = fakeDb(OK);
    await claimFollowUpSend(db.client as never, {
      leadId: 'l1', campaignId: 'c9', stepNumber: 3, to: 'a@b.com',
    });
    const written = db.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(written.type).toBe('email_sent');
    expect(written.lead_id).toBe('l1');
    expect(written.metadata).toEqual({ campaign_id: 'c9', step_number: 3, sender_email: null });
  });

  test('records which mailbox sent it, lowercased, because the cap counts this log', async () => {
    // campaign_leads.sender_email is overwritten by the next step, so it
    // cannot say which mailbox sent an EARLIER email. The note can, and it is
    // never rewritten — see reconcileSentCount in send-counts.ts.
    const db = fakeDb(OK);
    await claimFollowUpSend(db.client as never, {
      leadId: 'l1', campaignId: 'c9', stepNumber: 2, to: 'a@b.com',
      senderEmail: '  Grace@RP.RateUpDigital.com ',
    });
    const written = db.insert.mock.calls[0][0] as Record<string, unknown>;
    expect((written.metadata as Record<string, unknown>).sender_email)
      .toBe('grace@rp.rateupdigital.com');
  });

  test('an unexpected database error is raised, not mistaken for a duplicate', async () => {
    // Swallowing this would silently stop follow-ups going out at all.
    const db = fakeDb(OTHER);
    await expect(claimFollowUpSend(db.client as never, {
      leadId: 'l1', campaignId: 'c1', stepNumber: 2, to: 'a@b.com',
    })).rejects.toThrow('permission denied');
  });
});

describe('isDuplicateClaim', () => {
  test('recognises the unique-violation code', () => {
    expect(isDuplicateClaim(DUPLICATE.error)).toBe(true);
  });

  test('recognises it by constraint name even without the code', () => {
    expect(isDuplicateClaim({ message: 'duplicate key value violates unique constraint "idx_lead_notes_unique_followup_send"' })).toBe(true);
  });

  test('does not mistake other failures for a duplicate', () => {
    expect(isDuplicateClaim(OTHER.error)).toBe(false);
    expect(isDuplicateClaim(null)).toBe(false);
    expect(isDuplicateClaim({ message: 'connection reset' })).toBe(false);
  });
});

describe('releaseFollowUpClaim', () => {
  test('a claim is withdrawn when the send fails, so the lead is not skipped for ever', async () => {
    const del = vi.fn(() => ({ eq: eqChain }));
    const eqChain: (...a: unknown[]) => unknown = vi.fn(() => ({ eq: eqChain, then: undefined }));
    const client = { from: vi.fn(() => ({ delete: del })) };
    await releaseFollowUpClaim(client as never, {
      leadId: 'l1', campaignId: 'c1', stepNumber: 2, to: 'a@b.com',
    });
    expect(client.from).toHaveBeenCalledWith('lead_notes');
    expect(del).toHaveBeenCalled();
  });
});
