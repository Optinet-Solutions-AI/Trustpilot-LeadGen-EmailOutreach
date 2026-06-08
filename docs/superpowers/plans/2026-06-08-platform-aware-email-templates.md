# Platform-Aware AI Email Template Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the campaign wizard's "Generate with AI" produce email copy tailored to the campaign's platform (Trustpilot / TripAdvisor / Yelp), and remove the "All Platforms" option so every campaign is single-platform.

**Architecture:** A typed `PLATFORM_PROFILES` config map in `frontend/src/lib/gemini.ts` holds each platform's name, rating wording, audience noun, and pitch angle. The prompt assembly is extracted into a pure `buildPrompt(options)` function whose normal cold-outreach branch reads from the profile; the existing `discoveryMode`/`redirectMode`/`manualMode` branches keep their current (Trustpilot) wording and still take precedence. The wizard threads its existing `filterPlatform` value into the generator and into three hardcoded "Trustpilot" UI strings.

**Tech Stack:** TypeScript, React, Next.js (frontend). Verifier: Google Gemini via `@google/genai`. No backend/DB changes. No test runner exists in the frontend — verification is `tsc --noEmit` + a throwaway `tsx` prompt check + manual smoke.

**Spec:** `docs/superpowers/specs/2026-06-08-platform-aware-email-template-generation-design.md`

**Branch:** `feat/platform-aware-email-templates` (already created; the spec commit is its first commit).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/lib/gemini.ts` | AI prompt construction + Gemini call | Add platform types + `PLATFORM_PROFILES`; add `platform` option; extract pure `buildPrompt`; make the cold-outreach branch profile-driven |
| `frontend/src/components/campaign-wizard/CampaignWizard.tsx` | Wizard state orchestrator | Default `filterPlatform` to `'trustpilot'`; pass it to `WizardStep2Sequence` |
| `frontend/src/components/campaign-wizard/WizardStep1Leads.tsx` | Step 1 — lead pool + platform picker | Remove the "All Platforms" option |
| `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx` | Step 2 — email sequence editor + AI generate | Accept `filterPlatform`; pass `platform` to both generate calls; platform-name the 3 hardcoded UI strings |

Live caller of `generateEmailTemplate` is `WizardStep2Sequence` only. `StepTemplate.tsx` and `CampaignBuilder.tsx` also call it but are dead code (zero imports) — do not touch them.

---

## Task 1: Add platform types, `PLATFORM_PROFILES`, and the `platform` option

**Files:**
- Modify: `frontend/src/lib/gemini.ts`

Pure additions — no behavior change yet. The new map and option are not wired into the prompt until Task 2.

- [ ] **Step 1: Add the `platform` field to `GenerateTemplateOptions`**

In `frontend/src/lib/gemini.ts`, inside the `GenerateTemplateOptions` interface, add this field directly after the `followUpStepNumber` field (the last one, around line 41):

```ts
  /** Platform the campaign targets — selects the tailored pitch from
   *  PLATFORM_PROFILES. Accepts 'trustpilot' | 'tripadvisor' | 'yelp';
   *  any other/absent value falls back to 'trustpilot' (preserves the
   *  original Trustpilot copy for callers that don't pass a platform). */
  platform?: string;
```

- [ ] **Step 2: Add the platform types and profile map**

In `frontend/src/lib/gemini.ts`, immediately after the `import { GoogleGenAI } ...` line and the `const API_KEY = ...` line (around line 8, before the `GenerateTemplateOptions` interface), add:

```ts
export type PlatformSlug = 'trustpilot' | 'tripadvisor' | 'yelp';

export interface PlatformProfile {
  /** Human platform name woven into the copy, e.g. 'TripAdvisor'. */
  displayName: string;
  /** Noun phrase for the {{star_rating}} token description. */
  ratingWord: string;
  /** Subject of the audience clause, e.g. 'local service businesses'. */
  audienceNoun: string;
  /** The distinct pitch angle for this platform (body-guidance lead-in). */
  pitchObservation: string;
  /** Description for the {{review_count}} token. */
  reviewCountDesc: string;
}

