# Follow-up Backfill Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local one-off TypeScript script that backfills a follow-up (step 2) onto a `status='sent'` campaign whose `campaign_steps` table is empty, with an AI-generated body that references the original email, and stamps `next_step_at` on the existing sent leads so the sequence-scheduler fires them today.

**Architecture:** Single standalone script at `server/scripts/backfill-followup.ts`, run from `/server` via `npx tsx`. Reads `.env` for Supabase service key + new `GEMINI_API_KEY`. Two-phase invocation gated by `--dry-run`. No Cloud Run, no API route, no frontend, no migrations.

**Tech Stack:** TypeScript, `tsx`, `@supabase/supabase-js` (already in `server/package.json`), `@google/genai` (new dep — add to `server/package.json`).

**Spec:** [docs/superpowers/specs/2026-05-11-followup-backfill-design.md](../specs/2026-05-11-followup-backfill-design.md)

---

## Task 1: Prerequisites — install Gemini SDK and add env var

**Files:**
- Modify: `server/package.json` (add `@google/genai` dependency)
- Modify: `.env` (add `GEMINI_API_KEY=<value>` — same value as the existing `NEXT_PUBLIC_GEMINI_API_KEY`)

- [ ] **Step 1: Confirm the frontend Gemini key value**

Run from project root:
```bash
grep '^NEXT_PUBLIC_GEMINI_API_KEY=' .env
```
Expected: one line printed showing the current key. Copy that value for step 3.

- [ ] **Step 2: Install `@google/genai` in the server**

Run from `/server`:
```bash
npm install @google/genai
```
Expected: `package.json` gets a new entry under `dependencies` like `"@google/genai": "^1.x.x"`. `node_modules/@google/genai/` exists.

- [ ] **Step 3: Add `GEMINI_API_KEY` to `.env`**

Open `.env` at project root and append (preserving the existing `NEXT_PUBLIC_GEMINI_API_KEY` line):
```
GEMINI_API_KEY=<paste the same value from step 1>
```

Do NOT commit `.env`. Do NOT add the key to Cloud Run env vars — the script is local-only.

- [ ] **Step 4: Verify the key loads via Node**

Run from `/server`:
```bash
npx tsx --eval "import('dotenv/config').then(() => console.log('GEMINI_API_KEY present:', !!process.env.GEMINI_API_KEY))"
```
Expected: `GEMINI_API_KEY present: true`

- [ ] **Step 5: Commit the dependency change**

```bash
git add server/package.json server/package-lock.json
git commit -m "chore(server): add @google/genai for local follow-up backfill script"
```

---

## Task 2: Script skeleton with CLI parsing

**Files:**
- Create: `server/scripts/backfill-followup.ts`

- [ ] **Step 1: Create the file with the imports and CLI parser**

