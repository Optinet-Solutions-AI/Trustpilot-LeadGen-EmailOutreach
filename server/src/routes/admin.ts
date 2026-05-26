/**
 * Admin routes — cron-triggered maintenance endpoints. Auth happens at
 * the global authMiddleware (x-api-key header == config.apiSecretKey),
 * so Cloud Scheduler is configured to send that header at job creation
 * time. Mounted under /api/admin so it's clearly off the user-facing
 * surface even though the auth model is identical.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { runScreenshotCleanup } from '../services/screenshot-cleanup.js';
import { postAlert } from '../services/duplicate-send-monitor.js';
import { getSupabase } from '../lib/supabase.js';
import { sendEmail } from '../services/email-sender.js';
import { getAccountForUtilitySend } from '../services/sender-loader.js';

const router = Router();

// POST /api/admin/cleanup-screenshots — orphan + age sweep over the
// Supabase Storage `screenshots` bucket. Idempotent; safe to retry.
router.post('/cleanup-screenshots', async (_req: Request, res: Response) => {
  try {
    const summary = await runScreenshotCleanup();
    res.json({ success: true, data: summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/admin/test-duplicate-monitor — fires a synthetic alert through
// every configured channel (DUPLICATE_SEND_MONITOR_EMAIL,
// DUPLICATE_SEND_MONITOR_WEBHOOK_URL). Used to verify the alert path is
// wired up end-to-end without inserting fake lead_notes (which would
// violate the unique partial indexes from migration 040 anyway). Safe to
// run as often as needed — no DB writes, no side effects beyond the alert.
router.post('/test-duplicate-monitor', async (_req: Request, res: Response) => {
  const syntheticDuplicates = [{
    key: 'synthetic-test|synthetic-test|2',
    lead_id: '00000000-0000-0000-0000-000000000000',
    campaign_id: '00000000-0000-0000-0000-000000000000',
    step_number: '2',
    sends: 3,
    first_send: new Date(Date.now() - 8000).toISOString(),
    last_send: new Date().toISOString(),
  }];
  try {
    const result = await postAlert(syntheticDuplicates);
    res.json({
      success: true,
      data: {
        message: 'Synthetic alert fired. Check your configured channels.',
        delivered: result,
        configured: {
          email: !!process.env.DUPLICATE_SEND_MONITOR_EMAIL,
          webhook: !!process.env.DUPLICATE_SEND_MONITOR_WEBHOOK_URL,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/admin/test-claim-lock-with-warmup-peers
//
// End-to-end proof that the 2026-05 duplicate-send race is closed. Mimics
// the exact pattern the schedulers use:
//
//   1. Insert a test row into _claim_lock_smoke_test with scheduled_at=now
//   2. Spawn N goroutines that each:
//      a. Try to claim the row via conditional UPDATE — set scheduled_at to
//         now+10min WHERE id=test AND scheduled_at=original. Postgres row-
//         locks serialize the writes, so only one update affects 1 row.
//      b. If the claim won, send a real email via the configured warmup
//         peer sender (sender + recipient default to the email configured
//         in DUPLICATE_SEND_MONITOR_FROM_EMAIL / _EMAIL).
//      c. If the claim lost, record "lost_claim" and exit.
//   3. Also fires a unique-index regression test — tries to insert a
//      duplicate email_sent note for an existing (lead, campaign, step)
//      tuple. Migration 040's unique partial index MUST reject this.
//   4. Cleans up: delete the test row.
//
// Expected outcome: claims_won === 1, emails_sent === 1, unique_index_test === 'rejected'.
// Any other outcome means the fix is incomplete and the kill switch must
// stay on past 2026-06-12 until diagnosed.
//
// Body (all optional):
//   {
//     concurrency: number = 5,              // number of parallel claim attempts
//     senderEmail: string = env DUPLICATE_SEND_MONITOR_FROM_EMAIL,
//     recipientEmail: string = env DUPLICATE_SEND_MONITOR_EMAIL,
//   }
router.post('/test-claim-lock-with-warmup-peers', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { concurrency?: number; senderEmail?: string; recipientEmail?: string };
  const concurrency = Math.max(2, Math.min(20, body.concurrency ?? 5));
  const senderEmail = body.senderEmail ?? process.env.DUPLICATE_SEND_MONITOR_FROM_EMAIL ?? '';
  const recipientEmail = body.recipientEmail ?? process.env.DUPLICATE_SEND_MONITOR_EMAIL ?? '';

  if (!senderEmail || !recipientEmail) {
    res.status(400).json({
      success: false,
      error: 'senderEmail and recipientEmail required (or DUPLICATE_SEND_MONITOR_FROM_EMAIL + _EMAIL env vars must be set).',
    });
    return;
  }

  const senderAccount = await getAccountForUtilitySend(senderEmail);
  if (!senderAccount) {
    res.status(400).json({
      success: false,
      error: `Sender ${senderEmail} not found in email_accounts or missing creds.`,
    });
    return;
  }

  const supabase = getSupabase();
  const testId = randomUUID();
  const runMarker = `claim-lock-test-${Date.now()}`;
  const originalScheduledAt = new Date().toISOString();

  try {
    // Seed the test row
    const { error: insertErr } = await supabase
      .from('_claim_lock_smoke_test')
      .insert({ id: testId, scheduled_at: originalScheduledAt, marker: runMarker });
    if (insertErr) {
      res.status(500).json({ success: false, error: `Failed to seed test row: ${insertErr.message}` });
      return;
    }

    // Fire N concurrent claim-and-send attempts. Each attempt mirrors the
    // exact two-step pattern in sequence-scheduler.ts / campaign-scheduler.ts:
    //   1. Atomic conditional UPDATE
    //   2. If claim succeeded (1 row affected), do real work (send email)
    const claimDeadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const startedAt = Date.now();
    const attempts = await Promise.all(
      Array.from({ length: concurrency }, async (_, i): Promise<{
        attempt: number;
        outcome: 'sent' | 'lost_claim' | 'claim_error' | 'send_error';
        claimDurationMs: number;
        sendDurationMs?: number;
        error?: string;
        gmailMessageId?: string;
      }> => {
        const claimStart = Date.now();
        const { data: claimed, error: claimErr } = await supabase
          .from('_claim_lock_smoke_test')
          .update({ scheduled_at: claimDeadline })
          .eq('id', testId)
          .eq('scheduled_at', originalScheduledAt)
          .select('id');
        const claimDurationMs = Date.now() - claimStart;

        if (claimErr) {
          return { attempt: i, outcome: 'claim_error', claimDurationMs, error: claimErr.message };
        }
        if (!claimed || claimed.length === 0) {
          return { attempt: i, outcome: 'lost_claim', claimDurationMs };
        }

        // Claim won — fire a real send through the warmup peer
        const sendStart = Date.now();
        const subject = `[CLAIM LOCK TEST] ${runMarker} attempt ${i}`;
        const html = `
<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;">
<h2>Claim-Lock Concurrency Test</h2>
<p>This is attempt <strong>${i}</strong> of ${concurrency} parallel claim attempts against test row <code>${testId}</code>.</p>
<p>You should receive <strong>exactly one</strong> email from this run (run marker <code>${runMarker}</code>). If you see more than one, the claim lock is broken and the kill switch must stay on past 2026-06-12.</p>
<p>Started: ${new Date(startedAt).toISOString()}<br>This send: ${new Date().toISOString()}</p>
</body></html>`;
        try {
          const result = await sendEmail(recipientEmail, subject, html, {}, senderAccount);
          const sendDurationMs = Date.now() - sendStart;
          if (!result.success) {
            return { attempt: i, outcome: 'send_error', claimDurationMs, sendDurationMs, error: result.error ?? 'unknown' };
          }
          return { attempt: i, outcome: 'sent', claimDurationMs, sendDurationMs, gmailMessageId: result.messageId };
        } catch (err) {
          const sendDurationMs = Date.now() - sendStart;
          return { attempt: i, outcome: 'send_error', claimDurationMs, sendDurationMs, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    const claimsWon = attempts.filter((a) => a.outcome === 'sent' || a.outcome === 'send_error').length;
    const claimsLost = attempts.filter((a) => a.outcome === 'lost_claim').length;
    const emailsSent = attempts.filter((a) => a.outcome === 'sent').length;
    const claimErrors = attempts.filter((a) => a.outcome === 'claim_error').length;

    // Unique-index regression test — pick any existing email_sent note with
    // a step_number and try to insert an exact duplicate. Migration 040 must
    // reject it; that proves Layer 3 of the fix stack is enforced at the DB.
    let uniqueIndexResult: { ran: boolean; rejected: boolean; pgError?: string; note?: string } = { ran: false, rejected: false };
    try {
      const { data: sampleNote } = await supabase
        .from('lead_notes')
        .select('lead_id, type, metadata, content')
        .eq('type', 'email_sent')
        .not('metadata->>step_number', 'is', null)
        .limit(1)
        .maybeSingle();

      if (sampleNote) {
        const { error: dupErr } = await supabase
          .from('lead_notes')
          .insert({
            lead_id: sampleNote.lead_id,
            type: 'email_sent',
            metadata: sampleNote.metadata,
            content: `${(sampleNote.content as string | null) ?? ''} [unique-index probe ${runMarker}]`,
          });
        if (dupErr && /duplicate key|unique constraint|idx_lead_notes_unique/i.test(dupErr.message)) {
          uniqueIndexResult = { ran: true, rejected: true, pgError: dupErr.message };
        } else if (dupErr) {
          uniqueIndexResult = { ran: true, rejected: false, pgError: dupErr.message, note: 'Insert failed but error message does not match unique-constraint pattern' };
        } else {
          uniqueIndexResult = { ran: true, rejected: false, note: 'CRITICAL: duplicate insert SUCCEEDED — unique index is not in place. Migration 040 may not have run.' };
        }
      } else {
        uniqueIndexResult = { ran: false, rejected: false, note: 'No sample email_sent note with step_number available to probe.' };
      }
    } catch (err) {
      uniqueIndexResult = { ran: false, rejected: false, note: `Unique-index probe threw: ${err instanceof Error ? err.message : err}` };
    }

    // Cleanup — drop the test row regardless of outcome
    await supabase.from('_claim_lock_smoke_test').delete().eq('id', testId);

    const claimLockPassed = claimsWon === 1 && claimsLost === concurrency - 1 && claimErrors === 0;
    const uniqueIndexPassed = uniqueIndexResult.rejected;
    const passed = claimLockPassed && uniqueIndexPassed;

    res.json({
      success: true,
      data: {
        passed,
        verdict: passed
          ? '✅ Claim lock prevents the 2026-05 race AND unique index enforces dedup at DB layer.'
          : '⚠️ One or both layers did not behave as expected — DO NOT lift the kill switch on 2026-06-12 until investigated.',
        claim_lock_test: {
          passed: claimLockPassed,
          concurrency,
          expected: { claims_won: 1, claims_lost: concurrency - 1, emails_sent: 1, claim_errors: 0 },
          actual:   { claims_won: claimsWon, claims_lost: claimsLost, emails_sent: emailsSent, claim_errors: claimErrors },
          totalDurationMs: Date.now() - startedAt,
          attempts,
        },
        unique_index_test: uniqueIndexResult,
        sender: senderEmail,
        recipient: recipientEmail,
        testRowId: testId,
        runMarker,
      },
    });
  } catch (err) {
    // Best-effort cleanup
    try { await supabase.from('_claim_lock_smoke_test').delete().eq('id', testId); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
