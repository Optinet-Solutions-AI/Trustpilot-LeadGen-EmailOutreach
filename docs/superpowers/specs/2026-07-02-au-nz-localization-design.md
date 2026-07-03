# AU/NZ Localization + Scrape Runs — Design

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Author:** Agent (brainstormed with operator)

## Problem

The operator wants Australia and New Zealand added "on everything" — scrapable on all
platforms (Trustpilot prioritised) and, crucially, campaign email content **localised**
for those markets. Today templates are US-English only: `{{token}}` + spintax, no
locale awareness.

## Key finding — the country data already exists

Investigation showed AU and NZ are **already fully selectable** across all three live
platforms; there is no seeding/taxonomy work to do:

| Platform | `platform_countries` has AU/NZ | Extra data |
|---|---|---|
| Trustpilot | ✅ (80 countries; `SUPPORTED_COUNTRIES` lists both) | `?country=AU`/`NZ` URL param already works |
| Yelp | ✅ (24 countries) | `yelp_country_cities.json` has both; listing is owner-local browser |
| TripAdvisor | ✅ (65 countries) | **66 cities already seeded** — 29 AU + 37 NZ |

So the "add the countries" request collapses to **running the scrapes**. The real
engineering deliverable is the localisation engine.

## Scope

**In scope**
1. Locale-aware template engine (spelling, currency, conservative phrasing, timezone default).
2. Run AU + NZ scrapes on Trustpilot (first), then Yelp + TripAdvisor.

**Out of scope**
- Any new seeding/taxonomy code (already done).
- Auto-injected slang ("G'day") — rejected as gimmicky + a spam signal.
- Per-recipient locale beyond AU/NZ (US behaviour is unchanged; other Commonwealth
  markets can be added later by extending the locale table).

## Architecture — single seam

Every send path funnels through `renderAndSpin(template, lead)` in
`server/src/services/template-engine.ts` (6 call sites: campaign-scheduler,
sequence-scheduler, platform-campaign-sender, campaigns route, inbox route x2).
The `lead` object already carries `lead.country`.

Localisation is injected **inside `renderAndSpin`** — no call-site changes, so the
main send, all follow-ups, and the test flight localise automatically.

New render order:

```
tokens ({{...}})  →  spintax ({a|b})  →  localizeText(text, lead.country)
```

Localising **last** means it also catches the operator's literal copy and whichever
spintax variant was chosen.

### New module: `server/src/services/locale.ts`

```
resolveLocale(country): { variant: 'commonwealth' | 'us', currencyCode, currencySymbol }
  AU  -> { commonwealth, 'AUD', 'A$' }
  NZ  -> { commonwealth, 'NZD', 'NZ$' }
  else-> { us,           'USD', '$'  }   // zero behaviour change for existing markets

localizeText(text, country): string
  - variant 'us'          -> returns text unchanged
  - variant 'commonwealth'-> applies spelling + conservative lexical passes
```

`resolveLocale` is the single source of truth; the token map and `localizeText` both
read from it, so adding a market later is one table row.

## Dimensions

### 1. Spelling (automatic, AU/NZ only)
Whole-word, **case-preserving**, **idempotent** US→Commonwealth conversion.

- Explicit dictionary for irregulars: color→colour, center→centre, catalog→catalogue,
  favorite→favourite, license (verb) left alone, defense→defence, traveler→traveller,
  fulfill→fulfil, etc.
- Productive families applied after the dictionary: `-ize→-ise`, `-ization→-isation`,
  `-yze→-yse` (analyze→analyse), `-or→-our` limited to a safe allowlist
  (color/favor/honor/labor/neighbor/behavior) — **not** a blanket `-or` rule (would
  wrongly hit "doctor", "author").
