/**
 * AI email template generator — uses Google Gemini 2.0 Flash.
 * Requires NEXT_PUBLIC_GEMINI_API_KEY environment variable.
 */

import { GoogleGenAI } from '@google/genai';

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
  /** When true, target audience is companies whose Trustpilot listing redirects
   *  to a different brand (likely rebrand or affiliate handover). The email
   *  needs to lead with that observation and ask if they're the same operator,
   *  not pitch reputation management on a stale rating. */
  redirectMode?: boolean;
  /** When true, the email is a discovery follow-up: we previously emailed
   *  this company's support inbox, got an auto-reply that disclosed the
   *  real contact email, and are now reaching out to that contact. The
   *  copy should acknowledge the prior support handoff so the recipient
   *  doesn't feel cold-pitched. */
  discoveryMode?: boolean;
  /** Human-language name (e.g. "German", "French", "Brazilian Portuguese").
   *  When set, the entire generated email — subject, body, all spintax
   *  variants, greeting, and closing — is written in this language while
   *  {{tokens}} stay verbatim. Falls back to English when undefined. */
  language?: string;
  /** When true, generate a follow-up email (shorter, references the previous
   *  email in the sequence) instead of the initial cold-outreach pitch. */
  followUpMode?: boolean;
  /** The position of this follow-up in the sequence (2 = first follow-up,
   *  3 = second, etc.). Only used when followUpMode is true. Higher numbers
   *  produce slightly more apologetic / "last attempt" framing. */
  followUpStepNumber?: number;
}

export interface GenerateTemplateResult {
  subject: string;
  body: string;
}

/**
 * Strip unmatched "{" / "}" from AI output while preserving balanced spintax
 * groups and {{token}} placeholders. Gemini occasionally drops a closing brace
 * under heavy nesting; without this sanitizer, those characters reach the
 * recipient's inbox and spam filters flag the mail as broken mail-merge.
 * Degenerate single-option groups like "{hello}" are intentionally left alone
 * here — the spintax resolver handles them correctly at send time, and
 * touching them risks corrupting {{token}} forms (the inner "{token}" would
 * match a single-option regex).
 */
