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
  // Email discovered by the lateral-prospecting fallback (affiliate/partner
  // page, e.g. roosterpartners.com from spinjo.com). Distinct from
  // website_email so source provenance is preserved per email.
  affiliate_email: string | null;
  primary_email: string | null;
  phone: string | null;
  country: string | null;
  category: string | null;
  star_rating: number | null;
  email_verified: boolean;
  verification_status: VerificationStatus;
  trustpilot_email_status: VerificationStatus | null;
  website_email_status: VerificationStatus | null;
  affiliate_email_status: VerificationStatus | null;
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
  // Set when the live website redirects to a different registrable domain.
  // Leads with this populated are surfaced on the dedicated Redirected Leads
  // page so users can decide whether to send a different cold-outreach
  // template (or skip them entirely) — the regular Lead Matrix excludes them.
  redirects_to: string | null;
  tags: string[];
  lead_source: string;
  scraped_at: string | null;
  contacted_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined when the Leads API is filtered by ?platform=. For social
  // platforms this carries the canonical profile URL so the Lead Matrix
  // can render a clickable link in lieu of trustpilot_url.
  lead_platform_presences?: Array<{
    platform: string;
    profile_url: string;
    author_handle: string | null;
    is_business_profile: boolean | null;
  }>;
  // All posts we've observed this author in. The Lead Matrix surfaces
  // the most-recent one as a 'View post' link. Empty for review-platform
  // leads (Trustpilot/Yelp/TripAdvisor don't write to lead_platform_posts).
  lead_platform_posts?: Array<{
    post_url: string;
    content_excerpt: string | null;
    posted_at: string | null;
    scraped_at: string | null;
    // FB group context — used by the Lead Matrix to build a deep-link
    // back to the in-group search when post_url is synthetic (text-only
    // posts don't expose a true permalink in FB's group-search DOM).
    group_id: string | null;
    group_name: string | null;
  }>;
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
