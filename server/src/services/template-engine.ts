/**
 * Template engine — replaces {{token}} placeholders with lead data,
 * then resolves {spintax|variations} for unique email content.
 *
 * Empty tokens fall back to sensible generic phrases rather than the
 * empty string, because literal gaps like "with a -star rating" or
 * "businesses in ." are strong spam signals and instantly tank
 * deliverability to Gmail / Outlook.
 */

import { resolveSpintax } from './spintax.js';

interface LeadData {
  company_name?: string;
  website_url?: string;
  star_rating?: number;
  review_count?: number;
  category?: string;
  country?: string;
  primary_email?: string;
  [key: string]: unknown;
}

function safeCompanyName(raw?: string): string {
  if (!raw || !raw.trim()) return 'your team';
  // Capitalize lowercase single-word names (e.g. "gmail" → "Gmail") so the
  // rendered copy doesn't look like a raw database field.
  const trimmed = raw.trim();
  if (/^[a-z]+$/.test(trimmed)) return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return trimmed;
}

const TOKEN_MAP: Record<string, (lead: LeadData) => string> = {
  // Sensible generic fallbacks — keep the sentence readable when a field is empty
  company_name: (l) => safeCompanyName(l.company_name),
  website_url:  (l) => l.website_url || 'your website',
  star_rating:  (l) => l.star_rating != null ? String(l.star_rating) : 'below-average',
  review_count: (l) => l.review_count ? String(l.review_count) : 'your',
  category:     (l) => l.category || 'your industry',
  country:      (l) => l.country || 'your market',
  email:        (l) => l.primary_email || '',
};

/**
 * Strip literal bracket placeholders that LLMs occasionally inject
 * ("[Your Name]", "[Name]", "[Your Company]", "[Signature]") and replace
 * them with the configured sender brand. Matches both square and curly
 * bracket forms. Case-insensitive.
 */
function stripSenderPlaceholders(text: string): string {
  const brand = process.env.EMAIL_FROM_NAME?.trim() || 'OptiRate';
  const patterns = [
    /\[\s*your\s+name\s*\]/gi,
    /\[\s*your\s+full\s+name\s*\]/gi,
    /\[\s*name\s*\]/gi,
    /\[\s*your\s+company(?:\s+name)?\s*\]/gi,
    /\[\s*company(?:\s+name)?\s*\]/gi,
    /\[\s*signature\s*\]/gi,
    /\[\s*sender(?:\s+name)?\s*\]/gi,
  ];
  return patterns.reduce((acc, re) => acc.replace(re, brand), text);
}

export function renderTemplate(template: string, lead: LeadData): string {
  const withTokens = template.replace(/\{\{(\w+)\}\}/g, (match, token) => {
    const resolver = TOKEN_MAP[token];
    return resolver ? resolver(lead) : match;
  });
  return stripSenderPlaceholders(withTokens);
}

/**
 * Full pipeline: token replacement first, then spintax resolution.
 * Order matters — {{tokens}} must resolve before spintax picks alternatives.
 * Usage in templates: "{Hi|Hello} {{company_name}}, {I noticed|I saw} your {profile|page}..."
 */
export function renderAndSpin(template: string, lead: LeadData): string {
  const tokenResolved = renderTemplate(template, lead);
  return resolveSpintax(tokenResolved);
}