export function sanitizeSpintaxBraces(text: string): string {
  const openStack: number[] = [];
  const remove = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') openStack.push(i);
    else if (c === '}') {
      if (openStack.length === 0) remove.add(i);
      else openStack.pop();
    }
  }
  for (const i of openStack) remove.add(i);
  if (remove.size === 0) return text;
  return Array.from(text).filter((_, i) => !remove.has(i)).join('');
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
    throw new Error('NEXT_PUBLIC_GEMINI_API_KEY is not set. Add it to your .env file.');
  }

  const genAI = new GoogleGenAI({ apiKey: API_KEY });

  const { country, category, minRating = 1, maxRating = 3.5, emailDomain, manualMode, redirectMode, discoveryMode, language, followUpMode, followUpStepNumber } = options;

  const companyHint = emailDomain ? `a business with the domain "${emailDomain}"` : 'a business';
  const countryLabel = country ? `in ${country}` : '';
  const categoryLabel = category ? `in the ${category.replace(/_/g, ' ')} industry` : '';
  const audienceDesc = discoveryMode
    ? `companies whose support inbox we already emailed and that auto-replied with the address of their real contact (e.g. an affiliate or partnerships manager). We are now following up with that disclosed contact ${countryLabel} ${categoryLabel}`.trim()
    : redirectMode
      ? `companies whose Trustpilot listing has a website that redirects to a different brand or domain ${countryLabel} ${categoryLabel} — likely a rebrand, an affiliate, or a new operator running the original brand`.trim()
      : manualMode
        ? `${companyHint}${countryLabel ? ' ' + countryLabel : ''}${categoryLabel ? ' ' + categoryLabel : ''}`
        : `companies ${countryLabel} ${categoryLabel} with a Trustpilot rating between ${minRating} and ${maxRating} stars`.trim();

  const ratingTokens = discoveryMode
    ? `  - {{company_name}} — company name on the Trustpilot listing\n  - {{star_rating}} — their Trustpilot star rating`
    : redirectMode
      ? `  - {{company_name}} — company name on the Trustpilot listing\n  - {{website}} — the redirect target / current website\n  - {{star_rating}} — their Trustpilot star rating (still relevant context)`
      : manualMode
        ? `  - {{company_name}} — company name (use this token, not the actual domain name)\n  - {{website}} — their website`
        : `  - {{company_name}} — company name\n  - {{star_rating}} — their current Trustpilot star rating\n  - {{review_count}} — number of reviews`;

  const bodyGuidance = discoveryMode
    ? `- Open by acknowledging that you previously sent a message to their support inbox and were directed to this address
- Reference that you found {{company_name}} on Trustpilot ({{star_rating}}/5) while researching brands in this space
- Position the email as a follow-up to the prior support handoff — NOT a fresh cold outreach
- Briefly explain what OptiRate does: helps brands fix slipping Trustpilot ratings and rebuild review velocity
- CTA must be email-only: invite a quick reply confirming whether this is the right contact and offering a free written audit. NEVER propose a phone call.`
    : redirectMode
      ? `- Open by saying you came across {{company_name}}'s Trustpilot listing while researching reputation in this space
- Note that the listed website now redirects to {{website}} (a different brand) — and ask whether they're the same operator or new owners
- Frame this as a polite, curious outreach, NOT a sales pitch on the old listing's rating
- If they ARE the same operator: offer to help them either consolidate the Trustpilot reputation under the new brand, or recover the old listing's score
- If they're new owners: offer a free audit of where the inherited reputation stands and what to do about it
- Keep the CTA low-commitment via EMAIL only (a quick reply, a short follow-up exchange) — never propose a phone call`
      : manualMode
        ? `- Open with a friendly introduction to OptiRate and why online reputation matters
- Mention how poor reviews cost businesses customers, trust, and revenue
- Position OptiRate as a partner that helps businesses turn their reputation around
- CTA must be email-only: invite a reply, offer a free written audit, suggest a short follow-up email exchange`
        : `- Open with a specific observation about their Trustpilot situation (low rating)
- Mention the concrete impact (lost customers, lower trust, less revenue)
- CTA must be email-only: invite a reply, offer a free written audit. NEVER propose a phone call.`;

  const languageDirective = language && language.toLowerCase() !== 'english'
    ? `\n=== LANGUAGE — NON-NEGOTIABLE ===\nWrite the ENTIRE email in ${language}. Every greeting, sentence, transition, CTA, closing, and EVERY spintax variant must be in ${language}. The subject line is also in ${language}. Tokens like {{company_name}}, {{star_rating}}, {{review_count}}, {{country}}, {{website}} stay EXACTLY as-is — do not translate token names. Use natural, professional ${language} as a native B2B copywriter would write it — not literal English-to-${language} translations. The "no phone call / email-only" rule below applies in ${language} too: do not propose any phone, voice, or video meeting in any phrasing.\n`
    : '';

  const followUpDirective = followUpMode
    ? `\n=== THIS IS A FOLLOW-UP — NOT A COLD OPENER ===\nThis email is follow-up #${(followUpStepNumber ?? 2) - 1} in an existing sequence. The first email already pitched OptiRate's reputation services to ${audienceDesc}. Your job here is the gentle nudge, not a fresh pitch.\n- Open by acknowledging the prior email ("just following up", "circling back", "wanted to make sure my last email didn't get lost")\n- Keep the body to 1-2 SHORT paragraphs total (3-5 sentences max — follow-ups must feel light, not pushy)\n- Add ONE fresh angle: a quick question, a soft reminder of the value, or a low-friction CTA — do NOT restate the original pitch\n- Subject line MUST signal a follow-up. Use spintax patterns like "{Re:|Follow-up:|Quick follow-up —|Checking in on} {{company_name}}" or similar\n- ${(followUpStepNumber ?? 2) >= 4 ? 'This is a LATE follow-up — adopt a softer "last note" tone, e.g. "{I won\'t keep emailing|I\'ll let this be my last note|Promise this is the last one}"' : 'Tone is friendly and patient — never accusatory or guilt-trippy'}\n- Email-only CTA still applies — never propose a phone, video, or voice call\n`
    : '';

  const prompt = `
You are a professional B2B email copywriter for OptiRate, a reputation management agency that helps businesses improve their online reputation and Trustpilot scores.

Write a ${followUpMode ? 'follow-up email in an outreach sequence' : 'cold outreach email'} targeting ${audienceDesc}.
${languageDirective}${followUpDirective}

Return your response in this EXACT format (no other text before or after):
SUBJECT: [the subject line here — one line, no quotes]
BODY:
[the HTML body here]

=== CRITICAL SPINTAX RULES — YOU MUST FOLLOW THESE EXACTLY ===

SPINTAX FORMAT: {option1|option2|option3}
Spintax can and MUST be deeply nested: {Hi|Hello|{Hey|Greetings}} {{company_name}}

BRACE BALANCE — NON-NEGOTIABLE:
- Every "{" MUST have a matching "}".
- Every spintax group MUST contain at least one "|" separator (no single-option groups like "{hello}").
- Before finalizing, mentally scan the output — if you see a "{" with no matching "}", or a "{...}" with no "|" inside, REWRITE that section before returning.
- Unclosed or single-option braces leak literal "{" characters into sent emails and trigger spam filters. This is the single most important rule.

MANDATORY: Apply spintax to ALMOST EVERY PHRASE in both the subject and body — not just a few spots.
This means:
- Every greeting, opener, and transition phrase MUST have spintax
- Every descriptive phrase MUST have spintax
- Every sentence MUST contain at least one spintax group, preferably multiple
- Closing lines MUST have spintax on every element
- Aim for ${followUpMode ? '8–15' : '10–18'} spintax groups across the full email — heavy enough for deliverability, light enough that every option keeps the sentence grammatical
- Use nested spintax frequently: {I {noticed|spotted|came across}|{Our team|We} {found|discovered|identified}}
- Vary sentence structure, synonyms, phrasing, and tone across options

TOKENS — include these organically woven into sentences (never isolated, never inside spintax braces):
${ratingTokens}
- DO NOT put {{token}} placeholders inside spintax braces — always outside
- DO NOT mention the recipient's country anywhere in the subject or body. They live there — saying "in {country}" or "{country}-based companies" sounds robotic. Use {{country}} ONLY if the user manually adds it to the template later; do NOT introduce it yourself.

=== SUBJECT REQUIREMENTS ===
- Concise and compelling (6-10 words)
- Relevant to reputation management
- The ENTIRE subject line must be wrapped in heavy spintax
- Example pattern: "{Quick question|One thing I noticed|{A thought|Something} I wanted to share} about {{company_name}}"
- Do NOT use exclamation marks or all-caps

=== BODY REQUIREMENTS ===
- Tone: professional, empathetic, consultative — NOT pushy or salesy
- Length: ${followUpMode ? '1-2 short paragraphs (3-5 sentences total — follow-ups stay LIGHT)' : `STRUCTURE — count <p> tags before returning. The BODY MUST contain EXACTLY 4 <p> tags in this order:
  1. Greeting line — ONE short line, e.g. "<p>{Hi|Hello|Hey} {{company_name}} team,</p>"
  2. First body paragraph — EXACTLY 2 sentences (no more, no less). Opens with the observation about their Trustpilot situation.
  3. Second body paragraph — EXACTLY 2 sentences (no more, no less). Contains the CTA (offer + how to respond).
  4. Signature — ONE short line, e.g. "<p>{Best|Kind} {regards|wishes},<br>{OptiRate|The OptiRate Team|OptiRate Solutions}</p>"
  ABSOLUTE LIMITS: NO 5th <p> tag. Total body text (paragraphs 2 + 3, ignoring greeting and signature) MUST be ≤ 65 words AND exactly 4 sentences. Before returning, count: "<p>" tags = 4, sentences in body paragraphs = 4, word count ≤ 65. If any check fails, REWRITE shorter. Brevity beats comprehensiveness — cut adjectives, drop hedges, kill any sentence that does not earn its place. Short sentences. Punchy. No throat-clearing.`}
${bodyGuidance}
- HARD RULE — EMAIL-ONLY OUTREACH: OptiRate does not have phone support. NEVER propose a phone call, video call, Zoom, Meet, Teams, or any voice/video meeting. Forbidden phrases include: "give me a call", "hop on a call", "quick call", "phone call", "schedule a call", "jump on a call", "would love to chat", "15-minute call", "discuss over the phone", "call you back". Replace any urge to suggest a call with an email-only equivalent: "reply to this email", "send a quick reply", "email me back", "drop me a line", "a short email exchange", "reply with your thoughts".
- The sender is ALWAYS "OptiRate" — never write "[Your Name]", "[Name]", "[Your Company]", "[Company]", "[Signature]", or any square-bracket placeholder. If you reference a sender, write "OptiRate" literally (or use it inside spintax, e.g. "{OptiRate|The OptiRate Team}").
- If the body introduces a person (e.g. "My name is …"), REWRITE to speak from the company voice instead ("we're reaching out from OptiRate …"). Never leave a human-name placeholder.
- VOICE — FIRST-PERSON PLURAL ("we", not "I"): OptiRate is a company, not an individual. Use "we / our / us" throughout the entire email. NEVER use "I / me / my / mine" anywhere in subject or body. Forbidden phrases include: "I noticed", "I came across", "I can help", "I'd like", "I wanted", "let me", "my name is", "I'm reaching out" (use "we're reaching out"). Rewrite every instance into the plural form: "we noticed", "we came across", "our team can help", "we'd like", "we wanted", "we're reaching out from OptiRate". This rule applies to every spintax variant too — every option inside every {a|b|c} group must also use "we / our / us", never "I / me / my".
- GRAMMAR INSIDE SPINTAX — every option in every {a|b|c} group MUST be grammatically valid on its own when spliced into the surrounding sentence. Mentally pick the FIRST option of every group, read the whole sentence — it must be a clean grammatical sentence. Then pick the LAST option of every group and re-read — also clean. If swapping options creates duplicate subjects (e.g. "Our team at OptiRate, we focus" — "team" and "we" both subjects), missing verbs, comma splices, or a statement that ends with a "?", REWRITE the offending group. Sentences end with "." (or "!" sparingly) — never with "?" unless they are actually questions. Each {a|b|c} option must match the same grammatical role as its siblings (all verbs, all noun phrases, all clauses — never mix verbs with full clauses inside the same braces).
- Close with heavy spintax on every element, e.g.:
  "{Best|Kind} {regards|wishes},<br>{OptiRate|The OptiRate Team|OptiRate Solutions}"
- Output ONLY the HTML body content (no <html>, <head>, <body> tags)
- Use only <p>, <strong>, <br> tags — keep it email-safe

=== EXAMPLE OF A PERFECT OUTPUT — MATCH THIS LENGTH, VOICE, AND SPINTAX DENSITY ===

The example below shows EVERY rule applied at once: exactly 4 <p> tags total, 2 body paragraphs of exactly 2 sentences each, body content ≤65 words, "we / our" voice throughout (zero "I" / "me" / "my"), tokens woven naturally and NEVER inside spintax braces, and every spintax option grammatically valid on its own. Match this STRUCTURE and LENGTH exactly — do not add a third body paragraph, do not lengthen the sentences, do not slip into "I" voice.

SUBJECT: {Quick {thought|note}|A {thought|note}} about {{company_name}}'s Trustpilot {profile|rating}

BODY:
<p>{Hi|Hello} {{company_name}} team,</p>
<p>{We spotted|Our team noticed} your Trustpilot profile while {reviewing|scanning} brands in the space, and a {{star_rating}}-star rating {costs operators new customers|sends prospects to competitors}. {At OptiRate, we help|Our team at OptiRate helps} brands rebuild their score {without buying fake reviews|without gaming the system}.</p>
<p>{Would you be open to|Happy to send} a short written audit — {we'll outline|we can break down} {what's pulling your score down|where reviews are dropping off} and the fastest fixes. {Reply to this email|Drop us a quick reply} and {we'll send it within 24 hours|we'll have it in your inbox tomorrow}.</p>
<p>{Best|Kind} {regards|wishes},<br>{OptiRate|The OptiRate Team}</p>

Pick the FIRST option of every spintax group and re-read the email — every sentence must be grammatically valid English. Pick the LAST option of every group and re-read — also valid English. If any combination breaks grammar (duplicate subjects like "Our team … we", missing verbs, "?" on a statement, mismatched parts of speech inside the same {a|b|c}), REWRITE that group.

KEY STRUCTURAL RULES SHOWN ABOVE — REPEAT THEM:
- 4 <p> tags total: greeting + body para 1 (2 sentences) + body para 2 (2 sentences) + signature
- Body content (the two middle <p>s) is ≤65 words combined
- "we / our" everywhere — zero "I" / "me" / "my" / "mine"
- 10–18 spintax groups across the email (heavy but not so dense it breaks grammar)
- Every spintax option works when picked alone — same part of speech across siblings inside one {a|b|c}
- Tokens ({{company_name}}, {{star_rating}}) are woven into sentences, NEVER placed inside spintax braces. {{country}} is intentionally NOT used — recipients know what country they're in.
- Email-only CTA ("reply to this email") — no calls, no Zoom, no meetings
- Signature paragraph is its own <p>
`.trim();

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { temperature: 0.8 },
  });

  const raw = (result.text ?? '')
    .replace(/^```html?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();

  const subjectMatch = raw.match(/^SUBJECT:\s*(.+)$/m);
  const bodyMatch = raw.match(/^BODY:\s*\n([\s\S]+)/m);

  const rawSubject = subjectMatch ? subjectMatch[1].trim() : 'A quick note about {{company_name}}';
  const rawBody = bodyMatch ? bodyMatch[1].trim() : raw;

  // Repair any malformed spintax the model may have emitted before the
  // template leaves this function — strips unmatched braces and degenerate
  // single-option groups. Prevents the "{Would you be open..." spam-flag bug.
  return {
    subject: sanitizeSpintaxBraces(rawSubject),
    body: sanitizeSpintaxBraces(rawBody),
  };
}
