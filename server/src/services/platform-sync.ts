/**
 * Platform sync service — periodically pulls analytics and lead statuses
 * from the third-party email platform and writes them to our DB.
 *
 * Replaces reply-tracker.ts for platform-managed campaigns.
 * Runs on a configurable interval (default 2 minutes).
 */

import { getSupabase } from '../lib/supabase.js';
import { getEmailPlatform } from './email-platform/index.js';
import { updateCampaign } from '../db/campaigns.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import type { PlatformLeadStatus } from './email-platform/types.js';

/** Sync all active platform campaigns. Called on interval from server.ts */
export async function syncAllActiveCampaigns(): Promise<void> {
  const supabase = getSupabase();

  // Find all campaigns managed by a platform that are still active
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('id, name, platform_campaign_id, email_platform, status')
    .not('platform_campaign_id', 'is', null)
    .in('status', ['sending', 'active']);

  if (error) {
    console.error('[PlatformSync] Failed to fetch active campaigns:', error.message);
    return;
  }

  if (!campaigns || campaigns.length === 0) return;

  const platform = getEmailPlatform();

  for (const campaign of campaigns) {
    try {
      await syncCampaign(campaign.id, campaign.platform_campaign_id!, platform, supabase);
    } catch (err) {
      console.error(`[PlatformSync] Error syncing campaign ${campaign.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Sync a single campaign's analytics and lead statuses */
async function syncCampaign(
  campaignId: string,
  platformCampaignId: string,
  platform: ReturnType<typeof getEmailPlatform>,
  supabase: ReturnType<typeof getSupabase>,
): Promise<void> {
  // 1. Pull aggregate analytics
  const analytics = await platform.getCampaignAnalytics(platformCampaignId);

  await updateCampaign(campaignId, {
    total_sent: analytics.sent,
    total_opened: analytics.opened,
    total_replied: analytics.replied,
    total_bounced: analytics.bounced,
  });

  // 2. Pull individual lead statuses (paginated)
  let cursor: string | undefined;
  let allDone = true;

  do {
    const page = await platform.getLeadStatuses(platformCampaignId, cursor);

    for (const leadStatus of page.leads) {
      await syncLeadStatus(campaignId, leadStatus, supabase);

      // If any lead is still active/sent (not terminal), campaign is not done
      if (leadStatus.status === 'active') {
        allDone = false;
      }
    }

    cursor = page.nextCursor;
  } while (cursor);

  // 3. Auto-complete campaign if all leads are in terminal state
  if (allDone && analytics.sent > 0) {
    await updateCampaign(campaignId, { status: 'completed' });
    console.log(`[PlatformSync] Campaign ${campaignId} completed (all leads resolved)`);
  }
}

/** Map a single platform lead status to our campaign_leads + leads tables */
async function syncLeadStatus(
  campaignId: string,
  status: PlatformLeadStatus,
  supabase: ReturnType<typeof getSupabase>,
): Promise<void> {
  // Find our campaign_lead record by email + campaign
  const { data: campaignLead } = await supabase
    .from('campaign_leads')
    .select('id, lead_id, status')
    .eq('campaign_id', campaignId)
    .eq('email_used', status.email)
    .single();

  if (!campaignLead) return;

  // Map platform status to our status enum
  const newStatus = mapToOurStatus(status);
  const oldStatus = campaignLead.status;

  // Only update if status changed
  if (newStatus === oldStatus) return;

  // Update campaign_leads
  const patch: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'sent' && oldStatus === 'pending') {
    patch.sent_at = status.lastActivityAt || new Date().toISOString();
  }
  if (newStatus === 'replied' && status.replySnippet) {
    patch.reply_snippet = status.replySnippet;
  }

  await supabase
    .from('campaign_leads')
    .update(patch)
    .eq('id', campaignLead.id);

  // Update lead outreach_status
  const outreachStatus = mapToOutreachStatus(newStatus);
  if (outreachStatus) {
    await updateLead(campaignLead.lead_id, { outreach_status: outreachStatus }).catch(() => {});
  }

  // Create activity note for status transitions
  const noteContent = buildNoteContent(oldStatus, newStatus, status);
  if (noteContent) {
    await createNote(campaignLead.lead_id, {
      type: newStatus === 'replied' ? 'email_replied' : newStatus === 'bounced' ? 'email_bounced' : 'status_change',
      content: noteContent,
      metadata: {
        campaign_id: campaignId,
        old_status: oldStatus,
        new_status: newStatus,
        platform_status: status.status,
        reply_snippet: status.replySnippet,
      },
    }).catch(() => {});
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function mapToOurStatus(status: PlatformLeadStatus): 'pending' | 'sent' | 'opened' | 'replied' | 'bounced' {
  if (status.replyCount > 0 || status.status === 'replied') return 'replied';
  if (status.status === 'bounced') return 'bounced';
  if (status.openCount > 0 || status.status === 'opened') return 'opened';
  if (status.status === 'sent' || status.status === 'completed') return 'sent';
  return 'pending';
}

function mapToOutreachStatus(status: string): string | null {
  switch (status) {
    case 'sent': case 'opened': return 'contacted';
    case 'replied': return 'replied';
    default: return null;
  }
}

function buildNoteContent(oldStatus: string, newStatus: string, status: PlatformLeadStatus): string | null {
  if (newStatus === 'sent' && oldStatus === 'pending') {
    return `Email sent via platform to ${status.email}`;
  }
  if (newStatus === 'opened') {
    return `Email opened by ${status.email} (${status.openCount} opens)`;
  }
  if (newStatus === 'replied') {
    return `Reply received from ${status.email}${status.replySnippet ? `: "${status.replySnippet.slice(0, 100)}"` : ''}`;
  }
  if (newStatus === 'bounced') {
    return `Email bounced for ${status.email}`;
  }
  return null;
}

/** Trigger sync for a specific campaign on demand (e.g. from API) */
export async function syncSingleCampaign(campaignId: string): Promise<void> {
  const supabase = getSupabase();
  const platform = getEmailPlatform();

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, platform_campaign_id, email_platform')
    .eq('id', campaignId)
    .single();

  if (!campaign?.platform_campaign_id) {
    throw new Error('Campaign has no platform ID — cannot sync');
  }

  await syncCampaign(campaign.id, campaign.platform_campaign_id, platform, supabase);
}
