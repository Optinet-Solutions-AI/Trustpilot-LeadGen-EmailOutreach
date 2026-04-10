/**
 * Webhook receiver for third-party email platform events.
 * POST /api/webhooks/email-platform
 *
 * This route has NO auth middleware — external platforms need to reach it.
 * Validation is done via webhook secret / signature.
 */

import { Router, Request, Response } from 'express';
import { config } from '../config.js';
import { getSupabase } from '../lib/supabase.js';
import { updateLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { parseInstantlyWebhook } from '../services/email-platform/webhook-parser.js';
import type { PlatformWebhookEvent } from '../services/email-platform/types.js';

const router = Router();

router.post('/email-platform', async (req: Request, res: Response) => {
  try {
    // Validate webhook secret (if configured)
    const secret = config.instantly.webhookSecret;
    if (secret) {
      const provided = req.headers['x-webhook-secret'] || req.headers['authorization'];
      if (provided !== secret && provided !== `Bearer ${secret}`) {
        res.status(401).json({ error: 'Invalid webhook secret' });
        return;
      }
    }

    // Parse based on configured platform
    let event: PlatformWebhookEvent | null = null;

    if (config.emailPlatform === 'instantly') {
      event = parseInstantlyWebhook(req.body);
    }
    // Future: else if (config.emailPlatform === 'smartlead') { ... }

    if (!event) {
      // Unrecognized event type — acknowledge but don't process
      res.json({ received: true, processed: false });
      return;
    }

    // Process the event
    await processWebhookEvent(event);

    res.json({ received: true, processed: true });
  } catch (err) {
    console.error('[Webhook] Error processing event:', err instanceof Error ? err.message : err);
    // Always return 200 to prevent webhook retries on processing errors
    res.json({ received: true, processed: false, error: 'Processing error' });
  }
});

async function processWebhookEvent(event: PlatformWebhookEvent): Promise<void> {
  const supabase = getSupabase();

  // Find the campaign by platform campaign ID
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('platform_campaign_id', event.platformCampaignId)
    .single();

  if (!campaign) {
    console.warn(`[Webhook] No campaign found for platform ID: ${event.platformCampaignId}`);
    return;
  }

  // Find the campaign_lead by email + campaign
  const { data: campaignLead } = await supabase
    .from('campaign_leads')
    .select('id, lead_id, status')
    .eq('campaign_id', campaign.id)
    .eq('email_used', event.email)
    .single();

  if (!campaignLead) {
    console.warn(`[Webhook] No campaign_lead found for ${event.email} in campaign ${campaign.id}`);
    return;
  }

  // Map event to status update
  const statusMap: Record<string, string> = {
    email_sent: 'sent',
    email_opened: 'opened',
    email_replied: 'replied',
    email_bounced: 'bounced',
  };

  const newStatus = statusMap[event.eventType];
  if (!newStatus) return;

  // Don't downgrade status (e.g. opened → sent)
  const statusRank: Record<string, number> = { pending: 0, sent: 1, opened: 2, replied: 3, bounced: 3 };
  if ((statusRank[newStatus] ?? 0) <= (statusRank[campaignLead.status] ?? 0)) {
    // Exception: always update bounced
    if (newStatus !== 'bounced') return;
  }

  // Update campaign_leads
  const patch: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'sent') patch.sent_at = event.timestamp;
  if (newStatus === 'replied' && event.replySnippet) patch.reply_snippet = event.replySnippet;

  await supabase
    .from('campaign_leads')
    .update(patch)
    .eq('id', campaignLead.id);

  // Update lead outreach_status
  if (newStatus === 'sent' || newStatus === 'opened') {
    await updateLead(campaignLead.lead_id, { outreach_status: 'contacted' }).catch(() => {});
  } else if (newStatus === 'replied') {
    await updateLead(campaignLead.lead_id, { outreach_status: 'replied' }).catch(() => {});
  }

  // Create activity note
  const noteTypes: Record<string, string> = {
    email_sent: 'email_sent',
    email_opened: 'email_opened',
    email_replied: 'email_replied',
    email_bounced: 'email_bounced',
  };

  const noteContents: Record<string, string> = {
    email_sent: `Email sent to ${event.email} via platform`,
    email_opened: `Email opened by ${event.email}`,
    email_replied: `Reply received from ${event.email}${event.replySnippet ? `: "${event.replySnippet.slice(0, 100)}"` : ''}`,
    email_bounced: `Email bounced for ${event.email}`,
  };

  await createNote(campaignLead.lead_id, {
    type: noteTypes[event.eventType] || 'status_change',
    content: noteContents[event.eventType] || `Platform event: ${event.eventType}`,
    metadata: {
      campaign_id: campaign.id,
      event_type: event.eventType,
      platform_campaign_id: event.platformCampaignId,
      timestamp: event.timestamp,
    },
  }).catch(() => {});

  console.log(`[Webhook] ${event.eventType}: ${event.email} → ${newStatus}`);
}

export default router;