- Case preservation: `Organize`→`Organise`, `ORGANIZE`→`ORGANISE`, `organize`→`organise`.
- Idempotent: running twice yields the same output (already-Commonwealth words are inert).
- Word-boundary matched so substrings inside URLs/emails/tokens are not mangled
  (e.g. don't touch `organize` inside `organizecorp.com`). Applied to visible text only.

### 2. Currency (tokens)
Two new entries in `TOKEN_MAP`, resolved via `resolveLocale(lead.country)`:

- `{{currency_code}}` → `AUD` / `NZD` / (fallback) `USD`
- `{{currency_symbol}}` → `A$` / `NZ$` / (fallback) `$`

Operators opt in by using the tokens in copy. Non-AU/NZ leads get the USD fallback,
so existing templates are unaffected.

### 3. Local phrasing / tone (conservative)
Two safe lexical swaps folded into the Commonwealth pass (whole-word, case-preserving):
`cell phone`→`mobile`, `zip code`→`postcode`, `math`→`maths`. Plus one token:

- `{{signoff}}` → `Cheers` for AU/NZ, else the current default sign-off.

No slang injection. Anything more aggressive is left to the operator.

### 4. Timezone default (frontend)
In `frontend/src/components/campaign-wizard/StepSetup.tsx`, when the campaign's filter
country is AU or NZ, default `schedule.timezone` to `Australia/Sydney` (AU) or
`Pacific/Auckland` (NZ). Both already exist in `TIMEZONES`; this only changes the
**default** — the operator can still override. Existing campaigns and non-AU/NZ
defaults are untouched.

## Scrape runs

Run locally (owner-scrapes-local rule) via `POST http://localhost:3001/api/scrape`
with the server up; if it is down, ask the operator to restart it.

- **Trustpilot (first):** AU + NZ on `car_dealer` + `restaurants_bars` (real SMB
  reputation-management leads). Casino — the single most frequent recent category — is
  **excluded by default**: the bulk-enrich memory records casino/gambling as a
  near-zero email-enrichment yield trap. Add casino only on explicit request.
- **Yelp:** AU + NZ, owner-local headed-browser listing (`YELP_LISTING_SOURCE=browser`).
- **TripAdvisor:** AU + NZ — cities already seeded (66). Optional: re-seed with the
  current `--fetcher browser` code to guarantee breadcrumb-containment-clean rows before
  a large run; not required to scrape now.

`max_rating` stays at the default 3.5 (low-rated = reputation-management target).

## Error handling
- Unknown/blank country → `us` locale → text unchanged, USD fallback tokens. Never throws.
- `localizeText` must never corrupt HTML: it operates on the already-rendered HTML string
  but only rewrites word tokens (letters), so tags/attributes/URLs are safe; tests assert
  an HTML body with links survives untouched except intended word changes.

## Testing (TDD)
Unit tests for `locale.ts` and the `renderAndSpin` integration:
1. `resolveLocale` returns correct triples for AU, NZ, US, unknown, undefined.
2. Spelling: irregulars, `-ize`/`-ization`/`-yze` families, `-our` allowlist, and that
   non-listed `-or` words (doctor, author) are untouched.
3. Case preservation across lower/Title/UPPER.
4. Idempotency: `localizeText(localizeText(x))===localizeText(x)`.
5. Word-boundary safety: URLs, emails, and domains containing target substrings are intact.
6. Currency/signoff tokens resolve per country and fall back for US.
7. Integration: `renderAndSpin` with an AU lead localises; with a US lead is byte-identical
   to today's output (regression guard).
8. HTML body with anchor tags survives localisation with only intended word changes.

## Files touched
- **New:** `server/src/services/locale.ts` (+ test).
- **Edit:** `server/src/services/template-engine.ts` (currency/signoff tokens; call
  `localizeText` at end of `renderAndSpin`).
- **Edit:** `frontend/src/components/campaign-wizard/StepSetup.tsx` (timezone default by country).
- **Ops (no code):** scrape runs for AU/NZ.

## What is explicitly NOT changing
- `renderAndSpin` signature and all 6 call sites.
- US / non-AU-NZ rendering output (regression-guarded).
- Any DB schema, seed JSON, or taxonomy code.
- `EmailPlatformAdapter` / `BasePlatformScraper` contracts.