/** Per-platform copy atoms. Add an entry here when a new scraping platform
 *  (e.g. Facebook / Instagram) goes live. */
export const PLATFORM_PROFILES: Record<PlatformSlug, PlatformProfile> = {
  trustpilot: {
    displayName: 'Trustpilot',
    ratingWord: 'their current Trustpilot star rating',
    audienceNoun: 'companies',
    pitchObservation:
      'a low Trustpilot score makes online shoppers hesitate at checkout and erodes trust before they buy',
    reviewCountDesc: 'number of reviews',
  },
  tripadvisor: {
    displayName: 'TripAdvisor',
    ratingWord: 'their current TripAdvisor rating (out of 5)',
    audienceNoun: 'hospitality businesses (restaurants, hotels, attractions)',
    pitchObservation:
      'travelers filter and sort by rating before booking, so a low TripAdvisor rating quietly sends bookings to higher-rated competitors',
    reviewCountDesc: 'number of traveler reviews',
  },
  yelp: {
    displayName: 'Yelp',
    ratingWord: 'their current Yelp star rating',
    audienceNoun: 'local service businesses',
    pitchObservation:
      'most locals check Yelp before choosing, so the rating decides whether they call you or the next listing',
    reviewCountDesc: 'number of reviews',
  },
};
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no errors). The new symbols are exported and unused so far — that is fine.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/gemini.ts
git commit -m "feat(campaigns): add PLATFORM_PROFILES map + platform option to template generator"
```

---

## Task 2: Extract `buildPrompt` and make the cold-outreach branch platform-aware

**Files:**
- Modify: `frontend/src/lib/gemini.ts`

This extracts the existing prompt-assembly code (currently inside `generateEmailTemplate`, lines ~97–234) into a pure exported `buildPrompt`, changing only the platform-default branches and the platform-name mentions. The special-mode branches (`discoveryMode`/`redirectMode`/`manualMode`) are copied verbatim and keep their Trustpilot wording.

- [ ] **Step 1: Create the pure `buildPrompt` function**

In `frontend/src/lib/gemini.ts`, add the following function ABOVE `generateEmailTemplate`. It is the current prompt-assembly logic, with five platform changes marked `// PLATFORM:`. Copy the unchanged blocks exactly from the existing `generateEmailTemplate`.

```ts
/**
 * Build the Gemini prompt for a cold-outreach (or follow-up) email.
 * Pure — no network, no API key needed — so the output can be inspected
 * deterministically. The normal cold-outreach branch is tailored per
 * platform via PLATFORM_PROFILES; discovery/redirect/manual modes keep
 * their original (Trustpilot) wording and still take precedence.
 */
export function buildPrompt(options: GenerateTemplateOptions = {}): string {
  const { country, category, minRating = 1, maxRating = 3.5, emailDomain, manualMode, redirectMode, discoveryMode, language, followUpMode, followUpStepNumber } = options;

  // PLATFORM: resolve the profile (fallback to trustpilot for unknown/absent).
  const slug: PlatformSlug =
    options.platform && options.platform in PLATFORM_PROFILES
      ? (options.platform as PlatformSlug)
      : 'trustpilot';
  const profile = PLATFORM_PROFILES[slug];
  // Special modes are inherently Trustpilot-framed flows — force the brand
  // name back to Trustpilot for them regardless of the selected platform.
  const specialMode = !!(discoveryMode || redirectMode);
  const brandPlatform = specialMode ? 'Trustpilot' : profile.displayName;

  const companyHint = emailDomain ? `a business with the domain "${emailDomain}"` : 'a business';
  const countryLabel = country ? `in ${country}` : '';
  const categoryLabel = category ? `in the ${category.replace(/_/g, ' ')} industry` : '';
  const audienceDesc = discoveryMode
    ? `companies whose support inbox we already emailed and that auto-replied with the address of their real contact (e.g. an affiliate or partnerships manager). We are now following up with that disclosed contact ${countryLabel} ${categoryLabel}`.trim()
    : redirectMode
      ? `companies whose Trustpilot listing has a website that redirects to a different brand or domain ${countryLabel} ${categoryLabel} — likely a rebrand, an affiliate, or a new operator running the original brand`.trim()
      : manualMode
        ? `${companyHint}${countryLabel ? ' ' + countryLabel : ''}${categoryLabel ? ' ' + categoryLabel : ''}`
        // PLATFORM: profile-driven audience noun + platform name.
        : `${profile.audienceNoun} ${countryLabel} ${categoryLabel} with a ${profile.displayName} rating between ${minRating} and ${maxRating} stars`.trim();

  const ratingTokens = discoveryMode
    ? `  - {{company_name}} — company name on the Trustpilot listing\n  - {{star_rating}} — their Trustpilot star rating`
    : redirectMode
      ? `  - {{company_name}} — company name on the Trustpilot listing\n  - {{website}} — the redirect target / current website\n  - {{star_rating}} — their Trustpilot star rating (still relevant context)`
      : manualMode
        ? `  - {{company_name}} — company name (use this token, not the actual domain name)\n  - {{website}} — their website`
        // PLATFORM: profile-driven rating + review-count descriptions.
        : `  - {{company_name}} — company name\n  - {{star_rating}} — ${profile.ratingWord}\n  - {{review_count}} — ${profile.reviewCountDesc}`;

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
        // PLATFORM: profile-driven observation + pitch angle.
        : `- Open with a specific observation about their ${profile.displayName} rating — ${profile.pitchObservation}
