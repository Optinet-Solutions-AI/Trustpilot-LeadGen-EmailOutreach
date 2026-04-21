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
import { sendEmail, type GmailSenderAccount, type SmtpSenderAccount, type SenderAccount } from './email-sender.js';
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

  // Determine the sender accounts from the first campaign's schedule.
  // Supports new senderAccountIds[] and falls back to legacy senderAccountId string.
  const firstCampaign = actionable[0]?.campaigns as { sending_schedule?: { senderAccountIds?: string[]; senderAccountId?: string } } | undefined;
  const schedule = firstCampaign?.sending_schedule;
  const pinnedIds: string[] = schedule?.senderAccountIds ?? (schedule?.senderAccountId ? [schedule.senderAccountId] : []);

  const senderPool = await buildSenderPool(pinnedIds);
  const sentCounts = await loadSentCounts();

  // Include env account in rotation if the user selected it (or selected nothing = all)
  const includeEnv = pinnedIds.length === 0 || pinnedIds.includes('__env__');

  let sentThisTick = 0;
  for (let i = 0; i < actionable.length; i++) {
    const cl = actionable[i];

    const picked = pickSender(senderPool, sentThisTick, includeEnv, sentCounts);
    if (picked === undefined) {
      console.log('[CampaignScheduler] All sender accounts at cap — deferring remaining sends to next tick');
      break;
    }
    const senderAccount: SenderAccount | undefined = picked === 'env' ? undefined : picked;

    // Env account still uses the global rateLimiter (for warmup/legacy caps)
    if (picked === 'env' && !rateLimiter.canSend()) {
      console.log('[CampaignScheduler] Env account at cap — deferring');
      break;
    }

    try {
      await sendScheduledEmail(cl, senderAccount);
      // Track this send in-tick so picker rotates fairly across multiple mailboxes
      const key = (senderAccount?.email ?? config.gmail.fromEmail ?? '').toLowerCase();
      if (key) {
        if (!sentCounts[key]) sentCounts[key] = { daily: 0, hourly: 0 };
        sentCounts[key].daily  += 1;
        sentCounts[key].hourly += 1;
      }
      sentThisTick++;
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

// Attach per-account caps to the SenderAccount union so the picker can enforce them
type AccountWithCaps<T> = T & { dailyCap: number; hourlyCap: number };

async function buildSenderPool(pinnedIds: string[] = []): Promise<AccountWithCaps<SenderAccount>[]> {
  if (config.emailMode !== 'gmail') return [];

  // If the only selection is the env account, keep pool empty — email-sender uses env by default.
  const dbIds = pinnedIds.filter((id) => id !== '__env__');
  if (pinnedIds.length > 0 && dbIds.length === 0) return [];

  try {
    let query = getSupabase()
      .from('email_accounts')
      .select('id, email, from_name, auth_type, gmail_client_id, gmail_client_secret, gmail_refresh_token, smtp_host, smtp_port, smtp_user, smtp_password, imap_host, imap_port, imap_user, imap_pass, daily_cap, hourly_cap')
      .eq('status', 'active')
      .in('auth_type', ['gmail_oauth', 'smtp', 'app_password']);

    // Filter to specific IDs when the user pinned accounts; otherwise load all active
    if (dbIds.length > 0) {
      query = query.in('id', dbIds) as typeof query;
    }

    const { data: dbAccounts } = await query;
    const accounts: AccountWithCaps<SenderAccount>[] = [];
    for (const a of (dbAccounts ?? []) as Array<Record<string, unknown>>) {
      const dailyCap  = (a.daily_cap  as number | null | undefined) ?? config.rateLimits.dailyCap;
      const hourlyCap = (a.hourly_cap as number | null | undefined) ?? config.rateLimits.hourlyCap;
      if (a.auth_type === 'smtp' && a.smtp_host && a.smtp_user && a.smtp_password) {
        accounts.push({
          email: a.email as string,
          fromName: a.from_name as string,
          auth_type: 'smtp',
          smtp_host: a.smtp_host as string,
          smtp_port: (a.smtp_port as number | null) ?? 587,
          smtp_user: a.smtp_user as string,
          smtp_password: a.smtp_password as string,
          imap_host: (a.imap_host as string | null) ?? null,
          imap_port: (a.imap_port as number | null) ?? null,
          imap_user: (a.imap_user as string | null) ?? null,
          imap_pass: (a.imap_pass as string | null) ?? null,
          dailyCap, hourlyCap,
        } as AccountWithCaps<SmtpSenderAccount>);
      } else if ((a.auth_type === 'gmail_oauth' || a.auth_type === 'app_password') && a.gmail_client_id && a.gmail_client_secret && a.gmail_refresh_token) {
        accounts.push({
          email: a.email as string,
          fromName: a.from_name as string,
          gmail: createGmailClientFromCredentials(a.gmail_client_id as string, a.gmail_client_secret as string, a.gmail_refresh_token as string),
          dailyCap, hourlyCap,
        } as AccountWithCaps<GmailSenderAccount>);
      }
    }
    return accounts;
  } catch {
    return [];
  }
}

// Query real per-account send counts for the last 24h / 1h window
async function loadSentCounts(): Promise<Record<string, { daily: number; hourly: number }>> {
  const counts: Record<string, { daily: number; hourly: number }> = {};
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

// Pick the next sender that still has headroom in both hourly and daily caps.
// `sentCounts` is authoritative (from campaign_leads), mutated as we send to track in-tick usage.
function pickSender(
  pool: AccountWithCaps<SenderAccount>[],
  index: number,
  includeEnv: boolean,
  sentCounts: Record<string, { daily: number; hourly: number }>,
): AccountWithCaps<SenderAccount> | undefined | 'env' {
  const total = pool.length + (includeEnv ? 1 : 0);
  if (total === 0) return undefined;

  // Try each slot starting from `index`, skipping anyone who has hit their cap.
  for (let offset = 0; offset < total; offset++) {
    const slot = (index + offset) % total;
    const isEnvSlot = includeEnv && slot === 0;
    if (isEnvSlot) return 'env'; // env account uses global rateLimiter check already done
    const account = pool[includeEnv ? slot - 1 : slot];
    if (!account) continue;
    const key = account.email.toLowerCase();
    const used = sentCounts[key] ?? { daily: 0, hourly: 0 };
    if (used.daily >= account.dailyCap)   continue;
    if (used.hourly >= account.hourlyCap) continue;
    return account;
  }
  return undefined;
}

async function sendScheduledEmail(cl: any, senderAccount: SenderAccount | undefined): Promise<void> {
  const supabase = getSupabase();
  const campaign = cl.campaigns as Record<string, unknown>;
  const lead = cl.leads as Record<string, unknown>;

  const subject = renderAndSpin(String(campaign.template_subject || ''), lead);
  const html    = renderAndSpin(String(campaign.template_body    || ''), lead);

  let screenshotPath: string | undefined;
  const leadScreenshot = lead.screenshot_path ? String(lead.screenshot_path) : '';
  if (campaign.include_screenshot) {
    if (leadScreenshot.startsWith('http')) {
      screenshotPath = leadScreenshot;
    } else if (leadScreenshot) {
      const local = path.resolve(config.projectRoot, '.tmp', 'screenshots', path.basename(leadScreenshot));
      if (fs.existsSync(local)) screenshotPath = local;
      // No Thum.io fallback — Cloud Run egress gets 403'd. Email sends without image.
    }
  }

  if (senderAccount) console.log(`[CampaignScheduler] Sending via ${senderAccount.email}`);

  const result = await sendEmail(cl.email_used, subject, html, { screenshotPath }, senderAccount);

  if (result.success) {
    rateLimiter.recordSend();

    const senderEmail = senderAccount?.email ?? config.gmail.fromEmail ?? null;
    const updatePayload: Record<string, unknown> = {
      status: 'sent',
      sent_at: new Date().toISOString(),
    };
    if (senderEmail) updatePayload.sender_email = senderEmail;

    const { error: updateErr } = await supabase
      .from('campaign_leads')
      .update(updatePayload)
      .eq('id', cl.id);
    // If sender_email column missing (pre-migration), retry without it so the send still gets marked
    if (updateErr && /sender_email/.test(updateErr.message ?? '')) {
      await supabase
        .from('campaign_leads')
        .update({ status: 'sent', sent_at: updatePayload.sent_at })
        .eq('id', cl.id);
    }

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
