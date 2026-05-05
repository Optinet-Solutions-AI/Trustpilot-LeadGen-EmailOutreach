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

export type EmailSource = 'trustpilot' | 'website' | 'affiliate';

/** Resolves the primary email AND records which source the decision came from.
 *  Use this when the caller needs both — string-equality between email values
 *  isn't reliable because trustpilot_email and website_email are often the
 *  same address (e.g. support@example.com on both sources). Without source
 *  tracking, statusForPrimaryEmail would always return the higher-priority
 *  source's status even when the resolver actually fell through to a lower
 *  one. */
export function resolvePrimaryEmailWithSource(
  lead: LeadEmailFields,
): { email: string | null; source: EmailSource | null } {
  // Pass 1: verified-first.
  if (lead.trustpilot_email && lead.trustpilot_email_status === 'valid')
    return { email: lead.trustpilot_email, source: 'trustpilot' };
  if (lead.website_email && lead.website_email_status === 'valid')
    return { email: lead.website_email, source: 'website' };
  if (lead.affiliate_email && lead.affiliate_email_status === 'valid')
    return { email: lead.affiliate_email, source: 'affiliate' };

  // Pass 2: non-invalid by brand priority.
  if (lead.trustpilot_email && lead.trustpilot_email_status !== 'invalid')
    return { email: lead.trustpilot_email, source: 'trustpilot' };
  if (lead.website_email && lead.website_email_status !== 'invalid')
    return { email: lead.website_email, source: 'website' };
  if (lead.affiliate_email && lead.affiliate_email_status !== 'invalid')
    return { email: lead.affiliate_email, source: 'affiliate' };

  // Pass 3: any non-null source so we don't blank the row.
  if (lead.trustpilot_email) return { email: lead.trustpilot_email, source: 'trustpilot' };
  if (lead.website_email) return { email: lead.website_email, source: 'website' };
  if (lead.affiliate_email) return { email: lead.affiliate_email, source: 'affiliate' };

  return { email: null, source: null };
}

/** Per-source verification status that corresponds to whichever source the
 *  resolver chose. Drives the lead-level verification_status field so the
 *  wizard / send-gate / lead matrix all reflect the *displayed* email's
 *  status, not the worst-of all sources. */
export function statusForPrimaryEmail(lead: LeadEmailFields): string | null {
  const { source } = resolvePrimaryEmailWithSource(lead);
  if (!source) return null;
  if (source === 'trustpilot') return lead.trustpilot_email_status ?? null;
  if (source === 'website') return lead.website_email_status ?? null;
  return lead.affiliate_email_status ?? null;
}

export function resolvePrimaryEmail(lead: LeadEmailFields): string | null {
  return resolvePrimaryEmailWithSource(lead).email;
}
