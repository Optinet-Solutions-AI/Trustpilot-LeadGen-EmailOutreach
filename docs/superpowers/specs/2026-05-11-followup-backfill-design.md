# Follow-up Backfill Script — Design

**Status:** approved (2026-05-11)
**Owner:** john@optinetsolutions.com
**Target campaign:** `07b0bd0d-f020-4a00-8024-b5ed8ca51f05` (Canada Outreach Leads pt1)

---

## Problem

`Canada Outreach Leads pt1` was sent 2026-05-07 with **zero follow-up steps** configured (the AI follow-up auto-generator did not ship until 2026-05-08 — commits `5fb60ef` and `4edb83f`). As a result:

- `campaign_steps` has no `step_number=2` row for this campaign.
- The ~40 sent `campaign_leads` rows have `next_step_at = NULL`, so the sequence-scheduler will never pick them up.
- All other recent campaigns (France/Austria/Germany/Australia, sent 2026-05-08) do have step 2 and will fire today on schedule.

## Goal

Generate a step-2 follow-up for the Canada campaign that **references the original email's specific angle** (not a generic "circling back" template), insert it into `campaign_steps`, and stamp `next_step_at` on the existing sent leads so the follow-ups go out today.

## Non-goals

- No UI — fully driven from a local CLI script.
- No permanent finalization hook — this is a one-off backfill, not a default behavior change. If another campaign is created without a follow-up in the future, it will need this script run again.
- No template editing UI — the generated copy is reviewed via `--dry-run` and either accepted or re-rolled.

---

## Architecture

A standalone TypeScript script at `server/scripts/backfill-followup.ts`, run via `npx tsx` from the project root. The script:

- Reads `.env` for `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a new `GEMINI_API_KEY`.
- Loads the target campaign via the Supabase service client.
- Calls Google Gemini 2.5 Flash directly (server-side, using the existing `@google/genai` SDK dependency).
- Inserts a `campaign_steps` row and stamps `campaign_leads.next_step_at` in a two-statement sequence (no transaction wrapper — Supabase JS client doesn't expose one, and a partial failure is recoverable manually).

No Cloud Run change. No frontend change. No new API routes.

### Invocation

```bash
# Phase 1 — preview only, writes nothing
npx tsx server/scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05 --dry-run

# Phase 2 — commit
npx tsx server/scripts/backfill-followup.ts --campaign 07b0bd0d-f020-4a00-8024-b5ed8ca51f05
```

### CLI flags

| Flag | Default | Purpose |
|---|---|---|
| `--campaign <uuid>` | (required) | Target campaign ID |
| `--dry-run` | off | Print preview, exit without writing |
| `--delay-days <n>` | `3` | Days after `sent_at` to fire the follow-up. With Canada sent 2026-05-07 and default `3`, `next_step_at` is 2026-05-10 — already overdue, picked up on next 60s scheduler tick. |
| `--force` | off | Delete any existing `step_number=2` row before inserting. Used only if a previous run created a row and the user wants to re-roll the AI copy. |

---

## Components

### 1. CLI parser
Minimal hand-rolled arg parsing (no `commander` dep needed for four flags). Validates `--campaign` is a UUID via regex; exits 1 with usage if missing or malformed.

### 2. Campaign loader + guards

```ts
const campaign = await getSupabase()
  .from('campaigns')
  .select('id, name, status, template_subject, template_body, country, category, sending_schedule')
  .eq('id', campaignId)
  .single();
```

Refuse with a clear stderr message if:
- Campaign not found → exit 1.
- `campaign.status !== 'sent'` → exit 1. We do **not** backfill a campaign that's still actively sending its first step.
- `campaign_steps` already has a `step_number=2` row AND `--force` was not passed → exit 1.

If `--force` is passed and step 2 exists, the row is deleted before the new one is inserted. Existing `next_step_at` values on `campaign_leads` are overwritten by the UPDATE in step 6 regardless.

### 3. Eligible-lead query

```sql
select id, email_used, sent_at
from campaign_leads
where campaign_id = $1
  and status not in ('replied','bounced','pending')
  and sent_at is not null;
