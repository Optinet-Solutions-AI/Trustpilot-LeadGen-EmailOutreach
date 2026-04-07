/**
 * Async campaign email sender.
 * Runs in the background with randomized delays and rate limiting.
 * Emits SSE-compatible progress events via campaignEvents.
 */

import { EventEmitter } from 'events';
import path from 'path';
import { config } from '../config.js';
import { sendEmail } from './email-sender.js';
import { rateLimiter } from './rate-limiter.js';
import { applyTestMode } from './test-mode.js';
import { updateCampaign, updateCampaignLeadGmailIds } from '../db/campaigns.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';

export const campaignEvents = new EventEmitter();
campaignEvents.setMaxListeners(50);

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
}

function randomDelay() {
  const { minDelay, maxDelay } = config.rateLimits;
  return Math.floor(Math.random() * (maxDelay - minDelay) + minDelay);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitProgress(campaignId: string, data: Record<string, unknown>) {
  campaignEvents.emit('progress', { campaignId, ...data });
}

export async function runCampaignSend(params: CampaignSendParams): Promise<void> {
  const { campaignId, campaignName, emails, testMode } = params;
  const supabase = getSupabase();
  let sent = 0;
  let failed = 0;
  const total = emails.length;

  try {
    // Mark campaign as 'sending'
    await updateCampaign(campaignId, { status: 'sending' });
    emitProgress(campaignId, { stage: 'started', total, sent: 0, failed: 0 });
    console.log(`[Campaign] Starting send for campaign "${campaignName}" (${total} emails)`);

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];

      // Wait for rate limiter if at cap
      await rateLimiter.waitUntilCanSend(`[Campaign:${campaignId}] `);

      // Resolve screenshot path to absolute if needed
      let screenshotPath: string | undefined;
      if (email.screenshotPath) {
        screenshotPath = path.isAbsolute(email.screenshotPath)
          ? email.screenshotPath
          : path.resolve(config.projectRoot, email.screenshotPath);
      }

      // Apply test mode transform
      const transformed = applyTestMode({ to: email.to, subject: email.subject, html: email.html }, testMode);

      // Send email
      const result = await sendEmail(
        transformed.to,
        transformed.subject,
        transformed.html,
        { screenshotPath }
      );

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

      // Randomized delay between sends (skip delay after last email)
      if (i < emails.length - 1) {
        const delay = randomDelay();
        console.log(`[Campaign] Waiting ${Math.round(delay / 1000)}s before next send...`);
        await sleep(delay);
      }
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
