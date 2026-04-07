export type LeadStatus = 'new' | 'contacted' | 'replied' | 'converted' | 'lost';
export type VerificationStatus = 'valid' | 'invalid' | 'catch-all' | 'unknown';

export interface Lead {
  id: string;
  company_name: string;
  trustpilot_url: string;
  website_url: string | null;
  trustpilot_email: string | null;
  website_email: string | null;
  primary_email: string | null;
  phone: string | null;
  country: string | null;
  category: string | null;
  star_rating: number | null;
  email_verified: boolean;
  verification_status: VerificationStatus;
  outreach_status: LeadStatus;
  screenshot_path: string | null;
  lead_source: string;
  scraped_at: string | null;
  contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadNote {
  id: string;
  lead_id: string;
  type: string;
  content: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface FollowUp {
  id: string;
  lead_id: string;
  due_date: string;
  note: string | null;
  completed: boolean;
  completed_at: string | null;
  created_at: string;
  leads?: { company_name: string; outreach_status: LeadStatus };
}
