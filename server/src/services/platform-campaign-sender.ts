/**
 * Platform campaign sender — pushes campaigns to a third-party email platform
 * (Instantly.ai, Smartlead, etc.) instead of sending one-by-one via Gmail.
 *
 * Flow:
 * 1. Render spintax + tokens locally per lead (platforms don't support spintax)
 * 2. Create campaign on platform with a generic template using {{custom_subject}} / {{custom_body}}
 * 3. Add leads in bulk with pre-rendered content as custom variables
 * 4. Activate campaign — platform handles sending, warmup, rotation, pacing
 * 5. Store platform_campaign_id on our campaign record for sync
 */

import { getEmailPlatform } from './email-platform/index.js';
import { updateCampaign } from '../db/campaigns.js';
import { getCampaignSteps } from '../db/campaign-steps.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';
import { renderAndSpin } from './template-engine.js';
import type { PlatformLead } from './email-platform/types.js';
import { campaignEvents } from './campaign-sender.js';

export interface PlatformSendParams {
  campaignId: string;
  campaignName: string;
  campaign: {
    template_subject: string;
    template_body: string;
    include_screenshot?: boolean;
    sending_schedule?: {
      timezone: string;
      startHour: string;
      endHour: string;
      days: number[];
      dailyLimit: number;
    } | null;
  };
  campaignLeads: Array<{
    id: string;           // campaign_lead ID
    lead_id: string;
    email_used: string;
    leads: Record<string, unknown>;  // full lead object
  }>;
}

export async function pushCampaignToPlatform(params: PlatformSendParams): Promise<{
  platformCampaignId: string;
  leadsAdded: number;
  leadsSkipped: number;
  errors: Array<{ email: string; reason: string }>;
}> {
  const { campaignId, campaignName, campaign, campaignLeads } = params;
  const platform = getEmailPlatform();
  const supabase = getSupabase();

  try {
    // Mark campaign as sending
    await updateCampaign(campaignId, { status: 'sending', email_platform: platform.name.toLowerCase() });
    campaignEvents.emit('progress', { campaignId, stage: 'started', total: campaignLeads.length });

    // Step 1: Create campaign on platform with all sequence steps
    // Step 1 uses {{custom_body}} — each lead gets unique pre-rendered content.
    // Follow-up steps (2, 3, ...) use {{custom_subject_N}} / {{custom_body_N}}.
    const followUpSteps = await getCampaignSteps(campaignId);
    const sequences = [
      { subject: '{{custom_subject}}', body: '{{custom_body}}' },
      ...followUpSteps.map((step) => ({
        subject: `{{custom_subject_${step.step_number}}}`,
        body: `{{custom_body_${step.step_number}}}`,
        delayDays: step.delay_days,
      })),
    ];

    const schedule = campaign.sending_schedule;
    const platformCampaign = await platform.createCampaign({
      name: campaignName,
      sequences,
      stopOnReply: true,
      trackOpens: true,
      dailyLimit: schedule?.dailyLimit,
      schedule: schedule ? {
        timezone: schedule.timezone,
        days: schedule.days,
        startHour: schedule.startHour,
        endHour: schedule.endHour,
      } : undefined,
    });

    // Store platform campaign ID
    await updateCampaign(campaignId, { platform_campaign_id: platformCampaign.platformCampaignId });

    // Step 2: Build lead list with pre-rendered content
    const platformLeads: PlatformLead[] = campaignLeads.map((cl) => {
      const lead = cl.leads;

      // Render spintax + template tokens per lead
      const renderedSubject = renderAndSpin(campaign.template_subject, lead);
      const renderedBody = renderAndSpin(campaign.template_body, lead);

      // If screenshot is included and lead has a public URL, embed as <img>
      let finalBody = renderedBody;
      if (campaign.include_screenshot && lead.screenshot_path) {
        const screenshotUrl = String(lead.screenshot_path);
        if (screenshotUrl.startsWith('http')) {
          finalBody += `<br/><img src="${screenshotUrl}" alt="Trustpilot Profile" style="max-width:600px;border-radius:8px;margin-top:16px;" />`;
        }
      }

      // Render follow-up step templates as additional custom variables
      const stepVars: Record<string, string> = {};
      for (const step of followUpSteps) {
        stepVars[`custom_subject_${step.step_number}`] = renderAndSpin(step.template_subject, lead);
        stepVars[`custom_body_${step.step_number}`] = renderAndSpin(step.template_body, lead);
      }

      return {
        email: cl.email_used,
        companyName: String(lead.company_name || ''),
        variables: {
          custom_subject: renderedSubject,
          custom_body: finalBody,
          company_name: String(lead.company_name || ''),
          website_url: String(lead.website_url || ''),
          ...stepVars,
        },
        metadata: {
          campaignLeadId: cl.id,
          leadId: cl.lead_id,
        },
      };
    });

    // Step 3: Add leads to platform campaign (batched internally by adapter)
    const leadResult = await platform.addLeads(
      platformCampaign.platformCampaignId,
      platformLeads
    );

    // Update campaign_leads that were successfully added
    if (leadResult.added > 0) {
      // Mark all as 'pending' (they're queued on the platform)
      const clIds = campaignLeads.map((cl) => cl.id);
      await supabase
        .from('campaign_leads')
        .update({ status: 'pending' })
        .in('id', clIds);
    }

    // Log errors for leads that couldn't be added
    for (const err of leadResult.errors) {
      const cl = campaignLeads.find((l) => l.email_used === err.email);
      if (cl) {
        await createNote(cl.lead_id, {
          type: 'email_sent',
          content: `Platform lead add failed: ${err.reason}`,
          metadata: { campaign_id: campaignId, error: err.reason },
        });
      }
    }

    // Step 4: Activate campaign — platform starts sending
    await platform.activateCampaign(platformCampaign.platformCampaignId);

    // Update campaign status — the sync job will track actual progress
    await updateCampaign(campaignId, { status: 'sending' });

    // Create activity note
    await createNote(campaignLeads[0]?.lead_id || '', {
      type: 'email_sent',
      content: `Campaign "${campaignName}" pushed to ${platform.name}: ${leadResult.added} leads queued`,
      metadata: {
        campaign_id: campaignId,
        platform: platform.name,
        platform_campaign_id: platformCampaign.platformCampaignId,
        leads_added: leadResult.added,
        leads_skipped: leadResult.skipped,
      },
    }).catch(() => {}); // Non-critical

    campaignEvents.emit('progress', {
      campaignId,
      stage: 'platform_queued',
      total: campaignLeads.length,
      sent: 0,
      queued: leadResult.added,
    });

    console.log(`[PlatformSender] Campaign "${campaignName}" pushed to ${platform.name}: ${leadResult.added} leads queued`);

    return {
      platformCampaignId: platformCampaign.platformCampaignId,
      leadsAdded: leadResult.added,
      leadsSkipped: leadResult.skipped,
      errors: leadResult.errors,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PlatformSender] Failed: ${message}`);

    // Revert campaign to draft on failure
    await updateCampaign(campaignId, { status: 'draft' }).catch(() => {});
    campaignEvents.emit('progress', { campaignId, stage: 'failed', error: message });

    throw new Error(`Platform send failed: ${message}`);
  }
}
