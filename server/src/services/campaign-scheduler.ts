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
import { updateCampaign } from '../db/campaigns.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { getCampaignSteps } from '../db/campaign-steps.js';

const POLL_INTERVAL_MS = 60_000; // check every 60 seconds
const BATCH_LIMIT = 10;           // max sends per tick (stays within hourly caps)

export function startCampaignScheduler(): void {
  if (config.emailPlatform !== 'none') {
    console.log('[CampaignScheduler] Platform mode — scheduling handled by platform, scheduler skipped.');
    return;
  }

  console.log('[CampaignScheduler] Started — polling every 60s for due emails.');

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
      campaigns (id, name, template_subject, template_body, include_screenshot, status),
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

  // Build sender pool (same accounts as campaign-sender)
  const senderPool = await buildSenderPool();

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

async function buildSenderPool(): Promise<GmailSenderAccount[]> {
  if (config.emailMode !== 'gmail') return [];
  try {
    const { data: dbAccounts } = await getSupabase()
      .from('email_accounts')
      .select('email, from_name, gmail_client_id, gmail_client_secret, gmail_refresh_token')
      .eq('status', 'active')
      .eq('auth_type', 'gmail_oauth')
      .not('gmail_refresh_token', 'is', null);

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

async function maybeFinalizeCampaign(campaignId: string): Promise<void> {
  const supabase = getSupabase();

  // Check if any pending leads remain
  const { count: pendingCount } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'pending');

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