- Mention the concrete impact (lost customers, lower trust, less revenue)
- CTA must be email-only: invite a reply, offer a free written audit. NEVER propose a phone call.`;

  const languageDirective = language && language.toLowerCase() !== 'english'
    ? `\n=== LANGUAGE — NON-NEGOTIABLE ===\nWrite the ENTIRE email in ${language}. Every greeting, sentence, transition, CTA, closing, and EVERY spintax variant must be in ${language}. The subject line is also in ${language}. Tokens like {{company_name}}, {{star_rating}}, {{review_count}}, {{country}}, {{website}} stay EXACTLY as-is — do not translate token names. Use natural, professional ${language} as a native B2B copywriter would write it — not literal English-to-${language} translations. The "no phone call / email-only" rule below applies in ${language} too: do not propose any phone, voice, or video meeting in any phrasing.\n`
    : '';

  const followUpDirective = followUpMode
    ? `\n=== THIS IS A FOLLOW-UP — NOT A COLD OPENER ===\nThis email is follow-up #${(followUpStepNumber ?? 2) - 1} in an existing sequence. The first email already pitched OptiRate's reputation services to ${audienceDesc}. Your job here is the gentle nudge, not a fresh pitch.\n- Open by acknowledging the prior email ("just following up", "circling back", "wanted to make sure my last email didn't get lost")\n- Keep the body to 1-2 SHORT paragraphs total (3-5 sentences max — follow-ups must feel light, not pushy)\n- Add ONE fresh angle: a quick question, a soft reminder of the value, or a low-friction CTA — do NOT restate the original pitch\n- Subject line MUST signal a follow-up. Use spintax patterns like "{Re:|Follow-up:|Quick follow-up —|Checking in on} {{company_name}}" or similar\n- ${(followUpStepNumber ?? 2) >= 4 ? 'This is a LATE follow-up — adopt a softer "last note" tone, e.g. "{I won\'t keep emailing|I\'ll let this be my last note|Promise this is the last one}"' : 'Tone is friendly and patient — never accusatory or guilt-trippy'}\n- Email-only CTA still applies — never propose a phone, video, or voice call\n`
    : '';

  return `
You are a professional B2B email copywriter for OptiRate, a reputation management agency that helps businesses improve their online reputation and ${brandPlatform} scores.

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
  2. First body paragraph — EXACTLY 2 sentences (no more, no less). Opens with the observation about their ${brandPlatform} situation.
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

SUBJECT: {Quick {thought|note}|A {thought|note}} about {{company_name}}'s ${brandPlatform} {profile|rating}

BODY:
<p>{Hi|Hello} {{company_name}} team,</p>
<p>{We spotted|Our team noticed} your ${brandPlatform} profile while {reviewing|scanning} brands in the space, and a {{star_rating}}-star rating {costs operators new customers|sends prospects to competitors}. {At OptiRate, we help|Our team at OptiRate helps} brands rebuild their score {without buying fake reviews|without gaming the system}.</p>
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
}
```