```

Rationale for the skip list:
- `replied` — never follow up on someone who already replied. (The sequence-scheduler also auto-pauses these on first tick via `cl.status === 'replied'`, but explicit-skip in the backfill is cleaner.)
- `bounced` — address won't deliver; sending again wastes the per-account hourly cap.
- `pending` — wasn't actually sent step 1 (defensive; for a `status='sent'` campaign this should be empty).

The script also reads `campaigns.country` and `campaigns.category` for the AI prompt's language/audience context.

### 4. Gemini caller — original-aware prompt

New server-side module (or inline in the script — single-use makes inlining acceptable). Uses the `@google/genai` SDK already in `server/package.json` (verify during planning). Calls `gemini-2.5-flash` with `temperature: 0.8` to match the wizard.

The prompt is a delta on the existing wizard `followUpMode` prompt. Two changes:

**1.** Prepend a `=== PRIOR EMAIL ===` block above the existing rules:

```
=== PRIOR EMAIL — THIS FOLLOW-UP MUST REFERENCE IT ===
SUBJECT: <campaign.template_subject>
BODY:
<campaign.template_body>

Your follow-up must echo the specific angle/observation of the prior email
(e.g. if the prior mentioned their {{star_rating}}-star score, the follow-up
can softly circle back on that). Do NOT restate the full pitch — assume the
recipient already read it. Keep the gentle-nudge tone.
```

**2.** All other rules (spintax density, language directive based on country, email-only CTA, OptiRate signature, no human-name placeholders, the `sanitizeSpintaxBraces` post-processor) are identical to the wizard's existing follow-up generation path.

Returns `{ subject, body }` with spintax. If the call throws (network, quota, malformed response), the script logs the error and exits 1. Nothing is written to the DB on AI failure.

### 5. Dry-run printer

Prints to stdout:
- Generated subject (raw, with spintax braces intact).
- Generated body (raw HTML with spintax braces).
- Eligible lead count.
- Sample of 5 rows: `email_used`, `sent_at`, `would_fire_at = sent_at + delay_days`.
- Earliest and latest `would_fire_at`.

Exits 0 without writing.

### 6. Committer

Two writes, in order:

```ts
// 6a. Insert step
await getSupabase().from('campaign_steps').insert({
  campaign_id: campaignId,
  step_number: 2,
  delay_days: delayDays,
  template_subject: generated.subject,
  template_body: generated.body,
});

// 6b. Stamp the clock on eligible leads
await getSupabase().rpc('backfill_followup_clock', {  // OR inline SQL via PostgREST
  p_campaign_id: campaignId,
  p_delay_days: delayDays,
});
```

The clock-stamp itself, expressed as SQL:

```sql
update campaign_leads
set next_step_at      = sent_at + (interval '1 day' * $delay_days),
    current_step      = 1,
    sequence_completed = false,
    sequence_paused    = false
where campaign_id = $campaign_id
  and status not in ('replied','bounced','pending')
  and sent_at is not null;
```

Implementation note: Supabase JS client doesn't support arbitrary SQL expressions in `.update()` (the right-hand side has to be a literal value, not `sent_at + interval ...`). Two options, decided at implementation time:

1. **Fetch-then-update** — `select id, sent_at` for the eligible set, compute `next_step_at` per row in Node, then batch-update. Simple, but N round trips (or one bulk upsert).
2. **Postgres RPC function** — create a one-shot SQL function in a migration, call via `.rpc()`. Atomic, single round trip, but adds a migration.

Recommend option 1 with a single `upsert` of all rows in one call — small N (~40), no migration needed.

Print summary on success:
- Step ID inserted.
- N leads stamped.
- Earliest `next_step_at`, latest `next_step_at`.
- Reminder: scheduler picks up within 60 seconds.

---

## Data flow

```
CLI args
   │
   ▼
Load campaign  ──[guards fail]──→ exit 1
   │
   ▼
Query eligible leads (count, sample)
   │
   ▼
Call Gemini (original-aware prompt) ──[fails]──→ exit 1
   │
   ├─ --dry-run? ─→ Print preview ─→ exit 0
   │
   ▼
INSERT campaign_steps (step 2)
   │
   ▼
