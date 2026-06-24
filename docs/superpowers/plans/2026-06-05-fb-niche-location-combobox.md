# Niche / Location Combobox UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain `<input>` for the FB scrape form's niche field with a curated, tier-colored combobox; surface a language hint when the operator picks a non-English-primary city; show a small inline warning when the niche+location combo is suboptimal — without ever blocking submit.

**Architecture:** One enhancement to a shared UI primitive (`Combobox` gains an `allowCustom` mode for free text), one curated data file (`fb-niches.ts`), two new dumb components (`NichePicker`, `ComboWarning`), small edits to `LocationPicker` (language hint) and `ScrapeForm` (swap input → picker, mount warning). Zero backend changes, zero API contract change.

**Tech Stack:** React + TypeScript (Next.js 14, Vite-compiled frontend), Tailwind CSS, existing `<Combobox>` primitive in `frontend/src/ui/`. Pure browser-side UX scaffolding.

---

## Discovery (informs Task 1)

Reading `frontend/src/ui/Combobox.tsx`: the current primitive is selection-only. `value` only reflects an `option.value` that's already in the list. The query text inside the dropdown is purely a filter — there's no mechanism to commit it as the chosen value. So before we can build `NichePicker`, the primitive needs a small enhancement: an opt-in `allowCustom` prop that, when set and the operator presses **Enter** with a query that doesn't match any existing option, calls `onChange(query)` to emit the typed text as the new value.

