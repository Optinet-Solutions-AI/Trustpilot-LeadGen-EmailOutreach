# AU/NZ Localization + Scrape Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Localise cold-email content for Australia and New Zealand (spelling, currency, conservative phrasing, timezone default) and run AU/NZ lead scrapes, without changing any US/other-market behaviour.

**Architecture:** A new `server/src/services/locale.ts` owns all locale logic. It is invoked from a single seam — the end of `renderAndSpin` in `template-engine.ts` — so every send path (main, follow-ups, test flight) localises automatically with zero call-site changes. The frontend only gains a smarter timezone default. Country data already exists in the DB, so the platform work is purely running scrapes.

**Tech Stack:** Node.js + TypeScript (server), Vitest (tests, `*.test.ts` colocated), React + Vite (frontend), Python plugin scrapers via `POST /api/scrape`.

## Global Constraints

- Non-AU/NZ leads (including all existing US leads) must render **byte-identical** to today — locale logic is a no-op for the `us` variant. This is a hard regression guard.
- `renderAndSpin(template, lead)` signature and all 6 call sites are unchanged.
- No DB schema, seed JSON, or taxonomy code changes — AU/NZ are already in `platform_countries` for all platforms and TripAdvisor already has 66 seeded cities.
- Spelling/phrasing transforms must be **whole-word, case-preserving, and idempotent**, and must never alter text inside URLs, email addresses, or HTML tags.
- No auto-injected slang. `{{signoff}}` is `Cheers` for AU/NZ, `Best regards` otherwise.
- Timezone enum value for AU is `Australia/Melbourne` (labelled "Sydney / Melbourne (AEST/AEDT)"), for NZ is `Pacific/Auckland` — both already exist in `TIMEZONES`.
- Scrapes run locally (owner-scrapes-local rule) via `POST http://localhost:3001/api/scrape`; if the local server is down, ask the operator to restart it — never enqueue for EC2.
- Type-check before finishing: `npx tsc --noEmit` in `server` and `frontend`.

---

### Task 1: Locale service (`locale.ts`)

**Files:**
- Create: `server/src/services/locale.ts`
- Test: `server/src/services/locale.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LocaleInfo { variant: 'commonwealth' | 'us'; currencyCode: string; currencySymbol: string; signoff: string }`
  - `resolveLocale(country?: string): LocaleInfo`
  - `localizeText(text: string, country?: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/locale.test.ts
import { describe, it, expect } from 'vitest';
import { resolveLocale, localizeText } from './locale';

describe('resolveLocale', () => {
  it('maps AU to commonwealth + AUD', () => {
    expect(resolveLocale('AU')).toEqual({ variant: 'commonwealth', currencyCode: 'AUD', currencySymbol: 'A$', signoff: 'Cheers' });
  });
  it('maps NZ to commonwealth + NZD', () => {
    expect(resolveLocale('NZ')).toEqual({ variant: 'commonwealth', currencyCode: 'NZD', currencySymbol: 'NZ$', signoff: 'Cheers' });
  });
  it('maps US / unknown / undefined to the us default', () => {
    const us = { variant: 'us', currencyCode: 'USD', currencySymbol: '$', signoff: 'Best regards' };
    expect(resolveLocale('US')).toEqual(us);
    expect(resolveLocale('ZZ')).toEqual(us);
    expect(resolveLocale(undefined)).toEqual(us);
  });
  it('is case-insensitive on the country code', () => {
    expect(resolveLocale('au').variant).toBe('commonwealth');
  });
});

describe('localizeText (commonwealth)', () => {
  it('converts irregular spellings', () => {
    expect(localizeText('color center catalog favorite defense', 'AU'))
      .toBe('colour centre catalogue favourite defence');
  });
  it('converts -ize / -ization / -yze family', () => {
    expect(localizeText('organize optimization analyze', 'NZ'))
      .toBe('organise optimisation analyse');
  });
  it('preserves case', () => {
    expect(localizeText('Organize ORGANIZE organize', 'AU'))
      .toBe('Organise ORGANISE organise');
  });
  it('applies conservative lexical/phrase swaps', () => {
    expect(localizeText('Call my cell phone, note the zip code, do the math', 'AU'))
      .toBe('Call my mobile, note the postcode, do the maths');
  });
  it('is idempotent', () => {
    const once = localizeText('We organize and optimize your color', 'AU');
    expect(localizeText(once, 'AU')).toBe(once);
  });
  it('does NOT touch non-listed -or words', () => {
    expect(localizeText('the doctor and author', 'AU')).toBe('the doctor and author');
  });
  it('does NOT alter URLs, emails, or HTML tags', () => {
    const html = 'Visit <a href="https://organize.com/color">organize</a> or email info@optimize.io';
    expect(localizeText(html, 'AU'))
      .toBe('Visit <a href="https://organize.com/color">organise</a> or email info@optimize.io');
  });
  it('leaves substrings inside larger words alone', () => {
    expect(localizeText('organizecorp', 'AU')).toBe('organizecorp');
  });
  it('returns text unchanged for the us variant', () => {
    const s = 'We organize and optimize your color center.';
    expect(localizeText(s, 'US')).toBe(s);
    expect(localizeText(s, undefined)).toBe(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/locale.test.ts`