UPDATE campaign_leads (next_step_at = sent_at + delay, reset flags)
   │
   ▼
Print summary
   │
   ▼
[sequence-scheduler picks up within 60s on next tick]
```

---

## Error handling

| Condition | Behavior |
|---|---|
| `--campaign` missing or not a UUID | Exit 1 with usage. |
| Campaign row not found | Exit 1 with `campaign <uuid> not found`. |
| Campaign `status != 'sent'` | Exit 1 with `campaign is currently <status>; refusing to backfill`. |
| Step 2 already exists, no `--force` | Exit 1 with `step 2 already exists; pass --force to replace`. |
| Zero eligible leads | Print `no eligible leads (all replied/bounced/pending or never sent)`, exit 0. Nothing written. |
| Gemini API failure | Log error, exit 1. Nothing written. |
| INSERT `campaign_steps` fails | Log error, exit 1. Nothing else written. |
| UPDATE `campaign_leads` fails after INSERT succeeded | Log error, exit 1. Step row exists but no leads stamped — user can re-run with `--force` to recover. |

---

## Prerequisites

| Item | Status |
|---|---|
| `GEMINI_API_KEY` in `.env` | **Action required** — user to add a new line `GEMINI_API_KEY=<value>` reusing the same key as `NEXT_PUBLIC_GEMINI_API_KEY`. Local only — not deployed to Cloud Run since the script never runs there. |
| `@google/genai` in `server/package.json` | To be verified during implementation. If absent, add as dev dependency (script is local-only, so dev is acceptable). |
| Supabase env vars | Already present (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). |

---

## Testing

This is a throwaway one-shot. No unit tests.

Manual verification, in order:

1. Run `--dry-run` against Canada. Read the generated subject + body. Confirm:
   - Spintax density looks similar to the other 4 campaigns' step-2 templates.
   - The body references the original email's specific angle (e.g. echoes the star-rating observation or the specific CTA the original used).
   - Subject line is shorter than the original (it's a follow-up, not a fresh pitch).
   - No human-name placeholders (`[Your Name]` etc.).
2. If the copy is awkward, re-run `--dry-run` — each call re-rolls Gemini.
3. Once happy, drop `--dry-run` and commit.
4. Within 60 seconds, watch Cloud Run logs for `[SequenceScheduler] N follow-ups due` and `[SequenceScheduler] Sent step 2 to ...`.
5. Spot-check Supabase: `campaign_leads` for Canada should have `current_step=2` and `sent_at` updated for the leads that have already gone out, with `next_step_at` advancing or `sequence_completed=true` for the rest.

Acceptance: every eligible Canada lead has either fired its step 2 or been auto-paused (reply) within the same day.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| AI generates copy that doesn't match the original's tone | `--dry-run` lets the user re-roll before any send. |
| `next_step_at` lands in the past → all 40 fire at once | Per-account `daily_cap`/`hourly_cap` in `rate-limiter.ts` enforces ~30-90s pacing per send across active sender accounts. Not a real risk in practice; user has confirmed they want it to drain today. |
| Script is re-run accidentally and creates step 3 / duplicate step 2 | Guard on `step_number=2` exists requires explicit `--force`. |
| Gemini key missing from `.env` | Script checks at startup and exits 1 with a clear "add GEMINI_API_KEY to .env" message before any DB read. |
| Backfill stamps `next_step_at` on a lead that received a reply between query and update | Sequence-scheduler re-checks `cl.status === 'replied'` at send time and auto-pauses before sending. Belt-and-suspenders. |

---

## Out of scope (will not be done in this work)

- Adding a permanent finalization hook so new campaigns auto-generate follow-ups when the user forgets one in the wizard (a possible follow-on, but not part of this one-off).
- Fixing the latent `recoverStuckCampaigns` bug that doesn't schedule follow-ups when a campaign finalizes via the recovery path (separate issue, not blocking this).
- A UI button on `CampaignDetail.tsx` for "Add follow-up to existing campaign" (explicitly rejected by the user — automatic backfill instead).

---

## Commit message

```
feat(campaigns): one-off backfill script to add AI follow-up to a sent campaign
```
