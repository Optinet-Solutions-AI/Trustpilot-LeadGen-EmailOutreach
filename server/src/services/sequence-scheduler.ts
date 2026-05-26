/**
 * Sequence Scheduler — Background job that sends follow-up emails when they're due.
 *
 * For direct/Gmail mode:
 *   Polls campaign_leads where next_step_at <= now() and sequence not completed/paused.
 *   Renders the appropriate step template, sends the email, advances the lead to the next step.
 *
 * For platform mode (Instantly):
 *   Follow-ups are handled natively by the platform — this scheduler is not needed.
 *   The platform-campaign-sender pushes all steps upfront.
 */

import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { getSupabase } from '../lib/supabase.js';
import { getCampaignSteps } from '../db/campaign-steps.js';
import { updateCampaign } from '../db/campaigns.js';
import { createNote } from '../db/notes.js';
import { renderAndSpin } from './template-engine.js';
import { sendEmail } from './email-sender.js';
import { rateLimiter } from './rate-limiter.js';
import { applyTestMode } from './test-mode.js';
import { getSenderAccountByEmail } from './sender-loader.js';

const POLL_INTERVAL = 60_000; // check every 60 seconds

/**
 * Start the sequence scheduler loop.
 * Only runs in direct/Gmail mode — platform mode handles sequences natively.
 */
export function startSequenceScheduler() {
  if (config.emailPlatform !== 'none') {
    console.log('[SequenceScheduler] Platform mode active — follow-ups handled by platform, scheduler skipped.');
    return;
  }

  console.log('[SequenceScheduler] Started (polling every 60s for due follow-ups)');

  setInterval(async () => {
    try {
      await processDueFollowUps();
    } catch (err) {
      console.error('[SequenceScheduler] Error:', err instanceof Error ? err.message : err);
    }
  }, POLL_INTERVAL);
}

/**
 * Find all campaign_leads with a due next_step_at and process them.
 */