LocationPicker keeps `allowCustom={false}` (default) so its curated behavior is unchanged. NichePicker will pass `allowCustom={true}` so operators can type niches not on the curated list (the spec's "free text always accepted" requirement).

---

## File structure

```
frontend/src/
├── data/
│   └── fb-niches.ts                 ← NEW (Task 2): NicheEntry + FB_NICHES + findNicheBySlug
├── components/
│   ├── NichePicker.tsx              ← NEW (Task 3): wraps Combobox with tier dots + group headers
│   ├── ComboWarning.tsx             ← NEW (Task 5): tiny stateless banner under the picker pair
│   ├── LocationPicker.tsx           ← MODIFY (Task 4): add optional `language` field + italic hint
│   └── ScrapeForm.tsx               ← MODIFY (Task 6): swap input for NichePicker + mount ComboWarning
└── ui/
    └── Combobox.tsx                 ← MODIFY (Task 1): add `allowCustom` prop + Enter-as-emit behaviour
```

---

## Task 1: Add `allowCustom` to the Combobox primitive

**Files:**
- Modify: `frontend/src/ui/Combobox.tsx`

The current keyboard handler accepts Enter only when an option is highlighted. Add a fallthrough: if `allowCustom` is true and the query is non-empty and no options match, Enter emits the query verbatim via `onChange(query as V)`.

- [ ] **Step 1.1: Read the current keyboard handler**

Run: `grep -n "onKeyDown\|handleKeyDown\|case 'Enter'\|'Enter'" frontend/src/ui/Combobox.tsx`

Locate the existing Enter handler (likely uses the active index to pick from `filtered`). Note the line number for the edit.

- [ ] **Step 1.2: Add `allowCustom` prop to the `Props` interface**

Edit `frontend/src/ui/Combobox.tsx`. In the `interface Props<V extends string>` block (around line 25), add this prop right above the closing brace:

```ts
  /**
   * When true, pressing Enter with a non-empty query that doesn't match any
   * option emits the raw query as the new value via onChange. Defaults to
   * false — selection-only, the historical behaviour.
   */
  allowCustom?: boolean;
```

Add it to the destructured props in the function signature (the block that destructures `value, onChange, options, placeholder, ...`):

```ts
  allowCustom = false,
```

- [ ] **Step 1.3: Enhance the Enter handler**

Inside the keyboard handler's `case 'Enter'` (or the equivalent — Combobox uses `KeyboardEvent` from React), change the existing logic from "pick highlighted option" to "pick highlighted option, or emit query if allowCustom && no match". The new logic:

```ts
// Inside the Enter case of the keydown handler, replace the existing pick logic:
if (filtered.length > 0 && activeIndex >= 0 && activeIndex < filtered.length) {
  const pick = filtered[activeIndex];
  if (!pick.isHeader) {
    onChange(pick.value);
    setOpen(false);
    setQuery('');
  }
} else if (allowCustom && query.trim().length > 0) {
  // No existing option matches — emit the typed text as a custom value.
  onChange(query.trim() as V);
  setOpen(false);
  setQuery('');
}
event.preventDefault();
```

Use the exact variable names already present in the file (`filtered`, `activeIndex`, `onChange`, `setOpen`, `setQuery`). If the file uses a different name for any of these, match the existing convention.

- [ ] **Step 1.4: Type-check**

Run: `cd frontend && npx tsc --noEmit`

Expected: clean (zero output). If you see a TS error about `onChange(query.trim() as V)`, ensure the `as V` cast is present — generic `V extends string` means a string assertion is needed.

- [ ] **Step 1.5: Commit**

```bash
git add frontend/src/ui/Combobox.tsx
git commit -m "feat(ui): Combobox allowCustom mode emits query on Enter when no match"
```

---

## Task 2: Create `fb-niches.ts` data file

**Files:**
- Create: `frontend/src/data/fb-niches.ts`

Self-contained: type, data, lookup helper. No React, no runtime side effects.

- [ ] **Step 2.1: Create the data directory if it doesn't exist**

Run: `mkdir -p frontend/src/data`

(Harmless on existing dirs.)

- [ ] **Step 2.2: Write the file**

Create `frontend/src/data/fb-niches.ts` with this exact content:

```ts
/**
 * Curated Facebook-friendly consumer-ask niches for the scrape form's
 * NichePicker. Tier reflects empirical FB-group activity — yesterday's
 * scrape tests showed B2B niches (website builder, accountant) return
 * 0 leads on FB groups, while trade niches (handyman, electrician) work.
 *
 * Operators can still type any niche as free text on the form — this
 * list is suggestions, not a hard allowlist.
 *
 * Adding a niche: drop a {slug, label, tier, group} row. Slugs are the
 * actual lowercase string sent to the scraper.
 *
 * Tier ranking will move to data-driven (from scrape_jobs success
 * history) in a future session — see the design spec dated 2026-06-05.
 */

export type NicheTier = 'high' | 'medium' | 'low';

export interface NicheEntry {
  slug: string;
  label: string;
  tier: NicheTier;
  group: string;
}

export const FB_NICHES: NicheEntry[] = [
  // Trades
  { slug: 'handyman',         label: 'Handyman',         tier: 'high',   group: 'Trades' },
  { slug: 'electrician',      label: 'Electrician',      tier: 'high',   group: 'Trades' },
  { slug: 'carpenter',        label: 'Carpenter',        tier: 'high',   group: 'Trades' },
  { slug: 'painter',          label: 'Painter',          tier: 'high',   group: 'Trades' },
  { slug: 'locksmith',        label: 'Locksmith',        tier: 'high',   group: 'Trades' },
  { slug: 'plumber',          label: 'Plumber',          tier: 'medium', group: 'Trades' },
  { slug: 'mechanic',         label: 'Mechanic',         tier: 'medium', group: 'Trades' },

  // Home & domestic services
  { slug: 'cleaner',          label: 'Cleaner',          tier: 'high',   group: 'Home Services' },
  { slug: 'gardener',         label: 'Gardener',         tier: 'high',   group: 'Home Services' },
  { slug: 'mover',            label: 'Mover',            tier: 'high',   group: 'Home Services' },
  { slug: 'pet sitter',       label: 'Pet Sitter',       tier: 'high',   group: 'Home Services' },
  { slug: 'dog walker',       label: 'Dog Walker',       tier: 'high',   group: 'Home Services' },
  { slug: 'babysitter',       label: 'Babysitter',       tier: 'high',   group: 'Home Services' },
  { slug: 'tutor',            label: 'Tutor',            tier: 'high',   group: 'Home Services' },

  // Personal care & lifestyle
  { slug: 'hairdresser',      label: 'Hairdresser',      tier: 'medium', group: 'Personal Care' },
  { slug: 'beautician',       label: 'Beautician',       tier: 'medium', group: 'Personal Care' },
  { slug: 'personal trainer', label: 'Personal Trainer', tier: 'medium', group: 'Personal Care' },
  { slug: 'photographer',     label: 'Photographer',     tier: 'medium', group: 'Personal Care' },
  { slug: 'dentist',          label: 'Dentist',          tier: 'medium', group: 'Personal Care' },

  // B2B / professional services — low FB-group consumer-ask volume
  { slug: 'website builder',   label: 'Website Builder',   tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'accountant',        label: 'Accountant',        tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'lawyer',            label: 'Lawyer',            tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'consultant',        label: 'Consultant',        tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'marketing agency',  label: 'Marketing Agency',  tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'seo',               label: 'SEO',               tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'copywriter',        label: 'Copywriter',        tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'financial advisor', label: 'Financial Advisor', tier: 'low', group: 'B2B (low FB volume)' },
];

/**
 * Resolve a niche entry by its slug (case-insensitive). Returns undefined
 * when the operator typed a free-text niche not in the curated list — the
 * caller should treat that as "no tier info, no warning".
 */
export function findNicheBySlug(slug: string): NicheEntry | undefined {
  const lower = slug.trim().toLowerCase();
  return FB_NICHES.find((n) => n.slug === lower);
}
```

- [ ] **Step 2.3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2.4: Commit**

```bash
git add frontend/src/data/fb-niches.ts
git commit -m "feat(data): curated FB niche list with tier metadata"
```

---

## Task 3: Create `NichePicker.tsx`

**Files:**
- Create: `frontend/src/components/NichePicker.tsx`

Mirrors `LocationPicker`'s shape so it's a drop-in replacement on the form. Renders tier dots inline next to each label and shows group headers.

- [ ] **Step 3.1: Write the file**

Create `frontend/src/components/NichePicker.tsx`:

```tsx
'use client';

import { useMemo } from 'react';
import Combobox, { type ComboboxOption } from '../ui/Combobox';
import { FB_NICHES, type NicheTier } from '../data/fb-niches';

interface Props {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

// Tier → dot color. Pure CSS, no icon library. Reading these as
// visual signals: 🟢 = lots of FB-group activity, 🟡 = variable,
// 🔴 = B2B (rarely surfaces on community groups).
function tierDot(tier: NicheTier): string {
  switch (tier) {
    case 'high':   return '🟢';
    case 'medium': return '🟡';
    case 'low':    return '🔴';
  }
}

export default function NichePicker({ value, onChange, disabled, id }: Props) {
  // Convert the curated FB_NICHES into ComboboxOption shape. Group headers
  // come from entry.group; the existing Combobox primitive already renders
  // section labels grouped by `group`.
  const options = useMemo<ComboboxOption[]>(
    () =>
      FB_NICHES.map((n) => ({
        value: n.slug,
        label: n.label,
        group: n.group,
        // searchText lets the operator find by tier word too — typing
        // "trade" matches the trades group.
        searchText: `${n.group} ${n.tier}`,
      })),
    [],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Pick or type a niche"
      searchPlaceholder="Search niches…"
      disabled={disabled}
      allowCustom
      renderOption={(opt) => {
        const entry = FB_NICHES.find((n) => n.slug === opt.value);
        return (
          <span className="flex items-center justify-between gap-3 w-full">
            <span className="truncate">{opt.label}</span>
            <span aria-hidden className="text-xs leading-none shrink-0">
              {entry ? tierDot(entry.tier) : ''}
            </span>
          </span>
        );
      }}
      renderValue={(opt) => {
        const entry = FB_NICHES.find((n) => n.slug === (opt?.value ?? value));
        return (
          <span className="flex items-center gap-2 truncate">
            {entry && (
              <span aria-hidden className="text-base leading-none">
                {tierDot(entry.tier)}
              </span>
            )}
            <span className="truncate">{opt?.label ?? value}</span>
          </span>
        );
      }}
    />
  );
}
```

- [ ] **Step 3.2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3.3: Commit**

```bash
git add frontend/src/components/NichePicker.tsx
git commit -m "feat(scrape): NichePicker combobox with tier dots + group headers"
```

---

## Task 4: Modify `LocationPicker` — language hint

**Files:**
- Modify: `frontend/src/components/LocationPicker.tsx`

Add an optional `language` field to the LOCATION_CITIES rows (per-country, not per-city). Render a small italic note under the combobox when the picked city has a non-English language.

- [ ] **Step 4.1: Read the existing `LOCATION_CITIES` table to see the shape**

Run: `grep -n "LOCATION_CITIES" frontend/src/components/LocationPicker.tsx | head -3`

Note the line where the array literal opens.

- [ ] **Step 4.2: Extend the row shape and tag non-English cities**

The current row shape is `{ city, country }`. Extend it to `{ city, country, language? }` and annotate every city whose country is non-English-primary. Edit the existing entries by adding `language: '<lang>'` to the matching rows. Apply this country → language map:

| Country code | Language |
|---|---|
| `DE` | `German` |
| `FR` | `French` |
| `IT` | `Italian` |
| `ES` | `Spanish` |
| `NL` | `Dutch` |
| `BE` | `Dutch` (Brussels can also be French — pick Dutch as the more-FB-active language) |
| `PT` | `Portuguese` |
| `BR` | `Portuguese` |
| `MX` | `Spanish` |
| `JP` | `Japanese` |
| `KR` | `Korean` |
| `RU` | `Russian` |
| `CN` | `Chinese` |
| `SE` | `Swedish` |
| `NO` | `Norwegian` |
| `DK` | `Danish` |
| `FI` | `Finnish` |
| `PL` | `Polish` |
| `CZ` | `Czech` |
| `GR` | `Greek` |
| `TR` | `Turkish` |
| `AT` | `German` |
| `CH` | `German` |
| `HU` | `Hungarian` |

Leave English-primary rows (GB, IE, US, CA, AU, NZ, ZA, PH, IN, SG) without a `language` field.

The simplest way to apply this: add a small helper above the array that returns the language for a country code, then map over the existing rows once. Replace the existing `LOCATION_CITIES` declaration with:

```ts
const NON_ENGLISH_LANGUAGES: Record<string, string> = {
  DE: 'German',   FR: 'French',     IT: 'Italian',  ES: 'Spanish',
  NL: 'Dutch',    BE: 'Dutch',      PT: 'Portuguese', BR: 'Portuguese',
  MX: 'Spanish',  JP: 'Japanese',   KR: 'Korean',   RU: 'Russian',
  CN: 'Chinese',  SE: 'Swedish',    NO: 'Norwegian',DK: 'Danish',
  FI: 'Finnish',  PL: 'Polish',     CZ: 'Czech',    GR: 'Greek',
  TR: 'Turkish',  AT: 'German',     CH: 'German',   HU: 'Hungarian',
};

interface CityEntry { city: string; country: string; language?: string }

// Raw curated list — country drives the language tag via the map above.
// Keep this in sync with tools/scraper/platforms/facebook.py CITY_TO_COUNTRY.
const _RAW_CITIES: Array<{ city: string; country: string }> = [
  // ... move the existing array literal here, unchanged ...
];

const LOCATION_CITIES: CityEntry[] = _RAW_CITIES.map((c) => ({
  ...c,
  language: NON_ENGLISH_LANGUAGES[c.country],
}));
```

Don't manually edit each row — the map handles it. Open the file, move the existing array literal to `_RAW_CITIES`, add the new map + derived array above the existing usages.

- [ ] **Step 4.3: Add the italic language hint under the Combobox**

In the `LocationPicker` function body, after the `<Combobox>` element, look up the picked city's language and conditionally render a hint:

```tsx
const pickedLanguage = useMemo(
  () => LOCATION_CITIES.find((c) => c.city === value)?.language,
  [value],
);

return (
  <div>
    <Combobox /* ...existing props... */ />
    {pickedLanguage && (
      <p className="mt-1 text-[11px] italic text-on-surface-variant">
        Tip: posts in {value} are usually in {pickedLanguage}. The Gemini
        filter accepts both, but native-language niches surface more leads.
      </p>
    )}
  </div>
);
```

Wrap the existing `<Combobox>` return in a `<div>` (it's currently a bare component). The wrapper holds the combobox + the optional hint together so the parent's grid layout still gets one cell per picker.

- [ ] **Step 4.4: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4.5: Commit**

```bash
git add frontend/src/components/LocationPicker.tsx
git commit -m "feat(scrape): LocationPicker surfaces native-language hint for non-English cities"
```

---

## Task 5: Create `ComboWarning.tsx`

**Files:**
- Create: `frontend/src/components/ComboWarning.tsx`

A tiny dumb component. Reads niche tier from `findNicheBySlug`, reads location language from `LOCATION_CITIES` (re-imported or re-derived — see below), emits zero or one banner line.

- [ ] **Step 5.1: Export the city-language map from LocationPicker**

So ComboWarning doesn't have to duplicate the city table. Open `frontend/src/components/LocationPicker.tsx` and add an exported lookup right above the existing helpers:

```ts
/** Returns the non-English language a city primarily uses, or undefined. */
export function findCityLanguage(city: string): string | undefined {
  return LOCATION_CITIES.find((c) => c.city === city)?.language;
}
```

- [ ] **Step 5.2: Write ComboWarning**

Create `frontend/src/components/ComboWarning.tsx`:

```tsx
'use client';

import { findNicheBySlug } from '../data/fb-niches';
import { findCityLanguage } from './LocationPicker';

interface Props {
  niche: string;
  location: string;
}

/**
 * Stateless inline warning beneath the niche/location picker pair.
 * Emits at most ONE message — niche tier check takes precedence
 * because it's the more impactful problem (B2B niches return 0
 * leads regardless of location).
 *
 * Never blocks submit — the form's submit button is independently
 * controlled. This is purely an informational hint to set operator
 * expectations before the scrape runs.
 */
export default function ComboWarning({ niche, location }: Props) {
  const nicheEntry = findNicheBySlug(niche);
  const cityLanguage = findCityLanguage(location);

  // Priority 1: B2B / low-tier niche — outweighs language concerns.
  if (nicheEntry?.tier === 'low') {
    return (
      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        ⚠️ <strong>B2B niche on FB:</strong> this niche rarely surfaces on
        community groups. Expect few or zero leads. Try a trade/home-service
        niche if you want consistent results.
      </div>
    );
  }

  // Priority 2: known niche + non-English location.
  if (nicheEntry && cityLanguage) {
    return (
      <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
        💡 <strong>Language tip:</strong> posts in {location} are usually in {cityLanguage}.
        Consider the native term for "{nicheEntry.label}" (e.g. <em>idraulico</em>{' '}
        for plumber in Italian) to surface more leads.
      </div>
    );
  }

  // No warning when:
  //  - niche is free text not in the curated list (we don't know the tier)
  //  - both niche and location look fine
  return null;
}
```

- [ ] **Step 5.3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5.4: Commit**

```bash
git add frontend/src/components/ComboWarning.tsx frontend/src/components/LocationPicker.tsx
git commit -m "feat(scrape): inline ComboWarning for B2B niche + language tip"
```

(Bundles the `findCityLanguage` export with the new component since they ship together.)

---

## Task 6: Wire into `ScrapeForm.tsx`

**Files:**
- Modify: `frontend/src/components/ScrapeForm.tsx`

Two diffs inside the existing `lead_type === 'consumers'` branch (around `ScrapeForm.tsx:318-352`):

- [ ] **Step 6.1: Add imports**

Add to the top of `frontend/src/components/ScrapeForm.tsx`, with the other component imports:

```tsx
import NichePicker from './NichePicker';
import ComboWarning from './ComboWarning';
```

- [ ] **Step 6.2: Swap the plain `<input>` for `<NichePicker>`**

Find the existing block (around line 323):

```tsx
<input
  id="fb-niche"
  type="text"
  placeholder='e.g. "dentist", "plumber", "tutor"'
  value={fbNiche}
  onChange={(e) => setFbNiche(e.target.value)}
  disabled={busy}
  className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
/>
```

Replace with:

```tsx
<NichePicker
  id="fb-niche"
  value={fbNiche}
  onChange={setFbNiche}
  disabled={busy}
/>
```

- [ ] **Step 6.3: Mount `<ComboWarning>` above the existing helper text**

Find the existing helper paragraph (around line 346):

```tsx
<p className="text-[11px] text-on-surface-variant">
  Group-first flow: we&apos;ll find every public FB group matching
  ...
</p>
```

Insert ComboWarning right above it, inside the same wrapping div:

```tsx
<ComboWarning niche={fbNiche} location={fbLocation} />
<p className="text-[11px] text-on-surface-variant">
  Group-first flow: ...
</p>
```

- [ ] **Step 6.4: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6.5: Manual smoke test (optional)**

Run dev server if convenient: `cd frontend && npm run dev`
Open `http://localhost:5173/scrape`, pick Facebook platform + "People asking for a service":

1. Open niche dropdown — see grouped sections (Trades / Home Services / Personal Care / B2B) with green/yellow/red dots
2. Pick "website builder" — amber B2B warning appears below
3. Pick "handyman" — warning clears
4. Pick "Rome" in location — italic language hint appears under location
5. With niche="plumber" + location="Rome" — sky-blue language tip appears below the form
6. Pick "London" — language tip clears
7. Click in niche field, type "exterminator" (not in curated list), press Enter — value sets to "exterminator", no warning appears
8. Click Start Scrape — submission still works regardless of warning state

If dev server isn't running, skip — type-check is the gate.

- [ ] **Step 6.6: Commit**

```bash
git add frontend/src/components/ScrapeForm.tsx
git commit -m "feat(scrape): mount NichePicker + ComboWarning in the FB consumer form"
```

---

## Task 7: Push and verify

- [ ] **Step 7.1: Push all 6 commits**

```bash
git push origin main
```

- [ ] **Step 7.2: Confirm Vercel auto-deploy picks up the change**

Vercel deploys on push to main. After ~60s, refresh `/scrape` in the live dashboard, confirm the niche field now opens as a combobox with the curated list and color dots.

No EC2 or Cloud Run work — this is frontend-only.

---

## Self-review

**Spec coverage** ✓
- Spec §3 (data file) → Task 2 ✓
- Spec §4 (NichePicker) → Task 3 ✓
- Spec §5 (LocationPicker language hint) → Task 4 ✓
- Spec §6 (ComboWarning) → Task 5 ✓
- Spec §7 (ScrapeForm wiring) → Task 6 ✓
- Spec "free text always accepted" → Task 1 enhancement to Combobox primitive ✓ (added because primitive didn't support it; discovery noted in plan header)

**Placeholder scan** ✓
No TBDs, no "implement later", every step has concrete code or commands.

**Type consistency** ✓
- `NicheEntry` shape defined in Task 2 matches usage in Tasks 3 + 5
- `findNicheBySlug` defined in Task 2, used in Task 5
- `findCityLanguage` defined in Task 5.1, used in Task 5.2
- `allowCustom` prop defined in Task 1, used in Task 3

**Scope check** ✓
Single frontend session, 7 small tasks, ~45 min total. No backend touch. Inline-execution friendly.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-05-fb-niche-location-combobox.md`. Two execution options:

**1. Subagent-Driven (recommended for fresh sessions)** — fresh subagent per task, review between tasks. Best for full implementation runs where context preservation matters.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints. Best when you want speed and the work is small + linear.

Given this plan is 7 small tasks all in the frontend (~45 min total), **inline execution** is the right call. Both code paths (subagent vs inline) preserve quality the same way since tasks are independent file-level changes.

**Which approach?**
