# Niche / Location Combobox UX — Design Spec

**Date:** 2026-06-05
**Scope:** Lead Scraping page → Facebook consumer-mode form fields (`Niche / service`, `Location / city`)
**Outcome:** the operator picks niche + location from curated suggestions with a green / yellow / warning tier badge per niche and a native-language hint for non-English-primary cities — so combinations that yesterday produced zero or noisy leads (website-builder anywhere; plumber in Rome) are visible signals before the scrape runs, not lessons learned afterwards. Free text is still accepted everywhere; the picker is suggestions, never a hard allowlist.

---

## Why now

Yesterday's empirical testing across ~6 scrape runs surfaced four classes of failure that the operator can only catch by reading the SCRAPER source:

1. **B2B niches don't generate FB-group consumer asks** ("website builder", "accountant"). Multiple runs returned 0/0 because FB groups don't discuss B2B services. The operator has no way to know which niches are tier-good vs tier-bad without trying.
2. **Non-English-primary cities** (Rome, Paris, Berlin) need native-language niche terms. Searching for English "plumber" in Rome FB groups returns mostly noise — Italians post `idraulico` / `cerco idraulico`. The Gemini classifier in `facebook.py` already drops the English noise correctly, but the operator never sees the hint to retry with an Italian niche.
3. **Surname-collision false positives** ("Yvette Rome" from Louisiana matched a Rome search). Mostly handled in the classifier now (commit b6d5f6b), but the operator-facing scrape form gave no hint that "Rome" without a country qualifier is ambiguous.
4. **Operators waste credits** running scrape jobs against combinations that the prior six categories of fixes guarantee will return zero. Each FB scrape ties up the Windows EC2 worker for 1-2 minutes and burns one Gemini classifier call.

Encoding the "handyman + London = good, website-builder + Rome = bad" knowledge in the form keeps that knowledge in the codebase rather than the operator's memory.

---

## Existing assets we reuse

| Asset | Purpose |
|---|---|
| `frontend/src/ui/Combobox.tsx` | Generic combobox UI primitive (suggestions + free-text input). Already mounted in `LocationPicker`. |
| `frontend/src/components/LocationPicker.tsx` | Already wraps `Combobox` with a curated `LOCATION_CITIES` table (~80 entries, US/UK/EU). Already wired into the FB form's location field. |
| `frontend/src/components/ScrapeForm.tsx:318-352` | The Facebook-consumer-mode form section. Currently has a plain `<input>` for niche and `<LocationPicker>` for location. |

The form already supports the manifest-driven conditional rendering pattern — no changes needed there.

---

## Architecture

```
ScrapeForm.tsx (modified)
   ├─ <NichePicker>       ← NEW: replaces the plain <input id="fb-niche">
   │     └─ <Combobox>    ← existing primitive
   ├─ <LocationPicker>    ← MODIFIED: surfaces language hint when picked
   │     └─ <Combobox>    ← existing primitive
   └─ <ComboWarning>      ← NEW: small derived banner under the niche+location pair
```

Data flow on every keystroke / picker change:

1. `fbNiche` + `fbLocation` state update (existing `useState` in ScrapeForm)
2. Pure derive in ScrapeForm: `comboWarning = computeWarning(fbNiche, fbLocation)` reads tier metadata from the niche list and language hint from the location list
3. `<ComboWarning>` renders the warning text inline. Submit is never blocked (per design Option A — see "Why now").

Both `<NichePicker>` and the tweaked `<LocationPicker>` still emit plain strings into the existing `fbNiche` / `fbLocation` state. No API change, no backend touch, no contract change with the FB scraper. The new files are pure UX scaffolding.

---

## New file — `frontend/src/data/fb-niches.ts`