- [ ] **Step 2: Replace the body of `generateEmailTemplate` to call `buildPrompt`**

In `frontend/src/lib/gemini.ts`, replace the entire body of `generateEmailTemplate` (everything from `const genAI = new GoogleGenAI(...)` down to the closing `}`, i.e. the old destructuring + companyHint + audienceDesc + ratingTokens + bodyGuidance + languageDirective + followUpDirective + the inline `const prompt = ...`) so the function reads exactly:

```ts
export async function generateEmailTemplate(options: GenerateTemplateOptions = {}): Promise<GenerateTemplateResult> {
  if (!API_KEY) {
    throw new Error('NEXT_PUBLIC_GEMINI_API_KEY is not set. Add it to your .env file.');
  }

  const genAI = new GoogleGenAI({ apiKey: API_KEY });
  const prompt = buildPrompt(options);

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

  return {
    subject: sanitizeSpintaxBraces(rawSubject),
    body: sanitizeSpintaxBraces(rawBody),
  };
}
```

- [ ] **Step 3: Write the throwaway prompt-check script**

Create `frontend/check-prompt.mts` (a throwaway, NOT committed):

```ts
import { buildPrompt } from './src/lib/gemini';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok:', msg);
}

const ta = buildPrompt({ platform: 'tripadvisor' });
assert(ta.includes('TripAdvisor'), 'tripadvisor prompt names TripAdvisor');
assert(ta.includes('travelers filter and sort by rating'), 'tripadvisor pitch angle present');
assert(!ta.includes('Trustpilot'), 'tripadvisor prompt has no Trustpilot mention');

const yp = buildPrompt({ platform: 'yelp' });
assert(yp.includes('Yelp'), 'yelp prompt names Yelp');
assert(yp.includes('most locals check Yelp'), 'yelp pitch angle present');
assert(!yp.includes('Trustpilot'), 'yelp prompt has no Trustpilot mention');

const tp = buildPrompt({ platform: 'trustpilot' });
assert(tp.includes('Trustpilot'), 'trustpilot prompt names Trustpilot');
assert(tp.includes('online shoppers hesitate at checkout'), 'trustpilot pitch angle present');

const fallback = buildPrompt({});
assert(fallback === tp, 'no-platform fallback equals trustpilot (regression: unchanged default)');

const redirect = buildPrompt({ redirectMode: true, platform: 'yelp' });
assert(redirect.includes('Trustpilot'), 'redirectMode forces Trustpilot framing even with platform=yelp');

console.log('ALL CHECKS PASSED');
```

- [ ] **Step 4: Run the prompt check**

