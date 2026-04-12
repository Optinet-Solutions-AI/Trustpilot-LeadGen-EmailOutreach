/**
 * Async campaign email sender.
 * Runs in the background with randomized delays and rate limiting.
 * Emits SSE-compatible progress events via campaignEvents.
 */

import { EventEmitter } from 'events';
import path from 'path';
import { config } from '../config.js';
import { sendEmail, type GmailSenderAccount } from './email-sender.js';
import { createGmailClientFromCredentials } from './gmail-client.js';
import { rateLimiter } from './rate-limiter.js';
import { applyTestMode } from './test-mode.js';
import { updateCampaign, updateCampaignLeadGmailIds } from '../db/campaigns.js';
import { getCampaignSteps } from '../db/campaign-steps.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';

export const campaignEvents = new EventEmitter();
campaignEvents.setMaxListeners(50);

// Campaigns that have been requested to cancel
const cancelRequests = new Set<string>();

/** Request a running campaign to stop before the next email. */
export function cancelCampaign(campaignId: string) {
  cancelRequests.add(campaignId);
}

export interface CampaignEmail {
  campaignLeadId: string;
  leadId: string;
  to: string;
  subject: string;
  html: string;
  screenshotPath?: string;
}

export interface CampaignSendParams {
  campaignId: string;
  campaignName: string;
  emails: CampaignEmail[];
  testMode?: boolean;
  testEmailOverride?: string;
}

/**
 * Dynamic delay that varies with position in the session.
 * Early emails get longer delays to establish a natural sending pattern.
 * Adds ±30% jitter to avoid detectable intervals.
 */
