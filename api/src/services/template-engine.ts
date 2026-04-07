/**
 * Simple template engine — replaces {{token}} placeholders with lead data.
 */

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

const TOKEN_MAP: Record<string, (lead: LeadData) => string> = {
  company_name: (l) => l.company_name || '',
  website_url: (l) => l.website_url || '',
  star_rating: (l) => String(l.star_rating ?? ''),
  review_count: (l) => l.review_count ? String(l.review_count) : '',
  category: (l) => l.category || '',
  country: (l) => l.country || '',
  email: (l) => l.primary_email || '',
};

export function renderTemplate(template: string, lead: LeadData): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, token) => {
    const resolver = TOKEN_MAP[token];
    return resolver ? resolver(lead) : match;
  });
}
