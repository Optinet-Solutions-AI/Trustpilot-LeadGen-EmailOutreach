/**
 * Gemini AI — generates professional cold outreach email templates.
 * Uses Google Generative AI SDK (gemini-2.0-flash).
 * Requires NEXT_PUBLIC_GEMINI_API_KEY environment variable.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY as string;

export interface GenerateTemplateOptions {
  country?: string;
  category?: string;
  minRating?: number;
  maxRating?: number;
  /** Email domain of the recipient (e.g. "acmecorp.com") — used for manual leads */
  emailDomain?: string;
  /** When true, no Trustpilot rating context is available — generates a more generic intro */
  manualMode?: boolean;
}

export interface GenerateTemplateResult {
  subject: string;
  body: string;
}

/** Extract a human-readable company name from a domain (e.g. "acme-corp.com" → "Acme Corp") */
export function domainToCompanyName(domain: string): string {
  const base = domain.split('.')[0];
  return base
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Generate a professional HTML email subject + body for OptiRate cold outreach.
 * Returns { subject, body } with {{company_name}}, {{star_rating}} tokens and spintax.
 */
export async function generateEmailTemplate(options: GenerateTemplateOptions = {}): Promise<GenerateTemplateResult> {
  if (!API_KEY) {
    throw new Error('NEXT_PUBLIC_GEMINI_API_KEY is not set. Add it to your .env.local file.');
  }

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const { country, category, minRating = 1, maxRating = 3.5, emailDomain, manualMode } = options;

  const companyHint = emailDomain ? `a business with the domain "${emailDomain}"` : 'a business';
  const countryLabel = country ? `in ${country}` : '';
  const categoryLabel = category ? `in the ${category.replace(/_/g, ' ')} industry` : '';
  const audienceDesc = manualMode
    ? `${companyHint}${countryLabel ? ' ' + countryLabel : ''}${categoryLabel ? ' ' + categoryLabel : ''}`
    : `companies ${countryLabel} ${categoryLabel} with a Trustpilot rating between ${minRating} and ${maxRating} stars`.trim();

  const ratingTokens = manualMode
    ? `  - {{company_name}} — company name (use this token, not the actual domain name)\n  - {{website}} — their website`
    : `  - {{company_name}} — company name\n  - {{star_rating}} — their current Trustpilot star rating\n  - {{review_count}} — number of reviews`;

  const bodyGuidance = manualMode
    ? `- Open with a friendly introduction to OptiRate and why online reputation matters
- Mention how poor reviews cost businesses customers, trust, and revenue
- Position OptiRate as a partner that helps businesses turn their reputation around
- Offer a clear, low-commitment CTA (quick call, free audit, no obligation)`
    : `- Open with a specific observation about their Trustpilot situation (low rating)
- Mention the concrete impact (lost customers, lower trust, less revenue)
- Offer a clear, low-commitment CTA (quick call, no obligation)`;

  const prompt = `
You are a professional B2B email copywriter for OptiRate, a reputation management agency that helps businesses improve their online reputation and Trustpilot scores.

Write a cold outreach email targeting ${audienceDesc}.

Return your response in this EXACT format (no other text before or after):
SUBJECT: [the subject line here — one line, no quotes]
BODY:
[the HTML body here]

Requirements for the SUBJECT:
- Concise and compelling (6-10 words)
- Relevant to reputation management
- Use spintax for variation: e.g. "{Quick question|One thing I noticed|A thought} about {{company_name}}"
- Do NOT use exclamation marks or all-caps

Requirements for the BODY:
- Tone: professional, empathetic, consultative — NOT pushy or salesy
- Length: 3-4 short paragraphs
${bodyGuidance}
- Close with: "{Best regards|Kind regards|Best},<br>OptiRate<br>www.optiratesolutions.com"
- Use these exact placeholder tokens:
${ratingTokens}
- Use spintax {option1|option2|option3} throughout for variation (at least 5-8 groups)
  Examples: "{Hi|Hello|Hey}", "{We noticed|I came across|Our team spotted}", "{Would you be open to|Could we schedule|How about}"
  Do NOT put spintax inside {{token}} placeholders
- Output ONLY the HTML body content (no <html>, <head>, <body> tags)
- Use only <p>, <strong>, <br> tags — keep it email-safe
`.trim();

  const result = await model.generateContent(prompt);
  const raw = result.response.text().replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();

  // Parse structured response
  const subjectMatch = raw.match(/^SUBJECT:\s*(.+)$/m);
  const bodyMatch = raw.match(/^BODY:\s*\n([\s\S]+)/m);

  const subject = subjectMatch ? subjectMatch[1].trim() : 'A quick note about {{company_name}}';
  const body = bodyMatch ? bodyMatch[1].trim() : raw;

  return { subject, body };
}
