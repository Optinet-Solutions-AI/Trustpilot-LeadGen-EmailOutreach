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
  total_bounced: number;
  lead_count: number;
  sent_at: string | null;
  created_at: string;
  /** Number of follow-up steps (0 = single email, 1+ = has sequence) */
  step_count: number;
  /** Platform integration — set when campaign is managed by Instantly/Smartlead */
  platform_campaign_id?: string | null;
  email_platform?: string | null;
}

export interface CampaignLead {
  id: string;
  campaign_id: string;
  lead_id: string;
  email_used: string | null;
  status: 'pending' | 'sent' | 'opened' | 'replied' | 'bounced';
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