```typescript
// server/scripts/backfill-followup.ts
//
// One-off backfill: adds an AI-generated step-2 follow-up to a status='sent'
// campaign whose campaign_steps is empty, and stamps next_step_at on the
// existing sent leads so the sequence-scheduler picks them up.
//
// Usage (from /server):
//   npx tsx scripts/backfill-followup.ts --campaign <uuid> --dry-run
//   npx tsx scripts/backfill-followup.ts --campaign <uuid>
//
// Flags:
//   --campaign <uuid>     (required) target campaign id
//   --dry-run             preview only; writes nothing
//   --delay-days <n>      default 3; days after sent_at to fire follow-up
//   --force               delete existing step 2 before reinserting

import 'dotenv/config';
import { getSupabase } from '../src/lib/supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Args {
  campaignId: string;
  dryRun: boolean;
  delayDays: number;
  force: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);

  const campaignId = get('--campaign') ?? '';
  if (!UUID_RE.test(campaignId)) {
    console.error('Usage: npx tsx scripts/backfill-followup.ts --campaign <uuid> [--dry-run] [--delay-days N] [--force]');
    process.exit(1);
  }

  const delayDaysRaw = get('--delay-days');
  const delayDays = delayDaysRaw ? Number(delayDaysRaw) : 3;
  if (!Number.isFinite(delayDays) || delayDays < 0 || delayDays > 30) {
    console.error('--delay-days must be an integer between 0 and 30');
    process.exit(1);
  }

  return { campaignId, dryRun: has('--dry-run'), delayDays, force: has('--force') };
}

async function main() {
  const args = parseArgs();
  console.log(`[backfill] campaign=${args.campaignId} dryRun=${args.dryRun} delayDays=${args.delayDays} force=${args.force}`);
  // TODO: load campaign, query leads, call Gemini, dry-run? print : commit
}

main().catch((err) => {
  console.error('[backfill] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test the CLI parser**

Run from `/server`:
```bash
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run
```
Expected output:
```
[backfill] campaign=07b0bd0d-f020-4a00-8024-b5ed8ca51f05 dryRun=true delayDays=3 force=false
```

Then test the failure path:
```bash
npx tsx scripts/backfill-followup.ts
```
Expected: exits with status 1 and prints the Usage line.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/backfill-followup.ts
git commit -m "feat(scripts): add backfill-followup skeleton with CLI parsing"
```

---

## Task 3: Campaign loader and guards

**Files:**
- Modify: `server/scripts/backfill-followup.ts`

- [ ] **Step 1: Add the campaign loader function above `main()`**

Insert after `parseArgs()`:

```typescript
interface CampaignRow {
  id: string;
  name: string;
  status: string;
  template_subject: string;
  template_body: string;
  country: string | null;
  category: string | null;
}

async function loadCampaign(campaignId: string): Promise<CampaignRow> {
  const { data, error } = await getSupabase()
    .from('campaigns')
    .select('id, name, status, template_subject, template_body, country, category')
    .eq('id', campaignId)
    .single();
  if (error || !data) {
    console.error(`[backfill] campaign ${campaignId} not found`);
    process.exit(1);
  }
  if (data.status !== 'sent') {
    console.error(`[backfill] campaign is currently '${data.status}'; refusing to backfill (only 'sent' campaigns allowed)`);
    process.exit(1);
  }
  return data as CampaignRow;
}

async function checkExistingStep2(campaignId: string, force: boolean): Promise<void> {
  const { data } = await getSupabase()
    .from('campaign_steps')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('step_number', 2);
  if (data && data.length > 0) {
    if (!force) {
      console.error('[backfill] step 2 already exists; pass --force to delete and reinsert');
      process.exit(1);
    }
    console.log('[backfill] --force: deleting existing step 2 row(s)');
    const { error: delErr } = await getSupabase()
      .from('campaign_steps')
      .delete()
      .eq('campaign_id', campaignId)
      .eq('step_number', 2);
    if (delErr) {
      console.error('[backfill] failed to delete existing step 2:', delErr.message);
      process.exit(1);
    }
  }
}
```

- [ ] **Step 2: Wire the loader into `main()`**

Replace the body of `main()` with:

```typescript
async function main() {
  const args = parseArgs();
  console.log(`[backfill] campaign=${args.campaignId} dryRun=${args.dryRun} delayDays=${args.delayDays} force=${args.force}`);

  const campaign = await loadCampaign(args.campaignId);
  console.log(`[backfill] loaded campaign "${campaign.name}" (status=${campaign.status}, country=${campaign.country ?? '—'}, category=${campaign.category ?? '—'})`);

  await checkExistingStep2(args.campaignId, args.force);
  // TODO: eligible-lead query, Gemini call, dry-run? print : commit
}
```

- [ ] **Step 3: Smoke-test the loader**

Run from `/server`:
```bash
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run
```
Expected: the campaign-loaded line prints; no step-2 conflict (Canada has zero rows in `campaign_steps`).