async function processDueFollowUps() {
  // Hard kill switch — set EMAIL_SENDING_PAUSED_UNTIL=YYYY-MM-DDTHH:MM:SSZ on
  // the Cloud Run service to halt every tick until that timestamp passes.
  // Used during deliverability incidents so the scheduler can't accidentally
  // resume sending if some DB state gets flipped back to active.
  const pauseUntil = process.env.EMAIL_SENDING_PAUSED_UNTIL;
  if (pauseUntil) {
    const pauseDate = new Date(pauseUntil);
    if (!Number.isNaN(pauseDate.getTime()) && pauseDate.getTime() > Date.now()) {
      console.log(`[SequenceScheduler] Sending paused until ${pauseDate.toISOString()} — skipping tick`);
      return;
    }
  }

  const supabase = getSupabase();

  // Find leads with due follow-ups
  const { data: dueLeads, error } = await supabase
    .from('campaign_leads')
    .select('*, leads(*)')
    .lte('next_step_at', new Date().toISOString())
    .eq('sequence_completed', false)
    .eq('sequence_paused', false)
    .not('next_step_at', 'is', null)
    .limit(20); // process in small batches

  if (error) {
    console.error('[SequenceScheduler] Query error:', error.message);
    return;
  }

  if (!dueLeads || dueLeads.length === 0) return;

  console.log(`[SequenceScheduler] ${dueLeads.length} follow-ups due`);

  for (const cl of dueLeads) {
    try {
      await sendFollowUp(cl);
    } catch (err) {
      console.error(`[SequenceScheduler] Failed for ${cl.email_used}:`, err instanceof Error ? err.message : err);
    }

    // Small delay between sends
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Send a single follow-up email for a campaign lead.
 */
async function sendFollowUp(cl: Record<string, unknown>) {
  const supabase = getSupabase();
  const id = cl.id as string;
  const originalNextStepAt = cl.next_step_at as string;

  // Atomic claim — prevent overlapping poll ticks from double-sending the
  // same follow-up. The loop body (rate-limiter wait + SMTP send + IMAP
  // append + DB writes) routinely exceeds the 60s polling interval; before
  // this claim, a second tick would re-SELECT the same row (its next_step_at
  // wasn't updated until end-of-function) and fire another send. Postgres
  // row-locks the UPDATE, so only one tick's conditional WHERE matches; the
  // loser's UPDATE affects zero rows and bails. The 10-minute claim window
  // auto-retries any send that dies mid-flight without manual intervention.
  const claimDeadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('campaign_leads')
    .update({ next_step_at: claimDeadline })
    .eq('id', id)
    .eq('next_step_at', originalNextStepAt)
    .select('id');
  if (claimErr) {
    console.error(`[SequenceScheduler] Claim error for ${cl.email_used}:`, claimErr.message);
    return;
  }
  if (!claimed || claimed.length === 0) {
    console.log(`[SequenceScheduler] Lost claim for ${cl.email_used} — another tick is processing this lead`);
    return;
  }

  const campaignId = cl.campaign_id as string;
  const currentStep = (cl.current_step as number) || 1;
  const nextStepNumber = currentStep + 1;
  const lead = cl.leads as Record<string, unknown>;

  // Idempotency guard — refuse to send if an email_sent note already exists
  // for this exact (lead, campaign, step_number) tuple. The claim above
  // prevents *concurrent* duplicates; this catches the offline failure
  // where a previous tick sent the email but crashed before its post-send
  // UPDATE — the row would otherwise be re-eligible after the 10-minute
  // claim expires and double-send. The DB-side unique partial index on
  // lead_notes (migration 044) provides the same guarantee at the storage
  // layer if this application check is ever bypassed.
  const { data: existingNote } = await supabase
    .from('lead_notes')
    .select('id')
    .eq('lead_id', cl.lead_id as string)
    .eq('type', 'email_sent')
    .eq('metadata->>campaign_id', campaignId)
    .eq('metadata->>step_number', String(nextStepNumber))
    .limit(1)
    .maybeSingle();
  if (existingNote) {
    console.warn(`[SequenceScheduler] Refusing duplicate send — note exists for ${cl.email_used} step ${nextStepNumber}; advancing row to clear from queue`);
    const stepsForAdvance = await getCampaignSteps(campaignId);
    const nextNextStep = stepsForAdvance.find((s) => s.step_number === nextStepNumber + 1);
    const nextStepAt = nextNextStep
      ? new Date(Date.now() + nextNextStep.delay_days * 24 * 60 * 60 * 1000).toISOString()
      : null;
    await supabase
      .from('campaign_leads')
      .update({
        current_step: nextStepNumber,
        next_step_at: nextStepAt,
        sequence_completed: !nextNextStep,
      })
      .eq('id', id);
    return;
  }

  // Check if lead has already replied — auto-pause sequence
  if (cl.status === 'replied') {
    await supabase
      .from('campaign_leads')
      .update({ sequence_paused: true, next_step_at: null })
      .eq('id', cl.id);
    console.log(`[SequenceScheduler] Lead ${cl.email_used} replied — pausing sequence`);
    return;
  }

  // Get the step template
  const steps = await getCampaignSteps(campaignId);
  const step = steps.find((s) => s.step_number === nextStepNumber);

  if (!step) {
    // No more steps — mark sequence as completed
    await supabase
      .from('campaign_leads')
      .update({ sequence_completed: true, next_step_at: null })
      .eq('id', cl.id);
    console.log(`[SequenceScheduler] Lead ${cl.email_used} — no step ${nextStepNumber}, sequence completed`);
    return;
  }

  // Wait for rate limiter
  await rateLimiter.waitUntilCanSend('[SequenceScheduler] ');

  // Render template with lead data. Force a single "Re:" prefix on follow-ups
  // so the recipient's MUA groups the message into the original conversation
  // (subject is one of the three threading signals Gmail/Outlook use, along
  // with In-Reply-To and References — set below). If the operator already
  // wrote "Re:" into the template, leave it alone to avoid "Re: Re: Re:".
  const renderedSubject = renderAndSpin(step.template_subject, lead);
  const subject = /^re:\s/i.test(renderedSubject)
    ? renderedSubject
    : `Re: ${renderedSubject}`;
  const html = renderAndSpin(step.template_body, lead);

  // Check for screenshot
  const leadScreenshot = lead.screenshot_path ? String(lead.screenshot_path) : '';
  let screenshotPath: string | undefined;
  if (leadScreenshot) {
    if (leadScreenshot.startsWith('http')) {
      screenshotPath = leadScreenshot;
    } else {
      const localPath = path.resolve(config.projectRoot, '.tmp', 'screenshots', path.basename(leadScreenshot));
      if (fs.existsSync(localPath)) screenshotPath = localPath;
    }
  }

  // Apply test mode
  const isTestMode = config.testMode.enabled;
  const transformed = applyTestMode(
    { to: cl.email_used as string, subject, html },
    isTestMode
  );

  // Reuse the same sender that handled the initial send so the recipient
  // sees a coherent thread (same From, matching Reply-To, and per-account
  // caps continue to track this lead's volume). Falls back to env default
  // when campaign_leads.sender_email is empty (pre-feature rows) or the
  // account is no longer active — keeps old leads working unchanged.
  const recordedSenderEmail = (cl.sender_email as string | null | undefined) ?? null;
  const senderAccount = recordedSenderEmail ? await getSenderAccountByEmail(recordedSenderEmail) : null;
  if (recordedSenderEmail && !senderAccount) {
    console.warn(`[SequenceScheduler] sender_email=${recordedSenderEmail} not loadable — falling back to env default for follow-up to ${cl.email_used}`);
  } else if (senderAccount) {
    console.log(`[SequenceScheduler] Reusing initial sender ${senderAccount.email} for follow-up step ${nextStepNumber} → ${cl.email_used}`);
  }

  // Threading signals — pulled from the original send recorded on this row.
  //  - originalMessageId: RFC822 Message-ID for SMTP/IMAP path. Empty string
  //    for Gmail-OAuth sends, where campaign_leads.gmail_message_id holds the
  //    opaque Gmail internal ID, not a real RFC822 ID; passing it as
  //    In-Reply-To would be useless (the recipient's MUA can't resolve it).
  //  - gmailThreadId: Gmail-side thread grafting. Always set when we have
  //    one — Gmail accepts threadId for any account, ignored elsewhere.
  // All follow-up steps reference STEP 1's IDs so every send in the sequence
  // grafts back onto the original conversation. We deliberately don't update
  // gmail_message_id on this row — reply-tracker matches replies by step 1's
  // ID, and overwriting it would orphan any in-flight replies to earlier
  // steps.
  const senderAuthType = (senderAccount as { auth_type?: string } | null | undefined)?.auth_type;
  const isGmailSender = !senderAuthType || senderAuthType === 'gmail_oauth' || senderAuthType === 'app_password';
  const recordedMessageId = (cl.gmail_message_id as string | null) ?? '';
  const recordedThreadId = (cl.gmail_thread_id as string | null) ?? '';
  // For Gmail accounts the stored gmail_message_id is Gmail's internal numeric
  // ID, not an RFC822 Message-ID — never thread by it. SMTP accounts store
  // the real Message-ID, which IS valid for In-Reply-To.
  const inReplyTo = isGmailSender ? '' : recordedMessageId;
  const gmailThreadId = recordedThreadId || '';

  // Send the email
  const result = await sendEmail(
    transformed.to,
    transformed.subject,
    transformed.html,
    {
      screenshotPath,
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
      ...(gmailThreadId ? { gmailThreadId } : {}),
    },
    senderAccount ?? undefined,
  );

  if (result.success) {
    rateLimiter.recordSend();

    // Find the NEXT follow-up step after this one
    const nextNextStep = steps.find((s) => s.step_number === nextStepNumber + 1);
    const nextStepAt = nextNextStep
      ? new Date(Date.now() + nextNextStep.delay_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Update campaign_lead: advance step, set next due date.
    // Also persist the sender we used (or env default) so future follow-ups
    // can keep using the same account — covers leads whose original
    // sender_email column was empty before this feature shipped.
    const sentBySenderEmail = senderAccount?.email ?? config.gmail.fromEmail ?? null;
    const updatePayload: Record<string, unknown> = {
      current_step: nextStepNumber,
      next_step_at: nextStepAt,
      sequence_completed: !nextNextStep,
      sent_at: new Date().toISOString(),
    };
    if (sentBySenderEmail && !recordedSenderEmail) {
      updatePayload.sender_email = sentBySenderEmail;
    }
    const { error: updateErr } = await supabase
      .from('campaign_leads')
      .update(updatePayload)
      .eq('id', cl.id);
    // Post-send UPDATE failure is the stuck-row failure mode from the
    // 2026-05 incident: any error here would have left next_step_at sitting
    // 10 minutes in the future (the claim marker), so once the claim
    // expired the row got picked up and re-sent — repeatedly. Always
    // attempt the minimal advance-step fallback so the row exits the
    // queue; log loud if even the fallback fails so an operator can see it.
    if (updateErr) {
      console.warn(`[SequenceScheduler] Primary post-send UPDATE failed for ${cl.email_used}: ${updateErr.message}. Falling back to minimal step-advance update.`);
      const { error: fallbackErr } = await supabase
        .from('campaign_leads')
        .update({
          current_step: nextStepNumber,
          next_step_at: nextStepAt,
          sequence_completed: !nextNextStep,
          sent_at: updatePayload.sent_at,
        })
        .eq('id', cl.id);
      if (fallbackErr) {
        console.error(`[SequenceScheduler] CRITICAL: post-send fallback UPDATE failed for ${cl.email_used} step ${nextStepNumber}. Email was sent but row remains in claimed state. Manual reconciliation needed.`, fallbackErr.message);
      }
    }

    // Update campaign totals
    const campaigns = await supabase
      .from('campaigns')
      .select('total_sent')
      .eq('id', campaignId)
      .single();
    if (campaigns.data) {
      await updateCampaign(campaignId, { total_sent: (campaigns.data.total_sent || 0) + 1 });
    }

    // Activity note
    await createNote(cl.lead_id as string, {
      type: 'email_sent',
      content: `Follow-up step ${nextStepNumber} sent to ${cl.email_used}${isTestMode ? ' [TEST MODE]' : ''}`,
      metadata: { campaign_id: campaignId, step_number: nextStepNumber },
    });

    console.log(`[SequenceScheduler] Sent step ${nextStepNumber} to ${cl.email_used}`);
  } else {
    console.warn(`[SequenceScheduler] Failed to send step ${nextStepNumber} to ${cl.email_used}: ${result.error}`);
  }
}
