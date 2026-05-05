// Policy: trustpilot_email > website_email > affiliate_email.
// trustpilot_email leads because it's the review-focused inbox aligning with
// the OptiRate reputation-management pitch. website_email is the main-domain
// contact. affiliate_email is a lateral-prospecting fallback (partner pages).
// If a preferred source has *_email_status='invalid', skip it. As a last
// resort, return any non-null source so we don't drop the lead entirely.
export type LeadEmailFields = {
  trustpilot_email: string | null;
  website_email: string | null;
  affiliate_email?: string | null;
  trustpilot_email_status?: string | null;
  website_email_status?: string | null;
  affiliate_email_status?: string | null;
};

export function resolvePrimaryEmail(lead: LeadEmailFields): string | null {
  const tpInvalid = lead.trustpilot_email_status === 'invalid';
  const webInvalid = lead.website_email_status === 'invalid';
  const affInvalid = lead.affiliate_email_status === 'invalid';
  if (lead.trustpilot_email && !tpInvalid) return lead.trustpilot_email;
  if (lead.website_email && !webInvalid) return lead.website_email;
  if (lead.affiliate_email && !affInvalid) return lead.affiliate_email;
  return lead.trustpilot_email || lead.website_email || lead.affiliate_email || null;
}