Then test the "not found" path:
```bash
npx tsx scripts/backfill-followup.ts --campaign 00000000-0000-0000-0000-000000000000 --dry-run
```
Expected: `[backfill] campaign 00000000-... not found`, exit 1.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/backfill-followup.ts
git commit -m "feat(scripts): backfill-followup loads campaign + checks step-2 guard"
```

---

## Task 4: Eligible-lead query

**Files:**
- Modify: `server/scripts/backfill-followup.ts`

- [ ] **Step 1: Add the query function**

Insert after `checkExistingStep2`:

```typescript
interface EligibleLead {
  id: string;
  email_used: string;
  sent_at: string;
}

async function queryEligibleLeads(campaignId: string): Promise<EligibleLead[]> {
  const { data, error } = await getSupabase()
    .from('campaign_leads')
    .select('id, email_used, sent_at, status')
    .eq('campaign_id', campaignId)
    .not('status', 'in', '(replied,bounced,pending)')
    .not('sent_at', 'is', null);
  if (error) {
    console.error('[backfill] eligible-lead query failed:', error.message);
    process.exit(1);
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    email_used: r.email_used as string,
    sent_at: r.sent_at as string,
  }));
}
```

- [ ] **Step 2: Wire into `main()`**

Update `main()` (replace the TODO comment):

```typescript
  const leads = await queryEligibleLeads(args.campaignId);
  console.log(`[backfill] eligible leads: ${leads.length}`);
  if (leads.length === 0) {
    console.log('[backfill] no eligible leads (all replied/bounced/pending or never sent) — nothing to do');
    return;
  }
  // TODO: Gemini call, dry-run? print : commit
```

- [ ] **Step 3: Smoke-test**

```bash
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run
```
Expected: `[backfill] eligible leads: N` where N is roughly the 40-ish Canada leads (could be lower if some bounced/replied).

- [ ] **Step 4: Commit**

```bash
git add server/scripts/backfill-followup.ts
git commit -m "feat(scripts): backfill-followup queries eligible leads"
```

---

## Task 5: Gemini caller with original-aware prompt

**Files:**
- Modify: `server/scripts/backfill-followup.ts`

- [ ] **Step 1: Add the country-language map and brace sanitizer**

Insert near the top of the file, after the `UUID_RE` constant:

```typescript
// Mirrors frontend/src/components/campaign-wizard/scheduleConfig.ts COUNTRY_LANGUAGE.
// Countries not in this map default to English (e.g. CA, US, GB, AU, IE, NZ).
const COUNTRY_LANGUAGE: Record<string, string> = {
  DE: 'German',
  FR: 'French',
  NL: 'Dutch',
  IT: 'Italian',
  ES: 'Spanish',
  DK: 'Danish',
  SE: 'Swedish',
  NO: 'Norwegian',
  FI: 'Finnish',
  BR: 'Brazilian Portuguese',
};