Expected: FAIL — `Cannot find module './locale'` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/locale.ts
/**
 * Locale service — resolves a per-lead locale from the lead's country and
 * localises rendered email copy for Commonwealth-English markets (AU/NZ).
 *
 * Deliberately conservative: only whole-word, case-preserving, idempotent
 * transforms, and never touches URLs, emails, or HTML tags. Any market not
 * listed resolves to the `us` variant, which is a pure no-op — existing
 * (US and every other) campaign output is unchanged.
 */

export interface LocaleInfo {
  variant: 'commonwealth' | 'us';
  currencyCode: string;
  currencySymbol: string;
  signoff: string;
}

const LOCALES: Record<string, LocaleInfo> = {
  AU: { variant: 'commonwealth', currencyCode: 'AUD', currencySymbol: 'A$', signoff: 'Cheers' },
  NZ: { variant: 'commonwealth', currencyCode: 'NZD', currencySymbol: 'NZ$', signoff: 'Cheers' },
};

const US_LOCALE: LocaleInfo = {
  variant: 'us', currencyCode: 'USD', currencySymbol: '$', signoff: 'Best regards',
};

export function resolveLocale(country?: string): LocaleInfo {
  if (!country) return US_LOCALE;
  return LOCALES[country.trim().toUpperCase()] ?? US_LOCALE;
}

// Curated US -> Commonwealth word map (base + inflected forms are listed
// explicitly to stay idempotent and avoid unsafe blanket regex rules such
// as a naive -ize rule that would wrongly hit size/prize/seize).
const WORD_MAP: Record<string, string> = {
  // -our family (explicit allowlist only)
  color: 'colour', colors: 'colours', colored: 'coloured', coloring: 'colouring',
  favor: 'favour', favors: 'favours', favored: 'favoured', favoring: 'favouring',
  favorite: 'favourite', favorites: 'favourites',
  honor: 'honour', honors: 'honours', honored: 'honoured',
  labor: 'labour', neighbor: 'neighbour', neighbors: 'neighbours',
  behavior: 'behaviour', behaviors: 'behaviours',
  flavor: 'flavour', flavors: 'flavours', humor: 'humour',
  // -re family
  center: 'centre', centers: 'centres', centered: 'centred',
  // -ise / -isation family (curated business-email verbs)
  organize: 'organise', organizes: 'organises', organized: 'organised', organizing: 'organising',
  organization: 'organisation', organizations: 'organisations',
  optimize: 'optimise', optimizes: 'optimises', optimized: 'optimised', optimizing: 'optimising',
  optimization: 'optimisation',
  realize: 'realise', realizes: 'realises', realized: 'realised', realizing: 'realising',
  recognize: 'recognise', recognizes: 'recognises', recognized: 'recognised', recognizing: 'recognising',
  apologize: 'apologise', apologized: 'apologised',
  prioritize: 'prioritise', prioritized: 'prioritised', prioritizing: 'prioritising',
  customize: 'customise', customized: 'customised', customizing: 'customising',
  personalize: 'personalise', personalized: 'personalised', personalizing: 'personalising',
  maximize: 'maximise', maximized: 'maximised', maximizing: 'maximising',
  minimize: 'minimise', minimized: 'minimised', minimizing: 'minimising',
  emphasize: 'emphasise', emphasized: 'emphasised',
  summarize: 'summarise', summarized: 'summarised',
  specialize: 'specialise', specialized: 'specialised', specializing: 'specialising',
  standardize: 'standardise', standardized: 'standardised',
  utilize: 'utilise', utilized: 'utilised', utilizing: 'utilising',
  capitalize: 'capitalise', capitalized: 'capitalised',
  analyze: 'analyse', analyzes: 'analyses', analyzed: 'analysed', analyzing: 'analysing',
  // other common irregulars
  catalog: 'catalogue', catalogs: 'catalogues',
  defense: 'defence', offense: 'offence', license: 'licence',
  traveler: 'traveller', travelers: 'travellers', traveling: 'travelling', traveled: 'travelled',
  fulfill: 'fulfil', fulfillment: 'fulfilment',
  enrollment: 'enrolment', canceled: 'cancelled', canceling: 'cancelling',
  // conservative lexical/tone swaps
  math: 'maths',
};

