/**
 * Async campaign email sender.
 *
 * Two modes:
 *  - TEST MODE  → sends all emails immediately (no scheduling, no delays)
 *  - LIVE MODE  → pre-assigns random send times within the configured window,
 *                 stores scheduled_at on each campaign_lead, then sleeps until
 *                 each email's time before sending. Human-paced, impossible to
 *                 distinguish from a real person composing emails.
 */

import { EventEmitter } from 'events';
import path from 'path';
import { config } from '../config.js';
import { sendEmail, type GmailSenderAccount } from './email-sender.js';
import { createGmailClientFromCredentials } from './gmail-client.js';
import { rateLimiter } from './rate-limiter.js';
import { applyTestMode } from './test-mode.js';
import { assignScheduledTimes, describeSendPlan, type SendingSchedule } from './schedule-engine.js';
import { updateCampaign, updateCampaignLeadGmailIds } from '../db/campaigns.js';
import { getCampaignSteps } from '../db/campaign-steps.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';

export const campaignEvents = new EventEmitter();
campaignEvents.setMaxListeners(50);

const cancelRequests = new Set<string>();

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
  sendingSchedule?: SendingSchedule | null;
  testMode?: boolean;
  testEmailOverride?: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function emitProgress(campaignId: string, data: Record<string, unknown>) {
  campaignEvents.emit('progress', { campaignId, ...data });
}