// Mirrors sanitizeSpintaxBraces() from frontend/src/lib/gemini.ts. Strips
// unmatched "{" / "}" Gemini occasionally drops under heavy nesting; keeps
// balanced spintax groups and {{token}} placeholders intact.
function sanitizeSpintaxBraces(text: string): string {
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
```

- [ ] **Step 2: Add the Gemini caller**

Insert after `queryEligibleLeads`:

```typescript
import { GoogleGenAI } from '@google/genai';

interface GeneratedFollowUp {
  subject: string;
  body: string;
}

async function generateFollowUp(campaign: CampaignRow): Promise<GeneratedFollowUp> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[backfill] GEMINI_API_KEY missing from .env — see Task 1 of the plan');
    process.exit(1);
  }

  const language = campaign.country ? COUNTRY_LANGUAGE[campaign.country] : undefined;
  const countryLabel = campaign.country ? `in ${campaign.country}` : '';
  const categoryLabel = campaign.category ? `in the ${campaign.category.replace(/_/g, ' ')} industry` : '';
  const audienceDesc = `companies ${countryLabel} ${categoryLabel}`.trim();

  const languageDirective = language && language.toLowerCase() !== 'english'
    ? `\n=== LANGUAGE — NON-NEGOTIABLE ===\nWrite the ENTIRE email in ${language}. Every greeting, sentence, transition, CTA, closing, and EVERY spintax variant must be in ${language}. The subject line is also in ${language}. Tokens like {{company_name}}, {{star_rating}}, {{review_count}}, {{country}} stay EXACTLY as-is. Use natural, professional ${language} as a native B2B copywriter would write it — not literal English-to-${language} translations. The "no phone call / email-only" rule below applies in ${language} too.\n`
    : '';

  const prompt = `
You are a professional B2B email copywriter for OptiRate, a reputation management agency that helps businesses improve their online reputation and Trustpilot scores.

=== PRIOR EMAIL — THIS FOLLOW-UP MUST REFERENCE IT ===
SUBJECT: ${campaign.template_subject}
BODY:
${campaign.template_body}

Your follow-up must echo the specific angle/observation of the prior email (e.g. if the prior mentioned their {{star_rating}}-star score, the follow-up can softly circle back on that). Do NOT restate the full pitch — assume the recipient already read it. Keep the gentle-nudge tone.

Write a follow-up email (step 2 in a sequence) targeting ${audienceDesc}.
${languageDirective}

=== THIS IS A FOLLOW-UP — NOT A COLD OPENER ===
- Open by acknowledging the prior email ("just following up", "circling back", "wanted to make sure my last email didn't get lost")
- Keep the body to 1-2 SHORT paragraphs total (3-5 sentences max — follow-ups must feel light, not pushy)
- Add ONE fresh angle: a quick question, a soft reminder of the value, or a low-friction CTA — do NOT restate the original pitch
- Subject line MUST signal a follow-up. Use spintax patterns like "{Re:|Follow-up:|Quick follow-up —|Checking in on} {{company_name}}" or similar
- Tone is friendly and patient — never accusatory or guilt-trippy
- Email-only CTA — never propose a phone, video, or voice call

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
- Unclosed or single-option braces leak literal "{" characters into sent emails and trigger spam filters.

MANDATORY: Apply spintax to ALMOST EVERY PHRASE in subject and body. Aim for 8–15 spintax groups across the full follow-up email.

TOKENS — include these organically (never inside spintax braces):
  - {{company_name}} — company name
  - {{star_rating}} — their current Trustpilot star rating
  - {{country}} — their country (weave in naturally)
- DO NOT put {{token}} placeholders inside spintax braces — always outside

=== BODY REQUIREMENTS ===
- Tone: professional, empathetic, consultative — NOT pushy or salesy
- Length: 1-2 short paragraphs (3-5 sentences total)
- HARD RULE — EMAIL-ONLY OUTREACH: OptiRate does not have phone support. NEVER propose a phone call, video call, Zoom, Meet, Teams, or any voice/video meeting. Forbidden phrases: "give me a call", "hop on a call", "quick call", "phone call", "schedule a call", "jump on a call", "would love to chat", "15-minute call". Replace any urge to suggest a call with email-only equivalents.
- The sender is ALWAYS "OptiRate" — never write "[Your Name]", "[Name]", "[Your Company]", or any square-bracket placeholder.
- Close with heavy spintax, e.g. "{Best|Kind} {regards|wishes},<br>{OptiRate|The OptiRate Team|OptiRate Solutions}"
- Output ONLY the HTML body content (no <html>, <head>, <body> tags)
- Use only <p>, <strong>, <br> tags — keep it email-safe
`.trim();

  const genAI = new GoogleGenAI({ apiKey });
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

  const rawSubject = subjectMatch ? subjectMatch[1].trim() : 'A quick follow-up about {{company_name}}';
  const rawBody = bodyMatch ? bodyMatch[1].trim() : raw;

  return {
    subject: sanitizeSpintaxBraces(rawSubject),
    body: sanitizeSpintaxBraces(rawBody),
  };
}
```

- [ ] **Step 3: Wire into `main()`**

Update `main()`:

```typescript
  console.log('[backfill] calling Gemini for follow-up copy...');
  const generated = await generateFollowUp(campaign);
  console.log('[backfill] Gemini returned subject + body');
  // TODO: dry-run? print : commit
