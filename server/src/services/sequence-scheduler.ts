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
  const campaignId = cl.campaign_id as string;
  const currentStep = (cl.current_step as number) || 1;
  const nextStepNumber = currentStep + 1;
  const lead = cl.leads as Record<string, unknown>;

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

  // Render template with lead data
  const subject = renderAndSpin(step.template_subject, lead);
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

  // Send the email
  const result = await sendEmail(
    transformed.to,
    transformed.subject,
    transformed.html,
    { screenshotPath }
  );

  if (result.success) {
    rateLimiter.recordSend();

    // Find the NEXT follow-up step after this one
    const nextNextStep = steps.find((s) => s.step_number === nextStepNumber + 1);
    const nextStepAt = nextNextStep
      ? new Date(Date.now() + nextNextStep.delay_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Update campaign_lead: advance step, set next due date
    await supabase
      .from('campaign_leads')
      .update({
        current_step: nextStepNumber,
        next_step_at: nextStepAt,
        sequence_completed: !nextNextStep,
        sent_at: new Date().toISOString(),
      })
      .eq('id', cl.id);

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
