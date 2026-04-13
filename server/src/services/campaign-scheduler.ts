/**
 * Campaign Scheduler — DB-driven background job that sends campaign emails at their scheduled times.
 *
 * Works for Gmail/direct mode only. Platform mode (Instantly) handles scheduling natively.
 *
 * On each tick (every 60s):
 *  1. Find campaign_leads WHERE status='pending' AND scheduled_at <= NOW()
 *  2. For each due lead: render template + send email via Gmail
 *  3. If campaign is now fully sent: finalize it and schedule follow-ups
 *
 * This approach survives Cloud Run restarts because all state lives in Supabase.
 */

import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { getSupabase } from '../lib/supabase.js';
import { sendEmail, type GmailSenderAccount } from './email-sender.js';
import { createGmailClientFromCredentials } from './gmail-client.js';
import { rateLimiter } from './rate-limiter.js';
import { renderAndSpin } from './template-engine.js';
import { updateCampaign, updateCampaignLeadGmailIds } from '../db/campaigns.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { getCampaignSteps } from '../db/campaign-steps.js';
import { checkForBounces } from './bounce-tracker.js';

const POLL_INTERVAL_MS = 60_000; // check every 60 seconds
const BATCH_LIMIT = 10;           // max sends per tick (stays within hourly caps)
const BOUNCE_CHECK_EVERY = 5;     // run bounce check every N ticks (= every 5 minutes)

export function startCampaignScheduler(): void {
  let tick = 0;

  // Always run the recovery loop regardless of email platform —
  // it finalizes campaigns stuck in 'draft'/'sending' where all emails are already done.
  // Also runs the Gmail bounce checker every BOUNCE_CHECK_EVERY ticks.
  setInterval(async () => {
    tick++;
    try {
      await recoverStuckCampaigns();
    } catch (err) {
      console.error('[CampaignScheduler] Recovery error:', err instanceof Error ? err.message : err);
    }

    if (tick % BOUNCE_CHECK_EVERY === 0) {
      try {
        await checkForBounces();
      } catch (err) {
        console.error('[CampaignScheduler] Bounce check error:', err instanceof Error ? err.message : err);
      }
    }
  }, POLL_INTERVAL_MS);

  if (config.emailPlatform !== 'none') {
    console.log('[CampaignScheduler] Platform mode — scheduling handled by platform, direct-send scheduler skipped.');
    return;
  }

  console.log('[CampaignScheduler] Started — polling every 60s for due emails, bounce check every 5 min.');

  setInterval(async () => {
    try {
      await processDueSends();
    } catch (err) {
      console.error('[CampaignScheduler] Tick error:', err instanceof Error ? err.message : err);
    }
  }, POLL_INTERVAL_MS);
}

async function processDueSends(): Promise<void> {
  const supabase = getSupabase();

  const { data: dueLeads, error } = await supabase
    .from('campaign_leads')
    .select(`
      id, campaign_id, lead_id, email_used, scheduled_at,
      campaigns (id, name, template_subject, template_body, include_screenshot, status, sending_schedule),
      leads (*)
    `)
    .eq('status', 'pending')
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', new Date().toISOString())
    .limit(BATCH_LIMIT);

  if (error) {
    console.error('[CampaignScheduler] Query error:', error.message);
    return;
  }
  if (!dueLeads || dueLeads.length === 0) return;

  // Only process leads from campaigns that are still 'sending'
  const actionable = dueLeads.filter((cl: any) => cl.campaigns?.status === 'sending');
  if (actionable.length === 0) return;

  console.log(`[CampaignScheduler] ${actionable.length} emails due now`);

  // Determine the pinned sender account from the first campaign's schedule
  const firstCampaign = actionable[0]?.campaigns as { sending_schedule?: { senderAccountId?: string } } | undefined;
  const pinnedAccountId = firstCampaign?.sending_schedule?.senderAccountId;

  const senderPool = await buildSenderPool(pinnedAccountId);

  for (let i = 0; i < actionable.length; i++) {
    const cl = actionable[i];

    if (!rateLimiter.canSend()) {
      console.log('[CampaignScheduler] Rate limit reached — remaining sends deferred to next tick');
      break;
    }

    try {
      const senderAccount = pickSender(senderPool, i);
      await sendScheduledEmail(cl, senderAccount);
    } catch (err) {
      console.error('[CampaignScheduler] Send failed for', cl.email_used, ':', err instanceof Error ? err.message : err);
    }

    if (i < actionable.length - 1) {
      await new Promise((r) => setTimeout(r, 2000)); // brief pause between sends
    }
  }

  // Finalize campaigns that are now fully sent
  const campaignIds = [...new Set(actionable.map((cl: any) => cl.campaign_id as string))];
  for (const campaignId of campaignIds) {
    await maybeFinalizeCampaign(campaignId);
  }
}

async function buildSenderPool(pinnedAccountId?: string): Promise<GmailSenderAccount[]> {
  if (config.emailMode !== 'gmail') return [];
  if (pinnedAccountId === '__env__') return []; // Use env primary — pool stays empty → pickSender returns undefined → email-sender uses env
  try {
    let query = getSupabase()
      .from('email_accounts')
      .select('id, email, from_name, gmail_client_id, gmail_client_secret, gmail_refresh_token')
      .eq('status', 'active')
      .eq('auth_type', 'gmail_oauth')
      .not('gmail_refresh_token', 'is', null);

    if (pinnedAccountId) {
      query = query.eq('id', pinnedAccountId) as typeof query;
    }

    const { data: dbAccounts } = await query;
    return (dbAccounts ?? [])
      .filter((a: any) => a.gmail_client_id && a.gmail_client_secret && a.gmail_refresh_token)
      .map((a: any) => ({
        email: a.email,
        fromName: a.from_name,
        gmail: createGmailClientFromCredentials(a.gmail_client_id, a.gmail_client_secret, a.gmail_refresh_token),
      }));
  } catch {
    return [];
  }
}