export async function runCampaignSend(params: CampaignSendParams): Promise<void> {
  const { campaignId, campaignName, emails, sendingSchedule, testMode, testEmailOverride } = params;
  const supabase = getSupabase();
  let sent = 0;
  let failed = 0;
  const total = emails.length;

  try {
    await updateCampaign(campaignId, { status: 'sending' });
    emitProgress(campaignId, { stage: 'started', total, sent: 0, failed: 0 });
    console.log(`[Campaign] Starting "${campaignName}" — ${total} emails, testMode=${testMode}`);

    // ── Build sender account pool (Gmail round-robin) ─────────────────────
    const senderPool: GmailSenderAccount[] = [];
    if (config.emailMode === 'gmail') {
      try {
        const { data: dbAccounts } = await getSupabase()
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
              gmail: createGmailClientFromCredentials(
                acc.gmail_client_id, acc.gmail_client_secret, acc.gmail_refresh_token
              ),
            });
          }
        }
        if (senderPool.length > 0) {
          console.log(`[Campaign] Sender pool: primary (env) + ${senderPool.length} DB account(s)`);
        }
      } catch (e) {
        console.warn('[Campaign] Could not load DB accounts:', e instanceof Error ? e.message : e);
      }
    }

    let accountIndex = 0;

    // ── TEST MODE: send all immediately, no scheduling ────────────────────
    if (testMode) {
      console.log('[Campaign] TEST MODE — sending immediately, schedule ignored');

      for (let i = 0; i < emails.length; i++) {
        const email = emails[i];

        if (cancelRequests.has(campaignId)) {
          cancelRequests.delete(campaignId);
          await updateCampaign(campaignId, { status: 'draft' });
          emitProgress(campaignId, { stage: 'cancelled', sent, failed, total });
          return;
        }

        const senderAccount = pickSender(senderPool, accountIndex++);
        const transformed = applyTestMode(
          { to: email.to, subject: email.subject, html: email.html },
          true, testEmailOverride,
        );

        const result = await sendEmail(
          transformed.to, transformed.subject, transformed.html,
          { screenshotPath: resolveScreenshotPath(email.screenshotPath) },
          senderAccount,
        );

        if (result.success) {
          sent++;
          rateLimiter.recordSend();
          await markSent(supabase, email, result, campaignId, campaignName, true);
          emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: true });
        } else {
          failed++;
          emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: false, error: result.error });
        }
      }

      await finalizeCampaign(supabase, campaignId, campaignName, sent, failed, total);
      return;
    }

    // ── LIVE MODE: schedule emails randomly within the configured window ───
    if (!sendingSchedule) {
      // No schedule configured — fall back to immediate sending with delay
      console.warn('[Campaign] No sendingSchedule provided for live send. Falling back to immediate send.');
      params = { ...params, testMode: false };
      // Re-run as unscheduled (delay-based fallback)
      await runUnscheduledSend({ ...params, senderPool, accountIndex });
      return;
    }

    // Compute random send times for all emails
    let scheduledTimes: Date[];
    try {
      scheduledTimes = assignScheduledTimes(total, sendingSchedule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateCampaign(campaignId, { status: 'draft' });
      emitProgress(campaignId, { stage: 'failed', error: `Schedule error: ${msg}`, sent: 0, failed: total });
      return;
    }

    if (scheduledTimes.length < total) {
      console.warn(`[Campaign] Only ${scheduledTimes.length}/${total} send times could be scheduled (window too narrow?)`);
    }

    console.log(`[Campaign] ${describeSendPlan(scheduledTimes, sendingSchedule.timezone)}`);

    // Store scheduled_at on each campaign_lead so the UI can show "sends at X"
    await Promise.allSettled(
      emails.map((email, i) => {
        const t = scheduledTimes[i];
        if (!t) return Promise.resolve();
        return supabase
          .from('campaign_leads')
          .update({ scheduled_at: t.toISOString() })
          .eq('id', email.campaignLeadId);
      })
    );

    emitProgress(campaignId, {
      stage: 'scheduled',
      total,
      scheduledCount: scheduledTimes.length,
      firstSendAt: scheduledTimes[0]?.toISOString(),
      lastSendAt: scheduledTimes[scheduledTimes.length - 1]?.toISOString(),
      plan: describeSendPlan(scheduledTimes, sendingSchedule.timezone),
    });

    // Send loop — sleep until each email's assigned time
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const sendAt = scheduledTimes[i];

      if (!sendAt) {
        console.warn(`[Campaign] No scheduled time for email ${i + 1}, skipping`);
        failed++;
        continue;
      }

      if (cancelRequests.has(campaignId)) {
        cancelRequests.delete(campaignId);
        await updateCampaign(campaignId, { status: 'draft' });
        emitProgress(campaignId, { stage: 'cancelled', sent, failed, total });
        console.log(`[Campaign] Cancelled after ${sent} sends.`);
        return;
      }

      // Sleep until the scheduled time (check for cancel every 30s while waiting)
      const msUntilSend = sendAt.getTime() - Date.now();
      if (msUntilSend > 0) {
        console.log(`[Campaign] Email ${i + 1}/${total}: sleeping ${Math.round(msUntilSend / 1000)}s until ${sendAt.toISOString()}`);
        await sleepWithCancelCheck(msUntilSend, campaignId, cancelRequests, async () => {
          cancelRequests.delete(campaignId);
          await updateCampaign(campaignId, { status: 'draft' });
          emitProgress(campaignId, { stage: 'cancelled', sent, failed, total });
        });
        // Re-check cancel after sleep
        if (cancelRequests.has(campaignId)) return;
      }

      // Rate limiter check (daily/hourly warmup cap)
      await rateLimiter.waitUntilCanSend(`[Campaign:${campaignId}] `);

      const senderAccount = pickSender(senderPool, accountIndex++);
      const screenshotPath = resolveScreenshotPath(email.screenshotPath);

      const result = await sendEmail(
        email.to, email.subject, email.html,
        { screenshotPath },
        senderAccount,
      );
      if (senderAccount) console.log(`[Campaign] Sending via ${senderAccount.email}`);

      if (result.success) {
        sent++;
        rateLimiter.recordSend();
        await markSent(supabase, email, result, campaignId, campaignName, false);
        emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: true });
        console.log(`[Campaign] Sent ${i + 1}/${total}: ${email.to}`);
      } else {
        failed++;
        emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: false, error: result.error });
        console.warn(`[Campaign] Failed ${i + 1}/${total}: ${email.to} — ${result.error}`);
      }
    }

    await finalizeCampaign(supabase, campaignId, campaignName, sent, failed, total);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Campaign] Fatal error: ${message}`);
    await updateCampaign(campaignId, { status: 'draft' }).catch(() => {});
    emitProgress(campaignId, { stage: 'failed', error: message, sent, failed });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickSender(pool: GmailSenderAccount[], index: number): GmailSenderAccount | undefined {
  if (pool.length === 0) return undefined;
  const slot = index % (pool.length + 1); // slot 0 = primary (env), 1..N = DB accounts
  return slot === 0 ? undefined : pool[slot - 1];
}

function resolveScreenshotPath(p?: string): string | undefined {
  if (!p) return undefined;
  return path.isAbsolute(p) ? p : path.resolve(config.projectRoot, p);
}

async function markSent(
  supabase: ReturnType<typeof getSupabase>,
  email: CampaignEmail,
  result: { messageId?: string; threadId?: string },
  campaignId: string,
  campaignName: string,
  isTest: boolean,
) {
  await supabase
    .from('campaign_leads')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', email.campaignLeadId);

  if (result.messageId || result.threadId) {
    await updateCampaignLeadGmailIds(email.campaignLeadId, result.messageId, result.threadId);
  }

  await updateLead(email.leadId, {
    outreach_status: 'contacted',
    contacted_at: new Date().toISOString(),
  });

  await createNote(email.leadId, {
    type: 'email_sent',
    content: `Campaign "${campaignName}" email sent to ${email.to}${isTest ? ' [TEST MODE]' : ''}`,
    metadata: { campaign_id: campaignId, gmail_message_id: result.messageId },
  });
}

async function finalizeCampaign(
  supabase: ReturnType<typeof getSupabase>,
  campaignId: string,
  campaignName: string,
  sent: number,
  failed: number,
  total: number,
) {
  // Schedule follow-up steps for successfully sent leads
  try {
    const steps = await getCampaignSteps(campaignId);
    const nextStep = steps.find(s => s.step_number === 2);
    if (nextStep && sent > 0) {
      const nextStepAt = new Date(Date.now() + nextStep.delay_days * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('campaign_leads')
        .update({ current_step: 1, next_step_at: nextStepAt })
        .eq('campaign_id', campaignId)
        .eq('status', 'sent');
      console.log(`[Campaign] Scheduled ${sent} leads for follow-up step 2 in ${nextStep.delay_days} days`);
    }
  } catch (stepErr) {
    console.warn('[Campaign] Failed to schedule follow-ups:', stepErr instanceof Error ? stepErr.message : stepErr);
  }

  await updateCampaign(campaignId, {
    status: 'sent',
    total_sent: sent,
    sent_at: new Date().toISOString(),
  });

  campaignEvents.emit('progress', { campaignId, stage: 'completed', total, sent, failed });
  console.log(`[Campaign] "${campaignName}" completed: ${sent} sent, ${failed} failed`);
}

/**
 * Sleep for `ms` milliseconds, checking for cancel every 30 seconds.
 * Calls `onCancel` if a cancel is detected during the wait.
 */
async function sleepWithCancelCheck(
  ms: number,
  campaignId: string,
  cancelSet: Set<string>,
  onCancel: () => Promise<void>,
) {
  const checkInterval = 30_000; // check every 30s
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (cancelSet.has(campaignId)) {
      await onCancel();
      return;
    }
    const remaining = deadline - Date.now();
    await sleep(Math.min(checkInterval, remaining));
  }
}

/**
 * Fallback: send immediately with small random delays between emails.
 * Used when no sendingSchedule is configured.
 */
async function runUnscheduledSend(params: CampaignSendParams & {
  senderPool: GmailSenderAccount[];
  accountIndex: number;
}) {
  const { campaignId, campaignName, emails, senderPool, testMode, testEmailOverride } = params;
  let { accountIndex } = params;
  const supabase = getSupabase();
  let sent = 0;
  let failed = 0;
  const total = emails.length;

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];

    if (cancelRequests.has(campaignId)) {
      cancelRequests.delete(campaignId);
      await updateCampaign(campaignId, { status: 'draft' });
      emitProgress(campaignId, { stage: 'cancelled', sent, failed, total });
      return;
    }

    await rateLimiter.waitUntilCanSend(`[Campaign:${campaignId}] `);

    const senderAccount = pickSender(senderPool, accountIndex++);
    const transformed = applyTestMode(
      { to: email.to, subject: email.subject, html: email.html },
      testMode, testEmailOverride,
    );

    const result = await sendEmail(
      transformed.to, transformed.subject, transformed.html,
      { screenshotPath: resolveScreenshotPath(email.screenshotPath) },
      senderAccount,
    );

    if (result.success) {
      sent++;
      rateLimiter.recordSend();
      await markSent(supabase, email, result, campaignId, campaignName, !!testMode);
      emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: true });
    } else {
      failed++;
      emitProgress(campaignId, { stage: 'sent', emailIndex: i + 1, total, sent, failed, to: email.to, success: false, error: result.error });
    }

    // Random 2–5 minute delay between emails
    if (i < emails.length - 1) {
      const delay = 120_000 + Math.floor(Math.random() * 180_000);
      console.log(`[Campaign] No schedule — waiting ${Math.round(delay / 1000)}s before next send`);
      await sleep(delay);
    }
  }

  await finalizeCampaign(supabase, campaignId, campaignName, sent, failed, total);
}
