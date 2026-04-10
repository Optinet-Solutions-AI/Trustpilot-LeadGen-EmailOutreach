/**
 * Webhook payload parser — normalizes provider-specific webhook bodies
 * into our standard PlatformWebhookEvent format.
 */

import type { PlatformWebhookEvent } from './types.js';

/**
 * Parse an Instantly.ai webhook payload.
 * Instantly sends events for: email_sent, email_opened, email_replied, email_bounced
 */
export function parseInstantlyWebhook(body: Record<string, unknown>): PlatformWebhookEvent | null {
  // Instantly webhook payload shape (v2):
  // { event_type, email, campaign_id, timestamp, data: { reply_snippet?, ... } }
  const eventType = mapInstantlyEventType(String(body.event_type || ''));
  if (!eventType) return null;

  return {
    eventType,
    email: String(body.email || ''),
    platformCampaignId: String(body.campaign_id || ''),
    timestamp: String(body.timestamp || new Date().toISOString()),
    replySnippet: (body.data as Record<string, unknown>)?.reply_snippet
      ? String((body.data as Record<string, unknown>).reply_snippet)
      : undefined,
    payload: body,
  };
}

function mapInstantlyEventType(type: string): PlatformWebhookEvent['eventType'] | null {
  switch (type) {
    case 'email_sent': return 'email_sent';
    case 'email_opened': return 'email_opened';
    case 'email_replied': return 'email_replied';
    case 'email_bounced': return 'email_bounced';
    case 'lead_unsubscribed': return 'lead_unsubscribed';
    default: return null;
  }
}