```

- [ ] **Step 4: Smoke-test the Gemini call**

```bash
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run
```
Expected: prints the eligible-lead count, then `calling Gemini for follow-up copy...`, then `Gemini returned subject + body`, then exits cleanly. If Gemini errors (quota, network), confirm the error message is clear.

- [ ] **Step 5: Commit**

```bash
git add server/scripts/backfill-followup.ts
git commit -m "feat(scripts): backfill-followup calls Gemini with original-aware prompt"
```

---

## Task 6: Dry-run preview output

**Files:**
- Modify: `server/scripts/backfill-followup.ts`

- [ ] **Step 1: Add the preview printer**

Insert after `generateFollowUp`:

```typescript
function printDryRun(
  campaign: CampaignRow,
  leads: EligibleLead[],
  generated: GeneratedFollowUp,
  delayDays: number,
): void {
  const fireTimes = leads
    .map((l) => new Date(new Date(l.sent_at).getTime() + delayDays * 86_400_000))
    .sort((a, b) => a.getTime() - b.getTime());
  const earliest = fireTimes[0]?.toISOString() ?? '—';
  const latest = fireTimes[fireTimes.length - 1]?.toISOString() ?? '—';

  console.log('\n========== DRY RUN — no writes ==========');
  console.log(`Campaign:     ${campaign.name} (${campaign.id})`);
  console.log(`Delay days:   ${delayDays}`);
  console.log(`Eligible:     ${leads.length} leads`);
  console.log(`Earliest fire: ${earliest}`);
  console.log(`Latest fire:   ${latest}`);
  console.log('\n--- Generated subject ---');
  console.log(generated.subject);
  console.log('\n--- Generated body (raw HTML, spintax intact) ---');
  console.log(generated.body);
  console.log('\n--- Sample leads (up to 5) ---');
  for (const l of leads.slice(0, 5)) {
    const fireAt = new Date(new Date(l.sent_at).getTime() + delayDays * 86_400_000).toISOString();
    console.log(`  ${l.email_used.padEnd(40)}  sent=${l.sent_at}  would_fire=${fireAt}`);
  }
  console.log('\nRe-run without --dry-run to commit.');
}
```

- [ ] **Step 2: Wire into `main()`**

Update `main()`:

```typescript
  if (args.dryRun) {
    printDryRun(campaign, leads, generated, args.delayDays);
    return;
  }
  // TODO: commit
```

- [ ] **Step 3: Smoke-test dry-run end-to-end**

```bash
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run
```
Expected: full preview prints. Read the subject and body. If awkward, re-run — each call re-rolls Gemini.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/backfill-followup.ts
git commit -m "feat(scripts): backfill-followup dry-run preview output"
```

---

## Task 7: Committer — insert step + stamp the clock

**Files:**
- Modify: `server/scripts/backfill-followup.ts`

- [ ] **Step 1: Add the committer**

Insert after `printDryRun`:

