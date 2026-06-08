# Platform-Aware AI Email Template Generation — Design

- **Date:** 2026-06-08
- **Status:** Approved (ready for implementation plan)
- **Scope:** Frontend campaign wizard + AI template generator (`gemini.ts`). No backend or DB changes.

---

## Problem

The campaign wizard already lets the operator filter the recipient lead pool by
platform (Trustpilot / TripAdvisor / Yelp / All Platforms). That filter only
affects **which leads** are included — it is never passed to the AI email
generator. `generateEmailTemplate` (`frontend/src/lib/gemini.ts`) has no
`platform` option at all, and its prompt is hardcoded around Trustpilot:

- opening line: *"helps businesses improve their online reputation and Trustpilot scores"*
- default audience: *"companies … with a Trustpilot rating between X and Y stars"*
- token guidance: *"{{star_rating}} — their current Trustpilot star rating"*
- body guidance: *"Open with a specific observation about their Trustpilot situation"*
- the worked example names Trustpilot throughout

Result: a TripAdvisor or Yelp lead receives an email that talks about Trustpilot.
The screenshot toggle is likewise hardcoded **"Include Trustpilot Screenshot."**

## Goal

When the operator generates email copy, the AI produces a pitch **tailored to the
selected platform** — correct platform name, correct rating wording, and a
distinct angle matched to that platform's audience. Because a single campaign
sends one authored template to every selected lead, each campaign is tied to
exactly one platform (the "All Platforms" option is removed from the wizard).

---

## Decisions (from brainstorming)

1. **Tailored angle per platform** — not just a name swap. Each platform gets a
   distinct framing.
2. **Remove "All Platforms"** from the campaign wizard's platform picker, so
   every campaign is single-platform and the tailored angle always lands.
3. **Default to Trustpilot** — the wizard opens with Trustpilot pre-selected; the
   operator can switch to TripAdvisor or Yelp.
4. **Config-map approach (Approach B)** — platform-specific copy lives in one
   typed `PLATFORM_PROFILES` map, not in scattered inline ternaries.
5. **`discoveryMode` and `redirectMode` stay Trustpilot-worded** this iteration
   (both are launched from Trustpilot-centric flows). Out of scope to change.

---

## Live vs. dead code

- **Live path:** `Campaigns.tsx` → `CampaignWizard` → `WizardStep1Leads`
  (platform picker) + `WizardStep2Sequence` (the only live caller of
  `generateEmailTemplate`).
- **Dead code:** `StepTemplate.tsx` and `CampaignBuilder.tsx` also call
  `generateEmailTemplate` but have **zero imports** anywhere — nothing renders
  them. They are left untouched; deleting them is a separate cleanup, not part of
  this work.

---

## Design

### 1. `PLATFORM_PROFILES` config map (`frontend/src/lib/gemini.ts`)

A typed map keyed by platform slug holds every platform-specific string the
prompt needs:

```ts
type PlatformSlug = 'trustpilot' | 'tripadvisor' | 'yelp';

interface PlatformProfile {
  displayName: string;      // e.g. 'TripAdvisor'
  ratingNoun: string;       // e.g. 'TripAdvisor rating'
  audienceDesc: string;     // cold-outreach audience phrasing (with {min}/{max})
  pitchAngle: string;       // the distinct bodyGuidance lead-in
  ratingTokens: string;     // the {{token}} guidance block, worded per platform
  screenshotLabel: string;  // e.g. 'TripAdvisor' (drives the UI toggle label)
}
```

