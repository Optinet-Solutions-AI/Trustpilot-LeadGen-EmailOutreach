export type CampaignStatus = 'draft' | 'sent' | 'completed';

export interface Campaign {
  id: string;
  name: string;
  template_subject: string | null;
  template_body: string | null;
  include_screenshot: boolean;
  status: CampaignStatus;
  total_sent: number;
  total_opened: number;
  total_replied: number;
  total_bounced: number;
  sent_at: string | null;
  created_at: string;
}

export interface CampaignLead {
  id: string;
  campaign_id: string;
  lead_id: string;
  email_used: string | null;
  status: 'pending' | 'sent' | 'opened' | 'replied' | 'bounced';
  sent_at: string | null;
}
