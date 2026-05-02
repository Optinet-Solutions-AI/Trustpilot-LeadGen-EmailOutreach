export type LeadStatus = 'new' | 'contacted' | 'replied' | 'converted' | 'lost';
export type VerificationStatus = 'valid' | 'invalid' | 'catch-all' | 'unknown';
export type LinkStatus = 'VALID' | 'FLAGGED_DEAD' | 'FLAGGED_REMOVED' | 'UNKNOWN';
export type SmtpProbeResult =
  | '250'
  | '550'
  | 'unknown'
  | 'skipped_catchall'
  | 'skipped_giant'
  | 'skipped_no_mx'
  | 'error';

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
  trustpilot_email_status: VerificationStatus | null;
  website_email_status: VerificationStatus | null;
  // Per-stage breakdown — populated by the layered validator (Stage 1–5).
  // Surfaced in the UI tooltip so the user can see *why* a verdict landed.
  verify_syntax_ok: boolean | null;
  verify_mx_ok: boolean | null;
  verify_smtp_result: SmtpProbeResult | null;
  verify_zerobounce_result: VerificationStatus | null;
  verified_at: string | null;
  outreach_status: LeadStatus;
  link_status: LinkStatus;
  last_validated_at: string | null;
  link_validation_error: string | null;
  screenshot_path: string | null;
  profile_claimed: boolean | null;
  tags: string[];
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