```ts
export type NicheTier = 'high' | 'medium' | 'low';
export interface NicheEntry {
  slug: string;        // the actual string sent to the scraper (lowercase canonical form)
  label: string;       // display label, may have caps / spacing for readability
  tier: NicheTier;     // high = lots of FB-group consumer asks; low = B2B
  group: string;       // category for the dropdown's section header
}

export const FB_NICHES: NicheEntry[] = [
  // Trades — high volume on local FB community groups
  { slug: 'handyman',       label: 'Handyman',       tier: 'high',   group: 'Trades' },
  { slug: 'electrician',    label: 'Electrician',    tier: 'high',   group: 'Trades' },
  { slug: 'carpenter',      label: 'Carpenter',      tier: 'high',   group: 'Trades' },
  { slug: 'painter',        label: 'Painter',        tier: 'high',   group: 'Trades' },
  { slug: 'locksmith',      label: 'Locksmith',      tier: 'high',   group: 'Trades' },
  { slug: 'plumber',        label: 'Plumber',        tier: 'medium', group: 'Trades' },
  { slug: 'mechanic',       label: 'Mechanic',       tier: 'medium', group: 'Trades' },

  // Home & domestic services
  { slug: 'cleaner',        label: 'Cleaner',        tier: 'high',   group: 'Home Services' },
  { slug: 'gardener',       label: 'Gardener',       tier: 'high',   group: 'Home Services' },
  { slug: 'mover',          label: 'Mover',          tier: 'high',   group: 'Home Services' },
  { slug: 'pet sitter',     label: 'Pet Sitter',     tier: 'high',   group: 'Home Services' },
  { slug: 'dog walker',     label: 'Dog Walker',     tier: 'high',   group: 'Home Services' },
  { slug: 'babysitter',     label: 'Babysitter',     tier: 'high',   group: 'Home Services' },
  { slug: 'tutor',          label: 'Tutor',          tier: 'high',   group: 'Home Services' },

  // Personal care & lifestyle
  { slug: 'hairdresser',    label: 'Hairdresser',    tier: 'medium', group: 'Personal Care' },
  { slug: 'beautician',     label: 'Beautician',     tier: 'medium', group: 'Personal Care' },
  { slug: 'personal trainer', label: 'Personal Trainer', tier: 'medium', group: 'Personal Care' },
  { slug: 'photographer',   label: 'Photographer',   tier: 'medium', group: 'Personal Care' },
  { slug: 'dentist',        label: 'Dentist',        tier: 'medium', group: 'Personal Care' },

  // B2B / professional services — low FB-group consumer-ask volume
  { slug: 'website builder',    label: 'Website Builder',    tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'accountant',         label: 'Accountant',         tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'lawyer',             label: 'Lawyer',             tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'consultant',         label: 'Consultant',         tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'marketing agency',   label: 'Marketing Agency',   tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'seo',                label: 'SEO',                tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'copywriter',         label: 'Copywriter',         tier: 'low', group: 'B2B (low FB volume)' },
  { slug: 'financial advisor',  label: 'Financial Advisor',  tier: 'low', group: 'B2B (low FB volume)' },
];

export function findNicheBySlug(slug: string): NicheEntry | undefined {
  const lower = slug.trim().toLowerCase();
  return FB_NICHES.find((n) => n.slug === lower);
}
```

Adding niches later: drop a new `{slug, label, tier, group}` row. Tier ranking will eventually be data-driven from `scrape_jobs` history (Tier 2 — out of scope for this session).

---

## New component — `frontend/src/components/NichePicker.tsx`

Wraps the existing `<Combobox>` primitive. Two behaviors that distinguish it from a raw `<Combobox>`:

1. **Section headers** — group options by `entry.group` ("Trades", "Home Services", ...). The existing Combobox already supports group rendering (used by LocationPicker for country headers).
2. **Tier dot** — append a colored dot to each label: 🟢 for `high`, 🟡 for `medium`, ⚠️ for `low`. Pure CSS, no icon library.

API surface mirrors `LocationPicker`:

```ts
interface Props {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}
export default function NichePicker({ value, onChange, disabled, id }: Props): JSX.Element;
```

Free text always allowed (`allowCustom` on the underlying Combobox). The `value` emitted is the raw text string — exactly what the existing form state expects. Drop-in replacement for the current `<input id="fb-niche">` on `ScrapeForm.tsx:323-331`.

---

## Modified — `LocationPicker.tsx` (language hint)

Extend `LOCATION_CITIES` row shape with one optional field:

```ts
interface CityEntry {
  city: string;
  country: string;
  language?: string;    // NEW: 'English' (default), 'Italian', 'French', 'German', 'Spanish', etc.
  nativeNiche?: { en: string; native: string }[]; // OPTIONAL: niche-aware hints
}
```