```typescript
async function commit(
  campaign: CampaignRow,
  leads: EligibleLead[],
  generated: GeneratedFollowUp,
  delayDays: number,
): Promise<void> {
  const supabase = getSupabase();

  // 7a. Insert step 2
  const { data: stepRow, error: stepErr } = await supabase
    .from('campaign_steps')
    .insert({
      campaign_id: campaign.id,
      step_number: 2,
      delay_days: delayDays,
      template_subject: generated.subject,
      template_body: generated.body,
    })
    .select('id')
    .single();
  if (stepErr || !stepRow) {
    console.error('[backfill] failed to insert campaign_steps row:', stepErr?.message);
    process.exit(1);
  }
  console.log(`[backfill] inserted campaign_steps row ${stepRow.id}`);

  // 7b. Compute next_step_at per lead and batch-update.
  // Supabase JS .update() can't do `sent_at + interval`, so we update each
  // row individually. N is small (~40 for Canada) — sequential is fine.
  const fireTimes: number[] = [];
  let stampedCount = 0;
  for (const l of leads) {
    const fireAt = new Date(new Date(l.sent_at).getTime() + delayDays * 86_400_000);
    fireTimes.push(fireAt.getTime());
    const { error: updErr } = await supabase
      .from('campaign_leads')
      .update({
        next_step_at: fireAt.toISOString(),
        current_step: 1,
        sequence_completed: false,
        sequence_paused: false,
      })
      .eq('id', l.id);
    if (updErr) {
      console.error(`[backfill] failed to stamp lead ${l.id} (${l.email_used}):`, updErr.message);
      console.error('[backfill] step row was already inserted; re-run with --force to fully reapply');
      process.exit(1);
    }
    stampedCount++;
  }

  const earliest = new Date(Math.min(...fireTimes)).toISOString();
  const latest = new Date(Math.max(...fireTimes)).toISOString();

  console.log('\n========== COMMITTED ==========');
  console.log(`Step 2 inserted with delay=${delayDays}d`);
  console.log(`Stamped ${stampedCount} leads`);
  console.log(`Earliest next_step_at: ${earliest}`);
  console.log(`Latest next_step_at:   ${latest}`);
  console.log('Sequence-scheduler picks up overdue leads on its next 60s tick.');
}
```

- [ ] **Step 2: Wire into `main()`**

Replace the `// TODO: commit` line with:

```typescript
  await commit(campaign, leads, generated, args.delayDays);
```

The final shape of `main()` should be:

```typescript
async function main() {
  const args = parseArgs();
  console.log(`[backfill] campaign=${args.campaignId} dryRun=${args.dryRun} delayDays=${args.delayDays} force=${args.force}`);

  const campaign = await loadCampaign(args.campaignId);
  console.log(`[backfill] loaded campaign "${campaign.name}" (status=${campaign.status}, country=${campaign.country ?? '—'}, category=${campaign.category ?? '—'})`);

  await checkExistingStep2(args.campaignId, args.force);

  const leads = await queryEligibleLeads(args.campaignId);
  console.log(`[backfill] eligible leads: ${leads.length}`);
  if (leads.length === 0) {
    console.log('[backfill] no eligible leads (all replied/bounced/pending or never sent) — nothing to do');
    return;
  }

  console.log('[backfill] calling Gemini for follow-up copy...');
  const generated = await generateFollowUp(campaign);
  console.log('[backfill] Gemini returned subject + body');

  if (args.dryRun) {
    printDryRun(campaign, leads, generated, args.delayDays);
    return;
  }

  await commit(campaign, leads, generated, args.delayDays);
}
```