Run: `cd frontend && npx tsx check-prompt.mts`
Expected: a list of `ok:` lines ending in `ALL CHECKS PASSED`.
(If `tsx` cannot resolve the module, run `npx tsx@latest check-prompt.mts`; tsx handles the TS + `@google/genai` import using the frontend's `node_modules`. `buildPrompt` never touches `API_KEY`, so no Gemini key is needed.)

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Delete the throwaway script and commit**

```bash
rm frontend/check-prompt.mts
git add frontend/src/lib/gemini.ts
git commit -m "feat(campaigns): tailor AI email prompt to platform via buildPrompt"
```

---

## Task 3: Thread `platform` through the wizard + platform-name the UI strings

**Files:**
- Modify: `frontend/src/components/campaign-wizard/WizardStep1Leads.tsx`
- Modify: `frontend/src/components/campaign-wizard/CampaignWizard.tsx`
- Modify: `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx`

- [ ] **Step 1: Remove the "All Platforms" option**

In `frontend/src/components/campaign-wizard/WizardStep1Leads.tsx`, delete the first entry of `PLATFORM_OPTIONS` (around line 75):

Change:
```ts
const PLATFORM_OPTIONS: Array<{ slug: string; name: string }> = [
  { slug: '',            name: 'All Platforms' },
  { slug: 'trustpilot',  name: 'Trustpilot' },
  { slug: 'tripadvisor', name: 'TripAdvisor' },
  { slug: 'yelp',        name: 'Yelp' },
];
```
to:
```ts
const PLATFORM_OPTIONS: Array<{ slug: string; name: string }> = [
  { slug: 'trustpilot',  name: 'Trustpilot' },
  { slug: 'tripadvisor', name: 'TripAdvisor' },
  { slug: 'yelp',        name: 'Yelp' },
];
```

- [ ] **Step 2: Default the wizard to Trustpilot and update the comment**

In `frontend/src/components/campaign-wizard/CampaignWizard.tsx` (around lines 68–72), change:
```ts
  // Empty string = all platforms. Set to 'trustpilot' / 'tripadvisor' / 'yelp'
  // to restrict the lead pool to that platform's leads only — useful when
  // you've just finished a Yelp scrape and want to send a campaign to the
  // new Yelp leads without bleeding in old Trustpilot ones.
  const [filterPlatform, setFilterPlatform]   = useState('');
```
to:
```ts
  // Every campaign is single-platform (the wizard has no "all platforms"
  // option) so the generated copy can name the right platform. Defaults to
  // 'trustpilot'; switch to 'tripadvisor' / 'yelp' in Step 1.
  const [filterPlatform, setFilterPlatform]   = useState('trustpilot');
```

- [ ] **Step 3: Pass `filterPlatform` into `WizardStep2Sequence`**

In `frontend/src/components/campaign-wizard/CampaignWizard.tsx`, in the `{step === 1 && (` block rendering `<WizardStep2Sequence ... />` (around lines 263–278), add the `filterPlatform` prop after `filterCategory`:

```tsx
            filterCountry={filterCountry}
            filterCategory={filterCategory}
            filterPlatform={filterPlatform}
            manualEmails={manualEmails}
```

- [ ] **Step 4: Accept `filterPlatform` in `WizardStep2Sequence` props**

In `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx`, in the `Props` interface, add the field after `filterCategory: string;` (around line 13):

```ts
  filterCategory: string;
  /** Platform this campaign targets (Step 1 picker). Drives the tailored AI
   *  pitch and the platform-name UI strings. Always set — defaults to
   *  'trustpilot' in the wizard. */
  filterPlatform: string;
```

Then add it to the destructured params (around line 42):

```ts
  subject, body, includeScreenshot, filterCountry, filterCategory, filterPlatform, manualEmails, followUpSteps,
```

- [ ] **Step 5: Add a platform-label lookup**

In `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx`, add this constant near the top-level constants (after the `SPINTAX_EXAMPLES` array, around line 39). It mirrors the `PLATFORM_LABELS` pattern in `WizardStep4Launch.tsx`:

```ts
const PLATFORM_LABELS: Record<string, string> = {
  trustpilot: 'Trustpilot',
  tripadvisor: 'TripAdvisor',
  yelp: 'Yelp',
};
```

Then, inside the component body (after the destructure, near the other derived consts around line 53), add:

```ts
  const platformLabel = PLATFORM_LABELS[filterPlatform] ?? 'Trustpilot';
```

- [ ] **Step 6: Pass `platform` into both `generateEmailTemplate` calls**

In `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx`, in the `addFollowUp` generate call (around lines 75–85), add the `platform` field:

```ts
      const result = await generateEmailTemplate({
        country: filterCountry || undefined,
        category: filterCategory || undefined,
        emailDomain: firstEmailDomain,
        platform: filterPlatform,
        manualMode: !!(manualEmails && manualEmails.length > 0),
        redirectMode: !!redirectMode,
        discoveryMode: !!discoveryMode,
        language: targetLanguage,
        followUpMode: true,
        followUpStepNumber: newIdx + 2,
      });
```

And in `handleGenerateWithAI` (around lines 130–140), add the same field:

```ts
      const result = await generateEmailTemplate({
        country: filterCountry || undefined,
        category: filterCategory || undefined,
        emailDomain: firstEmailDomain,
        platform: filterPlatform,
        manualMode: !!(manualEmails && manualEmails.length > 0),
        redirectMode: !!redirectMode,
        discoveryMode: !!discoveryMode,
        language: filterCountry ? COUNTRY_LANGUAGE[filterCountry] : undefined,
        followUpMode: isFollowUp,
        followUpStepNumber: isFollowUp ? stepNumber : undefined,
      });
```

- [ ] **Step 7: Platform-name the follow-up default body**

In `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx`, in `addFollowUp` (around line 60), change the default body so it references the selected platform:

From:
```ts
      body: `<p>{Hi|Hello|Hey},</p><p>I just wanted to {follow up|circle back} on my previous email regarding your Trustpilot rating.</p><p>{Best regards|Kind regards},<br>OptiRate Solutions</p>`,
```
to:
```ts
      body: `<p>{Hi|Hello|Hey},</p><p>I just wanted to {follow up|circle back} on my previous email regarding your ${platformLabel} rating.</p><p>{Best regards|Kind regards},<br>OptiRate Solutions</p>`,
```

- [ ] **Step 8: Platform-name the subject placeholder**

In `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx` (around line 306), change:
```tsx
                  placeholder="e.g. A quick note about your Trustpilot rating, {{company_name}}"
```
to:
```tsx
                  placeholder={`e.g. A quick note about your ${platformLabel} rating, {{company_name}}`}
```

- [ ] **Step 9: Platform-name the screenshot toggle**

In `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx` (around lines 407–409), change:
```tsx
                <p className="text-sm font-bold text-on-surface">Attach Trustpilot Screenshot</p>
```
```tsx
                  Automatically embed a screenshot of each company&apos;s Trustpilot page — makes the email highly personalized.
```
to:
```tsx
                <p className="text-sm font-bold text-on-surface">Attach {platformLabel} Screenshot</p>
```
```tsx
                  Automatically embed a screenshot of each company&apos;s {platformLabel} page — makes the email highly personalized.
```

- [ ] **Step 10: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 11: Manual smoke test**

Run: `cd frontend && npm run dev`, open the app, start a new campaign.
Verify:
1. Step 1 platform dropdown shows only Trustpilot / TripAdvisor / Yelp (no "All Platforms"), with Trustpilot pre-selected.
2. Switch to TripAdvisor → Step 2 → "Generate with AI" → generated subject/body name TripAdvisor (not Trustpilot) and use the traveler-booking angle.
3. The screenshot toggle reads "Attach TripAdvisor Screenshot" and the subject placeholder mentions TripAdvisor.
4. Switch to Yelp → regenerate → copy names Yelp.
5. Switch back to Trustpilot → regenerate → copy names Trustpilot (unchanged from before).

- [ ] **Step 12: Commit**

```bash
git add frontend/src/components/campaign-wizard/WizardStep1Leads.tsx frontend/src/components/campaign-wizard/CampaignWizard.tsx frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx
git commit -m "feat(campaigns): thread platform into AI generation + platform-name wizard UI"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:**
  - §1 `PLATFORM_PROFILES` map → Task 1.
  - §2 prompt builder changes + precedence → Task 2 (cold-outreach branch profile-driven; special modes verbatim; `trustpilot` fallback).
  - §3 testability refactor (`buildPrompt`) → Task 2 Steps 1–2.
  - §4 threading through wizard (default Trustpilot, remove All Platforms, pass `platform`) → Task 3 Steps 1–6.
  - §5 dynamic platform-name UI strings (screenshot toggle, subject placeholder, follow-up default body) → Task 3 Steps 5, 7, 8, 9.
  - Testing (throwaway check + tsc + manual smoke) → Task 2 Steps 3–5, Task 3 Steps 10–11.
  - Out-of-scope items (send-time `{{star_rating}}`, dead-code deletion, FB/IG) → not implemented, as specified.
- **Placeholder scan:** none — every step has exact paths, code, and commands.
- **Type consistency:** `PlatformSlug`, `PlatformProfile`, `PLATFORM_PROFILES`, `buildPrompt`, and `platform?: string` are defined in Task 1/2 and used consistently in Task 3. `PLATFORM_LABELS` is local to the wizard (mirrors `WizardStep4Launch`), distinct from `PLATFORM_PROFILES` in `gemini.ts`. `platformLabel` is defined once (Step 5) and reused in Steps 7–9.