Profile content (the operative copy each platform's prompt uses):

| Field | Trustpilot | TripAdvisor | Yelp |
|---|---|---|---|
| `displayName` | Trustpilot | TripAdvisor | Yelp |
| `ratingNoun` | Trustpilot star rating | TripAdvisor rating | Yelp star rating |
| `audienceDesc` | companies with a Trustpilot rating between {min} and {max} stars | hospitality businesses (restaurants, hotels, attractions) with a TripAdvisor rating between {min} and {max} | local service businesses with a Yelp rating between {min} and {max} stars |
| `pitchAngle` | a low Trustpilot score makes online shoppers hesitate at checkout and erodes trust before they buy | travelers filter and sort by rating before booking, so a low TripAdvisor rating quietly sends bookings to higher-rated competitors | most locals check Yelp before choosing, so the rating decides whether they call you or the next listing |
| `ratingTokens` | company_name + star_rating (Trustpilot star rating) + review_count | company_name + star_rating (TripAdvisor rating, out of 5) + review_count (traveler reviews) | company_name + star_rating (Yelp star rating) + review_count |
| `screenshotLabel` | Trustpilot | TripAdvisor | Yelp |

The `{country}`/`{category}` clauses already appended to `audienceDesc` today are
kept and built the same way for all three.

### 2. Prompt builder changes

- Add `platform?: PlatformSlug` to `GenerateTemplateOptions`.
- **Precedence is unchanged:** `discoveryMode` > `redirectMode` > `manualMode` >
  **platform-default**. Only the platform-default branch (normal cold outreach)
  becomes platform-aware: it reads `audienceDesc`, `ratingTokens`, and the
  body-guidance lead-in from `PLATFORM_PROFILES[platform ?? 'trustpilot']`. The
  prompt's opening sentence ("…improve their online reputation and **{displayName}**
  scores") uses the profile too — but only in this non-special-mode path. Special
  modes (`discoveryMode`, `redirectMode`) keep their existing Trustpilot wording.
- `followUpMode` composes on top unchanged; the `audienceDesc` it references is
  already platform-correct because it comes from the same resolved profile.
- `manualMode` is unchanged and still wins over the platform default (manual-email
  campaigns have no platform, so they stay generic).
- The `'trustpilot'` fallback preserves today's exact output when no platform is
  passed (back-compat for the dead-code callers and any future caller).

### 3. Testability refactor

Extract prompt assembly into a **pure, exported** `buildPrompt(options): string`.
`generateEmailTemplate` then just calls `buildPrompt` and sends the result to
Gemini. This isolates the only part worth testing (prompt content) from the
network call, so unit tests can assert that each platform's prompt names the right
platform and angle and excludes the others — with no API key or network.

### 4. Threading `platform` through the wizard

- **`CampaignWizard.tsx`** — change `filterPlatform` initial state from `''` to
  `'trustpilot'`; pass `filterPlatform` as a new prop to `WizardStep2Sequence`.
- **`WizardStep1Leads.tsx`** — remove the `{ slug: '', name: 'All Platforms' }`
  entry from `PLATFORM_OPTIONS`. (The remaining options are Trustpilot /
  TripAdvisor / Yelp.)
- **`WizardStep2Sequence.tsx`** — accept the new `filterPlatform` prop; pass
  `platform: filterPlatform` into **both** `generateEmailTemplate` calls (initial
  generate at the intro step, and the follow-up generate in `addFollowUp` /
  `handleGenerateWithAI`); use the platform value to label the screenshot toggle.

### 5. Dynamic platform-name UI strings

`WizardStep2Sequence.tsx` has three hardcoded "Trustpilot" UI strings that must
track the selected platform. All three resolve from a small local
`PLATFORM_LABELS: Record<string, string>` map — the same pattern already used in
`WizardStep4Launch.tsx`.

- **Screenshot toggle** ("Attach Trustpilot Screenshot" + "…company's Trustpilot
  page…") → "Attach {Platform} Screenshot" + "…company's {Platform} page…".
- **Subject placeholder** ("e.g. A quick note about your Trustpilot rating,
  {{company_name}}") → uses {Platform}.
- **Follow-up default body pre-fill** (the `addFollowUp` template that mentions
  "your Trustpilot rating") → uses {Platform}.

---

## Edge cases

- **Manual-email campaigns** (`manualMode`): no platform → copy stays generic.
  `manualMode` takes precedence over the platform default, so this path is
  unchanged.
- **`redirectMode`** (Redirected Leads page): inherently a Trustpilot-listing
  concept → stays Trustpilot-worded. Unchanged.
- **`discoveryMode`** (support-inbox handoff): keeps its current Trustpilot
  wording this iteration. Unchanged.
- **No platform passed** (any non-wizard caller): falls back to `'trustpilot'`,
  reproducing today's output exactly.

---

## Out of scope / follow-ups

- **Send-time `{{star_rating}}`** still resolves from the denormalized
  `leads.star_rating` column (`template-engine.ts`). For non-Trustpilot leads that
  column can be null and falls back to the generic phrase "below-average."
  Pointing the token at `lead_platform_presences.rating` per the lead's platform
  is a backend change (campaign-scheduler join + token map) — **tracked as a
  follow-up, not part of this work.**
- **Deleting dead code** (`StepTemplate.tsx`, `CampaignBuilder.tsx`) — separate
  cleanup.
- **Facebook / Instagram** profiles — `PLATFORM_PROFILES` is structured to accept
  new entries when those platforms go live; not added now.

---

## Testing

The frontend has **no test runner** (no vitest/jest, no test script, no existing
test files). Standing one up for this change is unjustified scope creep, so
verification is type-check + a throwaway prompt check + manual smoke. The
`buildPrompt` extraction still earns its place: it isolates the prompt string from
the network call (readability) and makes the throwaway check trivial.

- **Throwaway prompt check (dev only, not committed):** a short `tsx` script that
  imports `buildPrompt` and prints the prompt for each platform slug; eyeball that
  each names the right platform + angle and excludes the others, and that the
  `'trustpilot'` fallback (no `platform`) reproduces today's wording for the
  default cold-outreach path.
- **Manual smoke:** open the wizard → confirm "All Platforms" is gone and
  Trustpilot is pre-selected; switch platform → "Generate with AI" produces copy
  naming the selected platform; screenshot toggle label tracks the platform;
  manual-email mode still produces generic copy.
- `npx tsc --noEmit` passes in `/frontend`.

---

## Files touched

| File | Change |
|---|---|
| `frontend/src/lib/gemini.ts` | Add `PlatformSlug`, `PlatformProfile`, `PLATFORM_PROFILES`; add `platform` to options; extract `buildPrompt`; make platform-default branch profile-driven |
| `frontend/src/components/campaign-wizard/CampaignWizard.tsx` | `filterPlatform` default `''` → `'trustpilot'`; pass `filterPlatform` to `WizardStep2Sequence` |
| `frontend/src/components/campaign-wizard/WizardStep1Leads.tsx` | Remove "All Platforms" option |
| `frontend/src/components/campaign-wizard/WizardStep2Sequence.tsx` | New `filterPlatform` prop; pass `platform` to both generate calls; dynamic screenshot label |

No test file is added (frontend has no test runner — see Testing). Verification is
type-check + throwaway prompt check + manual smoke.