For Tier 1 we only populate `language` (per-country, not per-city — Milan and Rome both inherit `language: 'Italian'`). The `nativeNiche` field is the v2 path (`plumber → idraulico`); we leave it as a hook but don't populate it this session — the cross-field warning component handles the simpler "post in this city is usually in {language}" copy.

LocationPicker.tsx itself only needs ONE change: when the picked value matches a city whose `language !== 'English'`, render a 1-line italic note under the combobox: *`Tip: posts in {city} are usually in {language}. The Gemini filter accepts both, but native-language niches surface more leads.`*

---

## New component — `frontend/src/components/ComboWarning.tsx`

Tiny stateless component. Inputs: the current `niche` and `location` strings. Output: zero, one, or two banner lines under the form (above the Start Scrape button).

```ts
interface Props { niche: string; location: string }
```

Decision table:

| Niche tier | Location language | Banner |
|---|---|---|
| `low` | any | ⚠️ "B2B niches rarely surface on FB community groups — expect few or no leads." |
| `medium` or `high` | non-English | 💡 "Posts in {city} are usually in {language}. Consider the native term for '{niche}' (e.g. *idraulico* for plumber in Italian)." |
| `medium` or `high` | English / unknown city | (no banner) |
| Custom text (not in `FB_NICHES`) | any | (no banner — we don't know the tier) |

Both copies are operator-editable in the component file. Per design Option A, the banner is informational only — the Start Scrape button stays enabled.

---

## Modified — `ScrapeForm.tsx`

Two diffs, both inside the existing `lead_type === 'consumers'` branch (`ScrapeForm.tsx:318-352`):

```diff
- <input id="fb-niche" type="text" placeholder='e.g. "dentist", "plumber"' value={fbNiche}
-        onChange={(e) => setFbNiche(e.target.value)} disabled={busy} ... />
+ <NichePicker id="fb-niche" value={fbNiche} onChange={setFbNiche} disabled={busy} />
```

And right above the existing helper text ("Group-first flow: we'll find every public FB group..."):

```diff
+ <ComboWarning niche={fbNiche} location={fbLocation} />
  <p className="text-[11px] ...">Group-first flow: ...</p>
```

No other ScrapeForm changes. Free text still accepted, existing submit logic untouched.

---

## What we are NOT building this session (deferred)

1. **Data-driven tier rankings** — read `scrape_jobs` history, count successes per (niche, location) combo, auto-rank. Future once we have enough data.
2. **Niche-aware native-language suggestion** — auto-swap "plumber" → "idraulico" on submit when location is in IT. The data shape (`nativeNiche` on CityEntry) is reserved; populating it is v2 work.
3. **Per-operator customization** — operator A's "high" might differ from operator B's. Today's list is one shared curated source of truth.
4. **Adding niches via the UI** — operators still need a code edit to add to `FB_NICHES`. Acceptable for v1.
5. **i18n on the UI itself** — the picker labels stay English. The form is operator-facing only and the operator works in English.

---

## Verification (end of implementation)

1. Open `/scrape` in the dashboard, pick "Facebook" platform, "People asking for a service" lead type.
2. **Niche dropdown** opens to grouped sections (Trades / Home Services / Personal Care / B2B) with green / yellow / warning dots.
3. Pick **"website builder"** → ⚠️ banner appears: "B2B niches rarely surface…". Pick **"handyman"** → banner clears.
4. Pick location **"Rome"** with niche still "plumber" → 💡 banner appears: "Posts in Rome are usually in Italian. Consider the native term…". Pick **"London"** → banner clears.
5. Type **"electrician"** as free text (not picking from dropdown) → no banner (unknown tier), submission still works.
6. Click **Start Scrape** with any combination — banner state never blocks submission.
7. `cd frontend && npx tsc --noEmit` passes.

---

## Self-review (for the spec author)

| Check | Result |
|---|---|
| Placeholder scan | ✅ no TBDs / TODOs; every step has concrete copy / file paths / code |
| Internal consistency | ✅ all four components agree on prop shapes and data flow |
| Scope check | ✅ one frontend feature, one session, ~45 min build estimate |
| Ambiguity check | ✅ explicit "free text always accepted, never blocks submit" |
| Architecture clean | ✅ pure UX, zero API / backend / scraper change; reuses existing `<Combobox>` primitive |