function dynamicDelay(emailIndex: number): number {
  const { minDelay, maxDelay } = config.rateLimits;

  // Base delay scales down as session progresses (emails 1-5 are slowest)
  let base: number;
  if (emailIndex < 5) {
    // First 5 emails: use the full configured range (typically 2-7 min)
    base = maxDelay;
  } else if (emailIndex < 15) {
    // Emails 6-15: middle range
    base = (minDelay + maxDelay) / 2;
  } else {
    // Emails 16+: standard minimum range
    base = minDelay;
  }

  // Add ±30% jitter so no two sends are exactly the same interval
  const jitter = base * 0.3;
  const delay = base + (Math.random() * jitter * 2 - jitter);
  return Math.max(minDelay, Math.floor(delay));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitProgress(campaignId: string, data: Record<string, unknown>) {
  campaignEvents.emit('progress', { campaignId, ...data });
}

export async function runCampaignSend(params: CampaignSendParams): Promise<void> {
  const { campaignId, campaignName, emails, testMode, testEmailOverride } = params;
  const supabase = getSupabase();
  let sent = 0;
  let failed = 0;
  const total = emails.length;

  try {
    // Mark campaign as 'sending'
    await updateCampaign(campaignId, { status: 'sending' });
    emitProgress(campaignId, { stage: 'started', total, sent: 0, failed: 0 });
    console.log(`[Campaign] Starting send for campaign "${campaignName}" (${total} emails)`);

    // Load all active Gmail accounts from DB and build sender pool
    const senderPool: GmailSenderAccount[] = [];
    if (config.emailMode === 'gmail') {
      try {
        const { getSupabase: getSupabaseForAccounts } = await import('../lib/supabase.js');
        const { data: dbAccounts } = await getSupabaseForAccounts()
          .from('email_accounts')
          .select('email, from_name, gmail_client_id, gmail_client_secret, gmail_refresh_token')
          .eq('status', 'active')
          .eq('auth_type', 'gmail_oauth')
          .not('gmail_refresh_token', 'is', null);

        for (const acc of dbAccounts ?? []) {
          if (acc.gmail_client_id && acc.gmail_client_secret && acc.gmail_refresh_token) {
            senderPool.push({
              email: acc.email,
              fromName: acc.from_name,
              gmail: createGmailClientFromCredentials(acc.gmail_client_id, acc.gmail_client_secret, acc.gmail_refresh_token),
            });
          }
        }
      } catch (e) {
        console.warn('[Campaign] Could not load DB accounts — using primary only:', e instanceof Error ? e.message : e);
      }

      // Primary env-var account is always available as fallback (index 0 in rotation)
      // DB accounts rotate in addition — if none, all sends use the primary
      if (senderPool.length > 0) {
        console.log(`[Campaign] Account pool: primary (env) + ${senderPool.length} DB account(s) = ${senderPool.length + 1} total senders`);
      }
    }

    let accountIndex = 0; // round-robin pointer

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];

      // Pick next sender — undefined = primary env-var account
      let senderAccount: GmailSenderAccount | undefined;
      if (senderPool.length > 0) {
        // Slot 0 = primary (undefined), slots 1..N = DB accounts
        const slot = accountIndex % (senderPool.length + 1);
        senderAccount = slot === 0 ? undefined : senderPool[slot - 1];
        accountIndex++;
      }

      // Check for cancellation request before each email
      if (cancelRequests.has(campaignId)) {
        cancelRequests.delete(campaignId);
        await updateCampaign(campaignId, { status: 'draft' });
        emitProgress(campaignId, { stage: 'cancelled', sent, failed, total });
        console.log(`[Campaign] Cancelled by user after ${sent} sends.`);
        return;
      }

      // Wait for rate limiter if at cap
      await rateLimiter.waitUntilCanSend(`[Campaign:${campaignId}] `);

      // Resolve screenshot path to absolute if needed
      let screenshotPath: string | undefined;
      if (email.screenshotPath) {
        screenshotPath = path.isAbsolute(email.screenshotPath)
          ? email.screenshotPath
          : path.resolve(config.projectRoot, email.screenshotPath);
      }

      // Apply test mode transform (UI-provided testEmailOverride takes priority over .env)
      const transformed = applyTestMode({ to: email.to, subject: email.subject, html: email.html }, testMode, testEmailOverride);

      // Send email — uses senderAccount if set, otherwise primary env-var account
      const result = await sendEmail(
        transformed.to,
        transformed.subject,
        transformed.html,
        { screenshotPath },
        senderAccount,
      );
      if (senderAccount) console.log(`[Campaign] Sending via ${senderAccount.email}`);

      if (result.success) {
        sent++;
        rateLimiter.recordSend();

        // Update campaign_leads: status → sent, store Gmail IDs
        await supabase
          .from('campaign_leads')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
          })
          .eq('id', email.campaignLeadId);

        // Store Gmail message/thread IDs if available (for reply tracking)
        if (result.messageId || result.threadId) {
          await updateCampaignLeadGmailIds(
            email.campaignLeadId,
            result.messageId,
            result.threadId
          );
        }

        // Update lead outreach status to 'contacted'
        await updateLead(email.leadId, { outreach_status: 'contacted', contacted_at: new Date().toISOString() });

        // Create activity note
        await createNote(email.leadId, {
          type: 'email_sent',
          content: `Campaign "${campaignName}" email sent to ${email.to}${testMode ? ' [TEST MODE]' : ''}`,
          metadata: { campaign_id: campaignId, gmail_message_id: result.messageId },
        });

        emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: true });
        console.log(`[Campaign] Sent ${i + 1}/${total}: ${email.to}`);
      } else {
        failed++;
        emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: false, error: result.error });
        console.warn(`[Campaign] Failed ${i + 1}/${total}: ${email.to} — ${result.error}`);
      }

      // Dynamic delay between sends — longer early in session, shorter later (skip after last email)
      if (i < emails.length - 1) {
        const delay = dynamicDelay(i);
        console.log(`[Campaign] Waiting ${Math.round(delay / 1000)}s before next send (email ${i + 1}/${emails.length})...`);
        await sleep(delay);
      }
    }

    // Schedule follow-up steps for leads that were successfully sent
    try {
      const steps = await getCampaignSteps(campaignId);
      const nextStep = steps.find((s) => s.step_number === 2); // first follow-up
      if (nextStep && sent > 0) {
        const nextStepAt = new Date(Date.now() + nextStep.delay_days * 24 * 60 * 60 * 1000).toISOString();
        const supabaseForSteps = getSupabase();
        await supabaseForSteps
          .from('campaign_leads')
          .update({ current_step: 1, next_step_at: nextStepAt })
          .eq('campaign_id', campaignId)
          .eq('status', 'sent');
        console.log(`[Campaign] Scheduled ${sent} leads for follow-up step 2 in ${nextStep.delay_days} days`);
      }
    } catch (stepErr) {
      console.warn('[Campaign] Failed to schedule follow-ups:', stepErr instanceof Error ? stepErr.message : stepErr);
    }

    // Update campaign totals and status
    await updateCampaign(campaignId, {
      status: 'sent',
      total_sent: sent,
      sent_at: new Date().toISOString(),
    });

    emitProgress(campaignId, { stage: 'completed', total, sent, failed });
    console.log(`[Campaign] Completed: ${sent} sent, ${failed} failed`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Campaign] Fatal error: ${message}`);
    await updateCampaign(campaignId, { status: 'draft' }).catch(() => {});
    emitProgress(campaignId, { stage: 'failed', error: message, sent, failed });
  }
}