// Multi-word phrase swaps applied before the single-word pass.
const PHRASE_MAP: Array<[RegExp, string]> = [
  [/\bcell phones\b/gi, 'mobiles'],
  [/\bcell phone\b/gi, 'mobile'],
  [/\bzip codes\b/gi, 'postcodes'],
  [/\bzip code\b/gi, 'postcode'],
];

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// Mask URLs, emails, and HTML tags so their internals are never rewritten.
const MASK_PATTERNS = [
  /<[^>]+>/g,                        // HTML tags
  /https?:\/\/[^\s"'<>]+/gi,         // http(s) URLs
  /\bwww\.[^\s"'<>]+/gi,             // bare www URLs
  /[\w.+-]+@[\w-]+\.[\w.-]+/gi,      // emails
];

export function localizeText(text: string, country?: string): string {
  if (resolveLocale(country).variant !== 'commonwealth') return text;

  // Mask protected spans.
  const masks: string[] = [];
  let masked = text;
  for (const re of MASK_PATTERNS) {
    masked = masked.replace(re, (m) => {
      const token = ` ${masks.length} `;
      masks.push(m);
      return token;
    });
  }

  // Phrase swaps first.
  for (const [re, rep] of PHRASE_MAP) {
    masked = masked.replace(re, (m) => matchCase(m, rep));
  }

  // Whole-word single-token swaps.
  masked = masked.replace(/[A-Za-z]+/g, (word) => {
    const rep = WORD_MAP[word.toLowerCase()];
    return rep ? matchCase(word, rep) : word;
  });

  // Restore masked spans.
  return masked.replace(/ (\d+) /g, (_, i) => masks[Number(i)]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/locale.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/locale.ts server/src/services/locale.test.ts
git commit -m "feat(campaigns): add AU/NZ locale service (spelling, currency, tone)"
```

---

### Task 2: Wire locale into the template engine

**Files:**
- Modify: `server/src/services/template-engine.ts`
- Test: `server/src/services/template-engine.test.ts` (create)

**Interfaces:**
- Consumes: `resolveLocale`, `localizeText` from Task 1.
- Produces: unchanged public API — `renderTemplate(template, lead)`, `renderAndSpin(template, lead)`. New tokens `{{currency_code}}`, `{{currency_symbol}}`, `{{signoff}}` available in copy.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/template-engine.test.ts
import { describe, it, expect } from 'vitest';
import { renderAndSpin } from './template-engine';

describe('renderAndSpin locale integration', () => {
  it('localises spelling for an AU lead', () => {
    const out = renderAndSpin('We optimize your online reputation.', { country: 'AU' });
    expect(out).toBe('We optimise your online reputation.');
  });

  it('resolves currency + signoff tokens by country', () => {
    expect(renderAndSpin('Prices in {{currency_code}} ({{currency_symbol}}). {{signoff}}', { country: 'NZ' }))
      .toBe('Prices in NZD (NZ$). Cheers');
    expect(renderAndSpin('Prices in {{currency_code}} ({{currency_symbol}}). {{signoff}}', { country: 'US' }))
      .toBe('Prices in USD ($). Best regards');
  });

  it('is a no-op (byte-identical) for a US lead — regression guard', () => {
    const tpl = 'We organize and optimize your color center for {{company_name}}.';
    const lead = { country: 'US', company_name: 'Acme' };
    expect(renderAndSpin(tpl, lead)).toBe('We organize and optimize your color center for Acme.');
  });

  it('localises after spintax resolves', () => {
    // Only one spintax option so the assertion is deterministic.
    const out = renderAndSpin('{We optimize|We optimize} your catalog.', { country: 'AU' });
    expect(out).toBe('We optimise your catalogue.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/template-engine.test.ts`
Expected: FAIL — `optimize` not localised / `{{currency_code}}` left literal.

- [ ] **Step 3: Write minimal implementation**

In `server/src/services/template-engine.ts`, add the import near the top (after the spintax import on line 11):

```ts
import { resolveLocale, localizeText } from './locale.js';
```

Add three entries to `TOKEN_MAP` (after the `email` entry, before the social tokens):

```ts
  currency_code:   (l) => resolveLocale(l.country).currencyCode,
  currency_symbol: (l) => resolveLocale(l.country).currencySymbol,
  signoff:         (l) => resolveLocale(l.country).signoff,
```

Replace the body of `renderAndSpin` (lines 87-90) with:

```ts
export function renderAndSpin(template: string, lead: LeadData): string {
  const tokenResolved = renderTemplate(template, lead);
  const spun = resolveSpintax(tokenResolved);
  return localizeText(spun, lead.country);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/template-engine.test.ts src/services/locale.test.ts`
Expected: PASS (both files). Then `cd server && npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/template-engine.ts server/src/services/template-engine.test.ts
git commit -m "feat(campaigns): localise rendered email copy + add currency/signoff tokens"
```

---

### Task 3: AU/NZ timezone default in the campaign wizard

**Files:**
- Modify: `frontend/src/components/campaign-wizard/StepSetup.tsx`

**Interfaces:**
- Consumes: existing `TIMEZONES`, `SendingSchedule`, `onChange` prop.
- Produces: no new exports; changes only the timezone default behaviour on country change.

- [ ] **Step 1: Add the country→timezone default map**

In `frontend/src/components/campaign-wizard/StepSetup.tsx`, immediately after `DEFAULT_SCHEDULE` (line 87), add:

```ts
// When the operator targets AU/NZ, default the send window to that market's
// timezone (both values already exist in TIMEZONES). Only a default — the
// operator can still override via the Sending Schedule dropdown.
const COUNTRY_TIMEZONE_DEFAULTS: Record<string, string> = {
  AU: 'Australia/Melbourne',
  NZ: 'Pacific/Auckland',
};
```

- [ ] **Step 2: Apply the default on country change**

Replace the Country `<select>` `onChange` (line 160) with:

```tsx
              onChange={(e) => {
                const country = e.target.value;
                const tz = COUNTRY_TIMEZONE_DEFAULTS[country];
                onChange(
                  tz
                    ? { filterCountry: country, schedule: { ...schedule, timezone: tz } }
                    : { filterCountry: country }
                );
              }}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Start the frontend (`cd frontend && npm run dev`), open the campaign wizard Step 1, set Country = Australia, open Sending Schedule → Timezone shows "Sydney / Melbourne (AEST/AEDT)". Set Country = New Zealand → shows "New Zealand (NZST/NZDT)". Set Country = United States → timezone is left as-is (not forced).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/campaign-wizard/StepSetup.tsx
git commit -m "feat(campaigns): default send-window timezone to AU/NZ when targeted"
```

---

### Task 4: Run AU + NZ Trustpilot scrapes (ops — no test cycle)

**Files:** none (operational task).

**Interfaces:**
- Consumes: local API at `http://localhost:3001/api/scrape`.
- Produces: new `leads` rows for AU/NZ; verified by count query.

- [ ] **Step 1: Confirm the local server is up**

Run: `curl -s http://localhost:3001/api/scrape -X GET`
Expected: JSON job list (`{"success":true,...}`). If the connection is refused, STOP and ask the operator to start the server (`cd server && npm run dev`) — do not enqueue for EC2.

- [ ] **Step 2: Launch the four Trustpilot jobs (AU/NZ × car_dealer/restaurants_bars)**

Run each (max_rating 3.5 = reputation-management target). Casino is intentionally excluded (near-zero enrichment yield per the bulk-enrich lesson); add it only on explicit operator request.

```bash
for CC in AU NZ; do
  for CAT in car_dealer restaurants_bars; do
    curl -s -X POST http://localhost:3001/api/scrape \
      -H 'Content-Type: application/json' \
      -d "{\"platform\":\"trustpilot\",\"filters\":{\"country\":\"$CC\",\"category\":\"$CAT\",\"max_rating\":3.5},\"max_results\":100}"
    echo
  done
done
```

Expected: each returns `{"success":true,"data":{"jobId":"..."}}`.

- [ ] **Step 3: Watch jobs to completion**

Poll `curl -s http://localhost:3001/api/scrape` and confirm each of the four jobs reaches `status: "completed"` (or `failed` — investigate the job log if so). Only `completed`/`failed` count as done; `running`/`null` mean still in flight.

- [ ] **Step 4: Verify leads landed**

Run:
```bash
cd "c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH" && .venv/Scripts/python.exe -c "
from tools.db.supabase_client import get_client
c=get_client()
for cc in ['AU','NZ']:
    r=c.from_('leads').select('id',count='exact').eq('country',cc).execute()
    print(cc, r.count)
" 2>/dev/null
```
Expected: non-zero counts for AU and NZ.

- [ ] **Step 5: Run Yelp + TripAdvisor (owner-local)**

Repeat Step 2's POST for `platform:"yelp"` (categories `car_dealer` maps to Yelp taxonomy — use `auto` / `restaurants`; confirm valid Yelp category slugs from `tools/scraper/data/yelp_categories.json` first) and `platform:"tripadvisor"` (category `restaurants`). TripAdvisor cities are already seeded (66 AU/NZ). These are owner-local (headed browser) — run on the owner's machine only.

- [ ] **Step 6: Log to PMS + report**

Per the standing directive, log completion to the PMS board (create in To Do/In Progress, then move to Done with today's `dueDate`).

---

## Self-Review

**Spec coverage:**
- Locale-aware seam in `renderAndSpin` → Task 2. ✅
- `locale.ts` with `resolveLocale` + `localizeText` → Task 1. ✅
- Spelling (irregulars + curated -ise/-our families, case-preserving, idempotent) → Task 1. ✅
- Currency tokens → Task 2. ✅
- Conservative phrasing + `{{signoff}}` → Tasks 1 (phrases) + 2 (signoff token). ✅
- Timezone default → Task 3. ✅
- US/other-market regression guard → Task 2 Step 1 (byte-identical test) + Task 1 us-variant no-op test. ✅
- URL/email/HTML safety → Task 1 tests. ✅
- Scrape runs (TP first, then Yelp/TA, local-only, casino excluded) → Task 4. ✅

**Placeholder scan:** No TBD/TODO; all code steps contain full code. Step 5 of Task 4 flags that Yelp category slugs must be confirmed against `yelp_categories.json` (concrete file), not a vague placeholder.

**Type consistency:** `LocaleInfo` fields (`variant`, `currencyCode`, `currencySymbol`, `signoff`) are used identically in Task 1 tests, Task 1 impl, and Task 2 token map. `localizeText(text, country)` / `resolveLocale(country)` signatures match across tasks. `renderAndSpin(template, lead)` unchanged.

**Deviation from spec noted:** spec said `Australia/Sydney`; the actual `TIMEZONES` enum value is `Australia/Melbourne` (labelled "Sydney / Melbourne") — plan uses the real value.
