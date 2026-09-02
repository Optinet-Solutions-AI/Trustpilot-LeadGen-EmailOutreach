export type CampaignStatus = 'draft' | 'sending' | 'sent' | 'completed' | 'active' | 'paused';

export interface Campaign {
  id: string;
  name: string;
  template_subject: string | null;
  template_body: string | null;
  include_screenshot: boolean;
  filter_country: string | null;
  filter_category: string | null;
  status: CampaignStatus;
  total_sent: number;
  total_opened: number;
  total_replied: number;
  /** Auto-routed contact info from auto-replies (added in migration 028).
   *  Tracked separately from total_replied so reply-rate metrics stay
   *  human-only. */
  total_auto_replied?: number;
  total_bounced: number;
  lead_count: number;
  sent_at: string | null;
  created_at: string;
  /** Number of follow-up steps (0 = single email, 1+ = has sequence) */
  step_count: number;
  /** 'outreach' (default) or 'discovery_followup' (set by the Prospects view). */
  campaign_type?: 'outreach' | 'discovery_followup';
  parent_campaign_id?: string | null;
  /** Platform integration — set when campaign is managed by Instantly/Smartlead */
  platform_campaign_id?: string | null;
  email_platform?: string | null;
  /** Sending schedule window (timezone, hours, days, dailyLimit) */
  sending_schedule?: {
    timezone: string;
    startHour: string;
    endHour: string;
    days: number[];
    dailyLimit: number;
    /** Accounts to rotate through ('__env__' = primary env account). */
    senderAccountIds?: string[];
    /** @deprecated superseded by senderAccountIds; still present on older rows. */
    senderAccountId?: string;
  } | null;
}

/**
 * A template rendered exactly as it would send, returned by
 * POST /api/campaigns/preview. Produced by the server's own renderAndSpin,
 * so `html` is the real message body — spintax already collapsed to one
 * variant, tokens filled from the resolved lead, screenshot appended.
 */
export interface EmailPreview {
  subject: string;
  /** Full HTML body, screenshot <img> and provider opt-out line included. */
  html: string;
  /** Resolved recipient, or null when the lead carries no address. */
  to: string | null;
  fromEmail: string;
  fromName: string;
  companyName: string;
  screenshotUrl: string | null;
  /** True when no real lead was resolved and stand-in data was used. */
  isSample: boolean;
  /** Deliverability problems worth surfacing before the user sends. */
  warnings: string[];
}

export interface CampaignLead {
  id: string;
  campaign_id: string;
  lead_id: string;
  email_used: string | null;
  status: 'pending' | 'sent' | 'opened' | 'replied' | 'auto_replied' | 'bounced';
  sent_at: string | null;
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  reply_snippet?: string | null;
}

export interface CampaignStep {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  template_subject: string;
  template_body: string;
  created_at: string;
}

/** Follow-up step input (before saving — no id yet) */
export interface FollowUpStepInput {
  delayDays: number;
  subject: string;
  body: string;
}

export interface CampaignSendProgress {
  campaignId: string;
  stage: 'connected' | 'started' | 'sent' | 'completed' | 'failed' | 'cancelled';
  emailIndex?: number;
  total?: number;
  sent?: number;
  failed?: number;
  to?: string;
  success?: boolean;
  error?: string;
  testMode?: boolean;
}