function pickSender(pool: GmailSenderAccount[], index: number): GmailSenderAccount | undefined {
  if (pool.length === 0) return undefined;
  const slot = index % (pool.length + 1); // slot 0 = primary env account, 1..N = DB accounts
  return slot === 0 ? undefined : pool[slot - 1];
}

async function sendScheduledEmail(cl: any, senderAccount: GmailSenderAccount | undefined): Promise<void> {
  const supabase = getSupabase();
  const campaign = cl.campaigns as Record<string, unknown>;
  const lead = cl.leads as Record<string, unknown>;

  const subject = renderAndSpin(String(campaign.template_subject || ''), lead);
  const html    = renderAndSpin(String(campaign.template_body    || ''), lead);

  let screenshotPath: string | undefined;
  const leadScreenshot = lead.screenshot_path ? String(lead.screenshot_path) : '';
  if (campaign.include_screenshot && leadScreenshot) {
    if (leadScreenshot.startsWith('http')) {
      screenshotPath = leadScreenshot;
    } else {
      const local = path.resolve(config.projectRoot, '.tmp', 'screenshots', path.basename(leadScreenshot));
      if (fs.existsSync(local)) screenshotPath = local;
    }
  }

  if (senderAccount) console.log(`[CampaignScheduler] Sending via ${senderAccount.email}`);

  const result = await sendEmail(cl.email_used, subject, html, { screenshotPath }, senderAccount);

  if (result.success) {
    rateLimiter.recordSend();

    await supabase
      .from('campaign_leads')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', cl.id);

    // Store Gmail thread/message IDs so the reply tracker and bounce tracker can cross-reference
    if (result.messageId || result.threadId) {
      await updateCampaignLeadGmailIds(cl.id, result.messageId, result.threadId);
    }

    await updateLead(lead.id as string, {
      outreach_status: 'contacted',
      contacted_at: new Date().toISOString(),
    });

    await createNote(lead.id as string, {
      type: 'email_sent',
      content: `Campaign "${campaign.name}" email sent to ${cl.email_used}`,
      metadata: { campaign_id: campaign.id, gmail_message_id: result.messageId },
    });

    console.log(`[CampaignScheduler] Sent → ${cl.email_used}`);
  } else {
    console.warn(`[CampaignScheduler] Failed → ${cl.email_used}: ${result.error}`);
  }
}

/**
 * Detect and finalize campaigns stuck in 'draft' or 'sending' where all
 * actionable (scheduled) emails have already been sent.
 *
 * This handles two failure modes:
 *  1. Campaign reverted to 'draft' after a platform push error, but Gmail
 *     scheduler already sent some/all emails in the meantime.
 *  2. Campaign stuck at 'sending' because a ghost pending lead (scheduled_at=null)
 *     blocked maybeFinalizeCampaign.
 *
 * Runs every tick regardless of email platform.
 */
async function recoverStuckCampaigns(): Promise<void> {
  const supabase = getSupabase();

  const { data: candidates } = await supabase
    .from('campaigns')
    .select('id, name')
    .in('status', ['sending', 'draft']);

  if (!candidates || candidates.length === 0) return;

  for (const campaign of candidates) {
    // Count leads that are still genuinely waiting to be sent
    const { count: scheduledPending } = await supabase
      .from('campaign_leads')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'pending')
      .not('scheduled_at', 'is', null);

    if ((scheduledPending ?? 0) > 0) continue; // Emails still queued — leave it alone

    // Count successfully sent leads
    const { count: sentCount } = await supabase
      .from('campaign_leads')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'sent');

    if (!sentCount || sentCount === 0) continue; // Nothing sent yet — not ready to finalize

    // All scheduled emails are done — finalize the campaign
    await updateCampaign(campaign.id, {
      status: 'sent',
      total_sent: sentCount,
      sent_at: new Date().toISOString(),
    });

    console.log(`[CampaignScheduler] Recovered stuck campaign "${campaign.name}" → sent (${sentCount} emails)`);
  }
}

async function maybeFinalizeCampaign(campaignId: string): Promise<void> {
  const supabase = getSupabase();

  // Only count leads that are actually scheduled (scheduled_at IS NOT NULL).
  // Leads with null scheduled_at were deduped out and will never send — they don't block finalization.
  const { count: pendingCount } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .not('scheduled_at', 'is', null);

  if (pendingCount !== 0) return; // Still waiting on future scheduled sends

  const { count: sentCount } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'sent');

  await updateCampaign(campaignId, {
    status: 'sent',
    total_sent: sentCount || 0,
    sent_at: new Date().toISOString(),
  });

  console.log(`[CampaignScheduler] Campaign ${campaignId} fully sent (${sentCount} emails)`);

  // Schedule follow-up step 2 if configured
  try {
    const steps = await getCampaignSteps(campaignId);
    const step2 = steps.find((s) => s.step_number === 2);
    if (step2 && sentCount) {
      const nextStepAt = new Date(Date.now() + step2.delay_days * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('campaign_leads')
        .update({ current_step: 1, next_step_at: nextStepAt })
        .eq('campaign_id', campaignId)
        .eq('status', 'sent');
      console.log(`[CampaignScheduler] Scheduled ${sentCount} leads for follow-up step 2 in ${step2.delay_days} days`);
    }
  } catch (e) {
    console.warn('[CampaignScheduler] Follow-up schedule failed:', e instanceof Error ? e.message : e);
  }
}
