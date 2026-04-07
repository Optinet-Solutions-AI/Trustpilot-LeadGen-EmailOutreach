/**
 * Gemini AI — generates professional cold outreach email templates.
 * Uses Google Generative AI SDK (gemini-2.0-flash).
 * Requires VITE_GEMINI_API_KEY environment variable.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY as string;

export interface GenerateTemplateOptions {
  country?: string;
  category?: string;
  minRating?: number;
  maxRating?: number;
}

/**
 * Generate a professional HTML email body for OptiRate cold outreach.
 * Returns HTML string with {{company_name}}, {{star_rating}}, {{review_count}} tokens.
 */
export async function generateEmailTemplate(options: GenerateTemplateOptions = {}): Promise<string> {
  if (!API_KEY) {
    throw new Error('VITE_GEMINI_API_KEY is not set. Add it to your .env file.');
  }

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const { country, category, minRating = 1, maxRating = 3.5 } = options;

  const countryLabel = country ? `companies in ${country}` : 'companies';
  const categoryLabel = category ? `in the ${category.replace(/_/g, ' ')} industry` : '';
  const ratingLabel = `with a Trustpilot rating between ${minRating} and ${maxRating} stars`;

  const prompt = `
You are a professional B2B email copywriter for OptiRate, a reputation management agency that helps businesses improve their Trustpilot scores.

Write a cold outreach HTML email body targeting ${countryLabel} ${categoryLabel} ${ratingLabel}.

Requirements:
- Tone: professional, empathetic, consultative — NOT pushy or salesy
- Length: 3-4 short paragraphs
- Open with a specific observation about their Trustpilot situation
- Mention the concrete impact (lost customers, lower trust, less revenue)
- Offer a clear, low-commitment CTA (quick call, no obligation)
- Close with OptiRate brand: "Best regards,<br>OptiRate<br>www.optiratesolutions.com"
- Use these exact placeholder tokens where appropriate:
  - {{company_name}} — company name
  - {{star_rating}} — their current star rating
  - {{review_count}} — number of reviews
- Output ONLY the HTML body content (no <html>, <head>, <body> tags)
- Use only <p>, <strong>, <br> tags — keep it email-safe
- Do NOT include a subject line
`.trim();

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  // Strip any markdown code fences if Gemini wraps the output
  return text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
}
