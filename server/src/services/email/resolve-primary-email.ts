// Policy: prefer the most-verified source; within the same verification tier,
// honour the brand priority trustpilot_email > website_email > affiliate_email.
// trustpilot_email leads in a tie because it aligns with OptiRate's reputation
// pitch. website_email is the main-domain contact. affiliate_email is a
// lateral-prospecting fallback (partner pages).
//
// Three-pass cascade:
//   1) Both/any source explicitly verified as 'valid' → pick by brand priority
//      among only the valid ones. So TP=valid + website=valid → TP. But
//      TP=unknown + website=valid → website (the proven address wins).
//   2) Nothing strictly valid → fall back to non-'invalid' sources by brand
//      priority. Catches the mixed-untested case where every source is
//      status=null/unknown/catch-all.
//   3) Last resort: any non-null source so the lead isn't dropped entirely.
export type LeadEmailFields = {
  trustpilot_email: string | null;
  website_email: string | null;
  affiliate_email?: string | null;
  trustpilot_email_status?: string | null;
  website_email_status?: string | null;
  affiliate_email_status?: string | null;
};

/** Per-source verification status that corresponds to whichever address
 *  resolvePrimaryEmail picked. Used to drive the lead-level
 *  verification_status field so the wizard / send-gate / lead matrix all
 *  reflect the *displayed* email's status, not the worst-of all sources. */
export function statusForPrimaryEmail(lead: LeadEmailFields): string | null {
  const primary = resolvePrimaryEmail(lead);
  if (!primary) return null;
  if (primary === lead.trustpilot_email) return lead.trustpilot_email_status ?? null;
  if (primary === lead.website_email) return lead.website_email_status ?? null;
  if (primary === lead.affiliate_email) return lead.affiliate_email_status ?? null;
  return null;
}

export function resolvePrimaryEmail(lead: LeadEmailFields): string | null {
  const tpValid = lead.trustpilot_email_status === 'valid';
  const webValid = lead.website_email_status === 'valid';
  const affValid = lead.affiliate_email_status === 'valid';
  const tpInvalid = lead.trustpilot_email_status === 'invalid';
  const webInvalid = lead.website_email_status === 'invalid';
  const affInvalid = lead.affiliate_email_status === 'invalid';

  // Pass 1: a verified address always beats an unverified one, even from a
  // higher-priority source. So website=valid wins over trustpilot=unknown.
  if (lead.trustpilot_email && tpValid) return lead.trustpilot_email;
  if (lead.website_email && webValid) return lead.website_email;
  if (lead.affiliate_email && affValid) return lead.affiliate_email;

  // Pass 2: no source is strictly verified — fall back to any non-invalid
  // source by brand priority. Covers the common pre-verification state.
  if (lead.trustpilot_email && !tpInvalid) return lead.trustpilot_email;
  if (lead.website_email && !webInvalid) return lead.website_email;
  if (lead.affiliate_email && !affInvalid) return lead.affiliate_email;

  // Pass 3: every non-null source is invalid — return whatever exists so the
  // lead row doesn't lose its display email entirely.
  return lead.trustpilot_email || lead.website_email || lead.affiliate_email || null;
}