- [ ] **Step 3: Smoke-test (still in dry-run for now — don't commit yet)**

```bash
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run
```
Expected: dry-run still prints (control flow returns before `commit()`). No DB writes happen.

- [ ] **Step 4: Commit the script**

```bash
git add server/scripts/backfill-followup.ts
git commit -m "feat(scripts): backfill-followup commits step + stamps next_step_at"
```

---

## Task 8: Live execution and verification

**Files:** none — this task is run-only.

- [ ] **Step 1: Final dry-run check, with copy review**

```bash
cd "c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH/server"
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run
```

Read the printed subject and body. Confirm:
- Body references the original email's angle (echoes the star-rating mention, the specific CTA, etc.).
- 8+ spintax groups visible.
- No `[Your Name]` or other bracket placeholders.
- Email-only CTA (no "call", "Zoom", etc.).
- Earliest `would_fire` is in the past (this is what makes them fire immediately).

If the copy is awkward, re-run dry-run to re-roll Gemini.

- [ ] **Step 2: Commit live (writes to DB)**

```bash
npx tsx scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05
```
Expected: `COMMITTED` block prints with step ID + stamped count + earliest/latest fire time.

- [ ] **Step 3: Confirm via SQL in Supabase**

Run in Supabase SQL editor:

```sql
-- Step 2 row exists?
select step_number, delay_days, left(template_subject, 60) as subj
from campaign_steps
where campaign_id = '07b0bd0d-f020-4a00-8024-b5ed8ca51f05';

-- next_step_at populated on eligible leads?
select count(*) filter (where next_step_at is not null) as scheduled,
       count(*) filter (where next_step_at is null and status='sent') as missed,
       min(next_step_at) as earliest_due,
       count(*) filter (where next_step_at <= now()) as overdue_now
from campaign_leads
where campaign_id = '07b0bd0d-f020-4a00-8024-b5ed8ca51f05';
```

Expected: step 2 row present. `scheduled` matches the script's stamped count. `overdue_now` equals `scheduled` (everything is overdue → fires next tick).

- [ ] **Step 4: Watch Cloud Run logs for the scheduler picking it up**

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=trustpilot-crm AND textPayload:"[SequenceScheduler]"' --project=trustpilot-leadgen --limit=20 --freshness=5m --format='value(timestamp,textPayload)'
```

Within 60-120 seconds of step 3 succeeding, expect entries like:
```
[SequenceScheduler] N follow-ups due
[SequenceScheduler] Sent step 2 to <email>
```

If no logs appear after 3 minutes, check `gcloud run revisions list` to confirm the service is healthy, then inspect logs more broadly without the filter.

- [ ] **Step 5: Final sanity check after batch drains**

After ~1 hour, re-run the SQL from step 3. Expect:
- `current_step=2` on most rows (the ones whose step-2 has fired).
- `sequence_completed=true` on most rows (no step 3 defined → scheduler marks completed after step 2).
- A few `paused` rows if any of the leads replied to step 1 in the gap between query-time and send-time.

- [ ] **Step 6: No commit needed**

This task is verification-only. If the script behaved correctly, no further code changes. If a bug surfaced, return to the failing task and fix before declaring done.

---

## Self-review

**Spec coverage check:**
- ✅ One-off backfill (no UI, no finalization hook) — Tasks 2-7 build the script; Task 8 runs it once.
- ✅ Original-aware AI prompt — Task 5, prepended `=== PRIOR EMAIL ===` block.
- ✅ Spintax variation — Task 5, full spintax rules block in prompt + `sanitizeSpintaxBraces`.
- ✅ Skip `replied`/`bounced`/`pending` — Task 4, `.not('status', 'in', '(replied,bounced,pending)')`.
- ✅ `next_step_at = sent_at + delay_days` (overdue → fires today) — Task 7.
- ✅ Reset `current_step=1`, `sequence_completed=false`, `sequence_paused=false` — Task 7.
- ✅ Status guard (only `sent` campaigns) — Task 3, `loadCampaign`.
- ✅ Duplicate-step-2 guard with `--force` override — Task 3, `checkExistingStep2`.
- ✅ Empty-eligible-leads path → exit 0 — Task 4.
- ✅ Gemini failure → exit 1, nothing written — Task 5 (commit() runs after generate() succeeds).
- ✅ `--dry-run` writes nothing — Task 6.
- ✅ `GEMINI_API_KEY` prereq — Task 1.
- ✅ Local-only (not Cloud Run) — Task 1 step 3 note.

**No-placeholder check:** no TBDs, no "add error handling" without code, no "similar to Task N" — all code shown inline.

**Type consistency:** `CampaignRow`, `EligibleLead`, `GeneratedFollowUp` interfaces defined once and reused. Method names (`loadCampaign`, `checkExistingStep2`, `queryEligibleLeads`, `generateFollowUp`, `printDryRun`, `commit`) consistent across tasks.
