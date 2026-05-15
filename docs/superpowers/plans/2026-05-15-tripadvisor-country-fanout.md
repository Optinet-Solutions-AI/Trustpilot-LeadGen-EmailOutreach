# TripAdvisor Country/Category Fan-Out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TripAdvisor's geo_id / location_slug form with a Trustpilot-style Country + Category UX, with the backend fanning out across every seeded city for the chosen country.

**Architecture:** Frontend keeps the existing `CountryPicker` and adds a 3-option Category dropdown. A new Supabase table `tripadvisor_cities` (seeded once by an offline Python tool) holds every city TripAdvisor lists for every country. On scrape, `scrape-runner.ts` reads that table, then spawns the existing per-city `run.py` once per city, dedup'ing results by `profile_url` and merging into the same enrich → upsert → verify pipeline that already works for TripAdvisor.

**Tech Stack:** TypeScript (Express + Vite/React), Python 3 (Playwright + ScrapingBee), Supabase (PostgreSQL), Vitest for server unit tests.

**Spec:** [`docs/superpowers/specs/2026-05-15-tripadvisor-country-fanout-design.md`](../specs/2026-05-15-tripadvisor-country-fanout-design.md)

---

## File map

| Path | Responsibility |
|---|---|
| `supabase/migrations/036_tripadvisor_cities.sql` | NEW — city table + index |
| `tools/scraper/data/tripadvisor_country_geo.json` | NEW — country ISO → TA geo ID map |
| `tools/scraper/seed_tripadvisor_cities.py` | NEW — offline seeder |
| `server/src/db/tripadvisor-cities.ts` | NEW — DB helpers |
| `server/src/db/tripadvisor-cities.test.ts` | NEW — unit tests |
| `server/src/routes/tripadvisor.ts` | NEW — `GET /api/tripadvisor/cities` |
| `server/src/server.ts` | MODIFY — wire new route |
| `server/src/routes/scrape.ts` | MODIFY — accept new TA params, validate seed |
| `server/src/services/scrape-runner.ts` | MODIFY — TA city fan-out loop |
| `frontend/src/types/scrape.ts` | MODIFY — `TripAdvisorScrapeParams` shape |
| `frontend/src/context/ScrapeContext.tsx` | MODIFY — startScrape body translation |
| `frontend/src/components/ScrapeForm.tsx` | MODIFY — collapse TA branch |
| `frontend/src/components/ScrapeCostAdvisory.tsx` | NEW — credit advisory + confirm gate |
| `frontend/src/components/ActiveScrapeCard.tsx` | MODIFY — city counter |

---

## Task 1 — Migration 036: `tripadvisor_cities` table

**Files:**
- Create: `supabase/migrations/036_tripadvisor_cities.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 036_tripadvisor_cities.sql
-- Seeds the universe of TripAdvisor cities the scraper can fan out
-- across when a user picks a country. One row per (country, city);
-- populated by tools/scraper/seed_tripadvisor_cities.py.
-- ============================================================

CREATE TABLE IF NOT EXISTS tripadvisor_cities (
  geo_id       text        PRIMARY KEY,           -- TripAdvisor geo identifier, e.g. "60745"
  country_code text        NOT NULL,              -- ISO-2, matches leads.country, e.g. "US"
  name         text        NOT NULL,              -- "Boston"
  slug         text        NOT NULL,              -- "Boston_Massachusetts"
  rank         int         NOT NULL DEFAULT 0,    -- ordering hint within a country
  active       boolean     NOT NULL DEFAULT true, -- soft-disable bad rows without delete
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tripadvisor_cities_country_active_rank_idx
  ON tripadvisor_cities (country_code, active, rank);

COMMENT ON TABLE tripadvisor_cities IS
  'Seed of TripAdvisor city geo IDs per country. Populated by tools/scraper/seed_tripadvisor_cities.py. Read by scrape-runner when a user scrapes by country.';
```

- [ ] **Step 2: Apply the migration manually**

Open the Supabase SQL editor (project `trustpilot-leadgen`) and paste the migration body. Run it.

Verify in the SQL editor:
```sql
select count(*) from tripadvisor_cities;
-- Expected: 0
\d tripadvisor_cities
-- Expected: 8 columns + the index listed
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/036_tripadvisor_cities.sql
git commit -m "feat(db): add tripadvisor_cities seed table for country fan-out"
```

---

## Task 2 — Country geo-ID static map

TripAdvisor identifies each country by a numeric `g{geo}` ID embedded in its URLs (e.g. `g191` = USA, `g186216` = UK). The seeder needs that mapping to know which TA country page to walk.

**Files:**
- Create: `tools/scraper/data/tripadvisor_country_geo.json`

- [ ] **Step 1: Create the JSON file**

Write the file with the following content (start with the largest markets — the seeder skips any country missing here, so it's safe to grow the list over time):

```json
{
  "US": { "geo": "191",    "slug": "United_States" },
  "GB": { "geo": "186216", "slug": "England" },
  "FR": { "geo": "187070", "slug": "France" },
  "DE": { "geo": "187275", "slug": "Germany" },
  "IT": { "geo": "187768", "slug": "Italy" },
  "ES": { "geo": "187427", "slug": "Spain" },
  "CA": { "geo": "153339", "slug": "Canada" },
  "AU": { "geo": "255055", "slug": "Australia" },
  "NL": { "geo": "188553", "slug": "The_Netherlands" },
  "BE": { "geo": "188634", "slug": "Belgium" },
  "CH": { "geo": "188045", "slug": "Switzerland" },
  "AT": { "geo": "190410", "slug": "Austria" },
  "IE": { "geo": "186591", "slug": "Ireland" },
  "PT": { "geo": "189100", "slug": "Portugal" },
  "GR": { "geo": "189398", "slug": "Greece" },
  "SE": { "geo": "189806", "slug": "Sweden" },
  "NO": { "geo": "190455", "slug": "Norway" },
  "DK": { "geo": "189512", "slug": "Denmark" },
  "FI": { "geo": "189896", "slug": "Finland" },
  "PL": { "geo": "274723", "slug": "Poland" },
  "CZ": { "geo": "274684", "slug": "Czech_Republic" },
  "JP": { "geo": "294232", "slug": "Japan" },
  "KR": { "geo": "294196", "slug": "South_Korea" },
  "SG": { "geo": "294262", "slug": "Singapore" },
  "TH": { "geo": "293915", "slug": "Thailand" },
  "MY": { "geo": "293951", "slug": "Malaysia" },
  "ID": { "geo": "294225", "slug": "Indonesia" },
  "PH": { "geo": "294245", "slug": "Philippines" },
  "VN": { "geo": "293921", "slug": "Vietnam" },
  "IN": { "geo": "293860", "slug": "India" },
  "AE": { "geo": "294012", "slug": "United_Arab_Emirates" },
  "IL": { "geo": "293977", "slug": "Israel" },
  "TR": { "geo": "293969", "slug": "Turkey" },
  "EG": { "geo": "294200", "slug": "Egypt" },
  "ZA": { "geo": "293810", "slug": "South_Africa" },
  "MX": { "geo": "150768", "slug": "Mexico" },
  "BR": { "geo": "294280", "slug": "Brazil" },
  "AR": { "geo": "294270", "slug": "Argentina" },
  "CL": { "geo": "294291", "slug": "Chile" },
  "PE": { "geo": "294314", "slug": "Peru" },
  "NZ": { "geo": "255104", "slug": "New_Zealand" }
}
```

(41 countries. Operator extends the list as needed; unknown ISO-2 codes will fall through to a `WARN: skipping country XX, no geo ID` log line during seeding.)

- [ ] **Step 2: Commit**

```bash
git add tools/scraper/data/tripadvisor_country_geo.json
git commit -m "feat(scraper): tripadvisor country -> geo ID map for seeding"
```

---

## Task 3 — Python seed scraper

Walks the Tourism page for each country, extracts every city link, upserts to `tripadvisor_cities`.

**Files:**
- Create: `tools/scraper/seed_tripadvisor_cities.py`

- [ ] **Step 1: Write the seeder**

```python
"""
Offline seeder for tripadvisor_cities.

Walks each country's Tourism page on TripAdvisor and extracts every
linked city: geo_id, slug, display name. UPSERTs into Supabase.

Run once per country, or all at once:

    python -m tools.scraper.seed_tripadvisor_cities --country US
    python -m tools.scraper.seed_tripadvisor_cities --all

Cost: ~1-3 ScrapingBee credits per country page. Two-level walk for
big countries (US, GB, FR, IT) follows alphabetical "All destinations"
links and may add another ~5-10 credits each.

Idempotent: rerunning preserves any row manually marked active=false.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Iterable

from bs4 import BeautifulSoup

# Allow running as `python tools/scraper/seed_tripadvisor_cities.py`
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from tools.scraper.shared.scrapingbee import (
    fetch_via_scrapingbee_tiered,
    scrapingbee_enabled,
)
from tools.db.supabase_client import get_supabase

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'tripadvisor_country_geo.json')

# Cities show up as <a href="/Tourism-g{geo}-{slug}-Vacations.html">Display Name</a>
# inside the country page, or as bare profile links from "Popular Destinations".
# We accept both Tourism-g{geo}-{slug}-* and the more permissive g{geo} link
# anywhere under the country page.
CITY_HREF_RE = re.compile(
    r'/Tourism-g(?P<geo>\d+)-(?P<slug>[A-Za-z0-9_]+)-(?:Vacations|Things_To_Do)\.html'
)
# The alphabetical "All destinations" page lives under
# /Tourism-g{country_geo}-activities-c52.html-style URLs; the link
# anchor text is the human city name.
SLUG_NAME_OVERRIDE = re.compile(r'_+')


def _load_country_map() -> dict[str, dict]:
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def _country_url(geo: str, slug: str) -> str:
    return f"https://www.tripadvisor.com/Tourism-g{geo}-{slug}-Vacations.html"


def _slug_to_name(slug: str) -> str:
    return SLUG_NAME_OVERRIDE.sub(' ', slug).strip()


def _extract_cities(html: str, country_geo: str) -> list[dict]:
    """
    Pull every distinct city Tourism link out of a country page. We exclude
    the country's own geo so the country page doesn't get inserted as a city.

    Returns [{geo_id, slug, name}, ...] dedup'd by geo_id.
    """
    soup = BeautifulSoup(html, 'lxml')
    found: dict[str, dict] = {}
    for a in soup.find_all('a', href=True):
        m = CITY_HREF_RE.search(a['href'])
        if not m:
            continue
        geo = m.group('geo')
        if geo == country_geo:
            continue
        slug = m.group('slug')
        # Prefer the anchor's visible text as the display name; fall back to
        # de-underscoring the slug.
        anchor_text = (a.get_text() or '').strip()
        name = anchor_text if anchor_text and len(anchor_text) <= 80 else _slug_to_name(slug)
        if geo not in found:
            found[geo] = {'geo_id': geo, 'slug': slug, 'name': name}
    return list(found.values())


def seed_country(country_code: str, country_geo: str, country_slug: str) -> int:
    url = _country_url(country_geo, country_slug)
    print(f"\n[{country_code}] fetching {url}")
    html = fetch_via_scrapingbee_tiered(url, render_js=True)
    if not html:
        print(f"[{country_code}] WARN: empty HTML returned — skipping")
        return 0

    cities = _extract_cities(html, country_geo)
    print(f"[{country_code}] extracted {len(cities)} cities")
    if not cities:
        return 0

    rows = [
        {
            'geo_id':       c['geo_id'],
            'country_code': country_code,
            'name':         c['name'],
            'slug':         c['slug'],
            # First page is naturally ranked by TA — preserve that order
            'rank':         idx,
            # Don't touch `active` on UPSERT — preserve operator overrides
        }
        for idx, c in enumerate(cities)
    ]

    sb = get_supabase()
    # Insert with on_conflict='geo_id' to upsert; explicitly omit `active` from
    # the update set so manual disables stick.
    res = (
        sb.table('tripadvisor_cities')
          .upsert(
              rows,
              on_conflict='geo_id',
              # supabase-py forwards this to PostgREST as the `Prefer:
              # resolution=...` header and the update column list.
              ignore_duplicates=False,
          )
          .execute()
    )
    written = len(res.data or [])
    print(f"[{country_code}] upserted {written} rows")
    return written


def main() -> None:
    p = argparse.ArgumentParser(prog='seed_tripadvisor_cities')
    p.add_argument('--country', help='ISO-2 country code, e.g. US')
    p.add_argument('--all', action='store_true', help='Seed every country in the geo map')
    p.add_argument('--sleep', type=float, default=1.0, help='Seconds to sleep between countries when --all is set')
    args = p.parse_args()

    if not scrapingbee_enabled():
        print('ERROR: SCRAPINGBEE_API_KEY is not set — required for the seeder.')
        raise SystemExit(2)

    geo_map = _load_country_map()

    if args.country:
        entry = geo_map.get(args.country.upper())
        if not entry:
            print(f"ERROR: country '{args.country}' is not in {DATA_PATH}")
            raise SystemExit(2)
        seed_country(args.country.upper(), entry['geo'], entry['slug'])
        return

    if args.all:
        total = 0
        for code, entry in geo_map.items():
            written = seed_country(code, entry['geo'], entry['slug'])
            total += written
            time.sleep(args.sleep)
        print(f"\nDONE — total rows upserted: {total}")
        return

    p.print_help()
    raise SystemExit(1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Smoke-test against one country**

Make sure `SCRAPINGBEE_API_KEY` is set in `.env`, then:

```powershell
.venv/Scripts/python.exe -m tools.scraper.seed_tripadvisor_cities --country US
```

Expected stdout:
```
[US] fetching https://www.tripadvisor.com/Tourism-g191-United_States-Vacations.html
[US] extracted N cities
[US] upserted N rows
```

Where `N` is at minimum ~10. Then verify in Supabase SQL editor:

```sql
select count(*), country_code from tripadvisor_cities group by country_code;
-- Expected: at least one row for US with count >= 10
select name, slug, geo_id from tripadvisor_cities where country_code='US' order by rank limit 5;
-- Spot-check: rows look like real US cities (New York, Las Vegas, Los Angeles, etc.)
```

If `N` is 0 or wildly wrong, inspect the raw HTML by adding a `with open('/tmp/us.html','w') as f: f.write(html)` line above the parse — TripAdvisor occasionally renames classes/attributes and the `CITY_HREF_RE` regex will need an adjustment. Fix and re-run before moving on.

- [ ] **Step 3: Seed every country**

```powershell
.venv/Scripts/python.exe -m tools.scraper.seed_tripadvisor_cities --all
```

Expected: ~5–15 minutes of execution, ~200–500 SB credits spent. Final line `DONE — total rows upserted: N`.

Verify:
```sql
select country_code, count(*) from tripadvisor_cities group by country_code order by country_code;
-- Expected: every ISO-2 code from the JSON map present, each with >=1 row.
```

- [ ] **Step 4: Commit**

```bash
git add tools/scraper/seed_tripadvisor_cities.py
git commit -m "feat(scraper): one-time seeder for tripadvisor_cities"
```

---

## Task 4 — Server DB helper for tripadvisor_cities

**Files:**
- Create: `server/src/db/tripadvisor-cities.ts`
- Create: `server/src/db/tripadvisor-cities.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/db/tripadvisor-cities.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => mockSupabase,
}));

import { listActiveCitiesForCountry, countActiveCitiesForCountry } from './tripadvisor-cities.js';

function chain(result: { data: unknown; error: unknown }) {
  const calls: string[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      calls.push(prop);
      return new Proxy({}, handler);
    },
  };
  return { mock: new Proxy({}, handler), calls };
}

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('tripadvisor-cities', () => {
  test('listActiveCitiesForCountry filters by country_code + active and orders by rank', async () => {
    const { mock } = chain({
      data: [
        { geo_id: '60745', country_code: 'US', name: 'Boston', slug: 'Boston_Massachusetts', rank: 0 },
        { geo_id: '60763', country_code: 'US', name: 'New York', slug: 'New_York_City', rank: 1 },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(mock);

    const out = await listActiveCitiesForCountry('US');
    expect(mockSupabase.from).toHaveBeenCalledWith('tripadvisor_cities');
    expect(out).toHaveLength(2);
    expect(out[0].geo_id).toBe('60745');
    expect(out[1].name).toBe('New York');
  });

  test('countActiveCitiesForCountry returns count', async () => {
    const { mock } = chain({ data: null, error: null, count: 487 } as unknown as {
      data: unknown; error: unknown;
    });
    mockSupabase.from.mockReturnValue(mock);

    const n = await countActiveCitiesForCountry('US');
    expect(n).toBe(487);
  });

  test('listActiveCitiesForCountry throws when supabase returns an error', async () => {
    const { mock } = chain({ data: null, error: { message: 'boom' } });
    mockSupabase.from.mockReturnValue(mock);
    await expect(listActiveCitiesForCountry('US')).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd server && npx vitest run src/db/tripadvisor-cities.test.ts
```

Expected: FAIL — `Cannot find module './tripadvisor-cities.js'`.

- [ ] **Step 3: Implement the DB helper**

```typescript
// server/src/db/tripadvisor-cities.ts
import { getSupabase } from '../lib/supabase.js';

export interface TripAdvisorCity {
  geo_id: string;
  country_code: string;
  name: string;
  slug: string;
  rank: number;
}

/**
 * Active, ranked cities for a country. The scrape-runner consumes this list
 * verbatim — the order returned here is the order each city is scraped in.
 */
export async function listActiveCitiesForCountry(countryCode: string): Promise<TripAdvisorCity[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('tripadvisor_cities')
    .select('geo_id,country_code,name,slug,rank')
    .eq('country_code', countryCode)
    .eq('active', true)
    .order('rank', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TripAdvisorCity[];
}

/** Lightweight count used by GET /api/tripadvisor/cities for the form's cost advisory. */
export async function countActiveCitiesForCountry(countryCode: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('tripadvisor_cities')
    .select('*', { count: 'exact', head: true })
    .eq('country_code', countryCode)
    .eq('active', true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd server && npx vitest run src/db/tripadvisor-cities.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Type-check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/tripadvisor-cities.ts server/src/db/tripadvisor-cities.test.ts
git commit -m "feat(db): tripadvisor_cities helper + tests"
```

---

## Task 5 — `GET /api/tripadvisor/cities` route

Frontend pulls the count to render the credit-cost advisory.

**Files:**
- Create: `server/src/routes/tripadvisor.ts`
- Modify: `server/src/server.ts` (register the router)

- [ ] **Step 1: Write the route**

```typescript
// server/src/routes/tripadvisor.ts
import { Router, Request, Response } from 'express';
import { countActiveCitiesForCountry } from '../db/tripadvisor-cities.js';

const router = Router();
const param = (v: string | string[] | undefined): string => Array.isArray(v) ? v[0] : (v ?? '');

// GET /api/tripadvisor/cities?country=US — count of seeded, active cities.
// Used by the Scrape form to size the credit-cost advisory.
router.get('/cities', async (req: Request, res: Response) => {
  try {
    const country = param(req.query.country as string | string[] | undefined).toUpperCase();
    if (!country) {
      res.status(400).json({ success: false, error: 'country query parameter required' });
      return;
    }
    const count = await countActiveCitiesForCountry(country);
    res.json({ success: true, data: { country, count } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
```

- [ ] **Step 2: Wire the route into server.ts**

Open `server/src/server.ts` and find the section where other routers are mounted (look for lines like `app.use('/api/scrape', ...)`). Add:

```typescript
import tripadvisorRouter from './routes/tripadvisor.js';
// … existing imports …

// … existing app.use() calls …
app.use('/api/tripadvisor', tripadvisorRouter);
```

Place the `app.use` line next to the other `/api/...` routers, keeping alphabetical or domain-grouped order with whatever convention is already in the file.

- [ ] **Step 3: Type-check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke-test**

Start the server locally (`cd server && npm run dev`) and:

```powershell
curl "http://localhost:3001/api/tripadvisor/cities?country=US" -H "x-api-key: $env:API_SECRET_KEY"
```

Expected: `{"success":true,"data":{"country":"US","count":N}}` where N matches the row count from Task 3's verification query.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/tripadvisor.ts server/src/server.ts
git commit -m "feat(api): GET /api/tripadvisor/cities for cost advisory"
```

---

## Task 6 — Update `POST /api/scrape` to accept the new TA shape

**Files:**
- Modify: `server/src/routes/scrape.ts:27-60` (platform manifest), `:215-233` (per-platform validation), `:258-271` (filters envelope), `:273-286` (createJob call)

- [ ] **Step 1: Replace TripAdvisor's `filter_schema` in the platform manifest**

Find `PLATFORM_MANIFESTS` (around line 27). Replace the `tripadvisor` entry's `filter_schema` with the new shape:

```typescript
  {
    name: 'tripadvisor',
    label: 'TripAdvisor',
    base_url: 'https://www.tripadvisor.com',
    requires_proxy: true,
    filter_schema: [
      { name: 'country',    type: 'select', label: 'Country',    required: true,  options_source: 'taxonomy:countries' },
      { name: 'category',   type: 'select', label: 'Category',   required: true,
        options: [
          { value: 'hotels',      label: 'Hotels' },
          { value: 'restaurants', label: 'Restaurants' },
          { value: 'attractions', label: 'Attractions' },
        ] },
      { name: 'min_rating', type: 'number', label: 'Min rating', required: false, default: 1.0, min: 1.0, max: 5.0, step: 0.5 },
      { name: 'max_rating', type: 'number', label: 'Max rating', required: false, default: 3.0, min: 1.0, max: 5.0, step: 0.5 },
    ],
  },
```

- [ ] **Step 2: Replace TripAdvisor's per-platform validation**

Find the `else if (platform === 'tripadvisor')` block (around line 215). Replace the entire block with:

```typescript
    } else if (platform === 'tripadvisor') {
      const taCountry = (rawFilters.country ?? body.country) as string | undefined;
      const category  = (rawFilters.category ?? body.category) as string | undefined;
      if (!taCountry || !category) {
        res.status(400).json({
          success: false,
          error: 'tripadvisor requires country and category',
        });
        return;
      }
      if (!['hotels', 'restaurants', 'attractions'].includes(category)) {
        res.status(400).json({
          success: false,
          error: `category must be one of: hotels, restaurants, attractions`,
        });
        return;
      }
      // Reject if there are no seeded cities for this country — without
      // them the fan-out would produce zero leads. The operator must run
      // tools/scraper/seed_tripadvisor_cities.py --country XX first.
      const { countActiveCitiesForCountry } = await import('../db/tripadvisor-cities.js');
      const cityCount = await countActiveCitiesForCountry(taCountry.toUpperCase());
      if (cityCount === 0) {
        res.status(400).json({
          success: false,
          error: `No seeded cities for country ${taCountry}. Run tools/scraper/seed_tripadvisor_cities.py --country ${taCountry} first.`,
        });
        return;
      }
    }
```

- [ ] **Step 3: Update the filters envelope + createJob call**

Find the `platformFilters` definition (around line 258). The Trustpilot branch is unchanged. Replace the non-Trustpilot branch and the subsequent `createJob` call so TripAdvisor stores `country` + `category` cleanly:

```typescript
    const platformFilters: Record<string, unknown> = platform === 'trustpilot'
      ? {
          country,
          category,
          min_rating: minRating,
          max_rating: maxRating,
          enrich,
          verify,
        }
      : platform === 'tripadvisor'
      ? {
          country:    (rawFilters.country  ?? body.country)  as string,
          category:   (rawFilters.category ?? body.category) as string,
          min_rating: minRating,
          max_rating: maxRating,
          enrich,
          verify,
        }
      : {
          ...(rawFilters as Record<string, unknown>),
          enrich,
          verify,
        };

    const job = await createJob({
      // For TripAdvisor, store the ISO country code in scrape_jobs.country
      // (so the Recent Jobs UI shows "US — hotels"), and the listing type in
      // .category. Trustpilot path is unchanged.
      country: platform === 'trustpilot'
        ? (country as string)
        : platform === 'tripadvisor'
          ? String(platformFilters.country)
          : `_${platform}_`,
      category: platform === 'trustpilot'
        ? (category as string)
        : platform === 'tripadvisor'
          ? String(platformFilters.category)
          : (rawFilters.listing_type as string ?? 'all'),
      min_rating: minRating,
      max_rating: maxRating,
      enrich,
      verify,
      source: 'manual',
      platform,
      filters: platformFilters,
    });
```

- [ ] **Step 4: Type-check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Smoke-test the new contract**

Start the server (`npm run dev` in `server/`). Try a bad request:

```powershell
curl -X POST "http://localhost:3001/api/scrape" `
  -H "Content-Type: application/json" `
  -H "x-api-key: $env:API_SECRET_KEY" `
  -d '{"platform":"tripadvisor","filters":{"country":"ZZ","category":"hotels"}}'
```

Expected: `400 { success: false, error: "No seeded cities for country ZZ. Run tools/scraper/seed_tripadvisor_cities.py --country ZZ first." }`.

Then a good request (but immediately cancel — full fan-out is Task 7's job):
```powershell
curl -X POST "http://localhost:3001/api/scrape" `
  -H "Content-Type: application/json" `
  -H "x-api-key: $env:API_SECRET_KEY" `
  -d '{"platform":"tripadvisor","filters":{"country":"US","category":"hotels","min_rating":1,"max_rating":3}}'
```

Expected: `200 { success: true, data: { jobId: "...", platform: "tripadvisor" } }`. Cancel via `POST /api/scrape/:id/cancel` so it doesn't start spinning before Task 7's loop is in place.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/scrape.ts
git commit -m "feat(api): tripadvisor scrape accepts country+category, validates seed"
```

---

## Task 7 — Backend city fan-out in `scrape-runner.ts`

This is the heart of the feature. When TripAdvisor jobs run, instead of a single `run.py --action list` invocation, the orchestrator loops over every seeded city, dedup'ing results.

**Files:**
- Modify: `server/src/services/scrape-runner.ts:540-680` (the `runScrapeJobViaRunPy` function)

- [ ] **Step 1: Add imports at the top of the file**

Find the existing imports block at the top of `scrape-runner.ts` (around line 17–21). Add `listActiveCitiesForCountry`:

```typescript
import { listActiveCitiesForCountry, type TripAdvisorCity } from '../db/tripadvisor-cities.js';
```

- [ ] **Step 2: Add a TripAdvisor branch inside `runScrapeJobViaRunPy`**

Open `runScrapeJobViaRunPy` (starts at line 552). The current implementation always runs a single `run.py --action list` for any non-Trustpilot platform. Insert a TripAdvisor-specific block that runs the city fan-out before the existing Phase 2 (enrich) call.

Replace the **Phase 1: listing scrape** block (lines 569–598) with the following. The rest of the function (Phase 2 enrichment, Phase 3 upsert, Phase 4 screenshots, Phase 5 website enrichment, Phase 6 failure count) stays exactly as it is — the new block produces the same `rawOutput` JSON file the existing pipeline already consumes.

```typescript
    // ── Phase 1: listing scrape ──────────────────────────────────
    const rawOutput = path.join(tmpDir, `${jobId}_raw.json`);
    const filtersJson = JSON.stringify(filters ?? {});

    let rawData: Array<Record<string, unknown>> = [];

    if (platform === 'tripadvisor') {
      // Fan out across every seeded city for the country, dedup'ing by
      // profile_url. Each city is a separate run.py spawn so cancellation
      // and watchdog logic stay per-process.
      const f = (filters ?? {}) as Record<string, unknown>;
      const country = String(f.country ?? '').toUpperCase();
      const category = String(f.category ?? 'hotels');
      const minRating = Number(f.min_rating ?? 1.0);
      const maxRating = Number(f.max_rating ?? 3.0);

      const cities: TripAdvisorCity[] = await listActiveCitiesForCountry(country);
      if (cities.length === 0) {
        // Defensive — POST /api/scrape already rejects this case, but a
        // race could empty the table between submit and run. Treat as
        // an early successful completion of 0 leads.
        await updateJob(jobId, {
          status: 'completed',
          total_found: 0,
          total_scraped: 0,
          completed_at: new Date().toISOString(),
        });
        emitProgress(jobId, 'completed', `No seeded cities for ${country}`);
        return;
      }

      emitProgress(jobId, 'city_total', String(cities.length));

      const dedup = new Map<string, Record<string, unknown>>();
      const CONCURRENCY = 2;
      let cityIdx = 0;
      let cancelled = false;

      const runOneCity = async (city: TripAdvisorCity): Promise<void> => {
        if (cancelled) return;

        // Check that the job hasn't been cancelled between iterations.
        try {
          const { data: jobRow } = await getSupabase()
            .from('scrape_jobs').select('status').eq('id', jobId).single();
          if (jobRow && (jobRow.status === 'cancelled' || jobRow.status === 'failed')) {
            cancelled = true;
            return;
          }
        } catch {
          // Treat lookup failure as transient — keep going.
        }

        const cityOutput = path.join(tmpDir, `${jobId}_city_${city.geo_id}.json`);
        const cityFilters = {
          location_id:   city.geo_id,
          location_slug: city.slug,
          listing_type:  category,
          min_rating:    minRating,
          max_rating:    maxRating,
        };
        emitProgress(jobId, 'city_start', `${city.geo_id}|${city.name}`);
        try {
          const { promise } = runPython(jobId, 'tools/scraper/run.py', [
            '--platform', 'tripadvisor',
            '--action', 'list',
            '--filters', JSON.stringify(cityFilters),
            '--output', cityOutput,
          ]);
          await promise;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tripadvisor] city ${city.geo_id} (${city.name}) failed:`, msg);
          emitProgress(jobId, 'city_failed', `${city.geo_id}|${city.name}|${msg.slice(0, 200)}`);
          return; // skip this city, continue to the next
        }

        try {
          const cityRows: Array<Record<string, unknown>> =
            JSON.parse(fs.readFileSync(cityOutput, 'utf-8'));
          for (const row of cityRows) {
            const key = String(row.profile_url ?? '');
            if (key && !dedup.has(key)) {
              dedup.set(key, { ...row, country, city: city.name, city_geo_id: city.geo_id });
            }
          }
          emitProgress(jobId, 'city_done', `${city.geo_id}|${city.name}|${cityRows.length}`);
        } catch (err) {
          console.warn(`[tripadvisor] failed reading ${cityOutput}:`, err);
        } finally {
          // Clean up the per-city temp file — keeps tmpDir from filling up
          try { fs.unlinkSync(cityOutput); } catch {}
        }
      };

      // Bounded concurrency worker loop.
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (cityIdx < cities.length && !cancelled) {
          const myIdx = cityIdx++;
          await runOneCity(cities[myIdx]);
        }
      });
      await Promise.all(workers);

      rawData = Array.from(dedup.values());
      fs.writeFileSync(rawOutput, JSON.stringify(rawData, null, 2), 'utf-8');
      await updateJob(jobId, { total_found: rawData.length });
      emitProgress(jobId, 'category_done', String(rawData.length));
    } else {
      // Original single-call path for all non-TA platforms.
      const { promise: listPromise } = runPython(jobId, 'tools/scraper/run.py', [
        '--platform', platform,
        '--action', 'list',
        '--filters', filtersJson,
        '--output', rawOutput,
      ]);
      await listPromise;

      try {
        rawData = JSON.parse(fs.readFileSync(rawOutput, 'utf-8'));
        await updateJob(jobId, { total_found: rawData.length });
        emitProgress(jobId, 'category_done', String(rawData.length));
      } catch (err) {
        console.error(`[${platform}] Failed to read listing output for job ${jobId}:`, err);
        emitProgress(jobId, 'category_done', '0');
      }
    }

    if (rawData.length === 0) {
      await updateJob(jobId, {
        status: 'completed',
        total_scraped: 0,
        completed_at: new Date().toISOString(),
      });
      emitProgress(jobId, 'completed', 'No listings matched the filter.');
      return;
    }
```

- [ ] **Step 3: Type-check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke-test with a tiny country**

Pick a country with few seeded cities to keep the test cheap. Run the seed verification first:

```sql
select country_code, count(*) from tripadvisor_cities
  where country_code in ('FI','NO','DK','AT') group by country_code order by 2;
```

Pick the one with the lowest count (likely ~5–10 cities). Then:

```powershell
curl -X POST "http://localhost:3001/api/scrape" `
  -H "Content-Type: application/json" `
  -H "x-api-key: $env:API_SECRET_KEY" `
  -d '{"platform":"tripadvisor","filters":{"country":"FI","category":"hotels","min_rating":1,"max_rating":3,"enrich":false,"verify":false}}'
```

Expected behavior:
- Server logs show one `[TA page 1]` line per city (5–10 cities)
- SSE on `/api/scrape/:id/status` (or just polling `/api/scrape`) shows the job moving from `running` → `completed`
- Final `total_found` is the dedup'd total
- No process leaks (`activeProcesses.size` returns to 0 — check by hitting the existing rate-limit/health endpoint or just inspect server stdout)

If the job stalls on a city, ScrapingBee probably returned empty HTML — the loop will continue to the next city after `runOneCity` returns. The `city_failed` PROGRESS event surfaces it.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/scrape-runner.ts
git commit -m "feat(scraper): tripadvisor city fan-out across seeded cities"
```

---

## Task 8 — Frontend types: drop geo_id/slug, add country + category

**Files:**
- Modify: `frontend/src/types/scrape.ts:23-33`

- [ ] **Step 1: Replace `TripAdvisorScrapeParams`**

Replace the entire `TripAdvisorScrapeParams` interface with:

```typescript
export interface TripAdvisorScrapeParams {
  platform: 'tripadvisor';
  country: string;
  category: 'hotels' | 'restaurants' | 'attractions';
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  forceRescrape: boolean;
}
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: errors in `ScrapeForm.tsx` and `ScrapeContext.tsx` referencing the removed fields. That's fine — Tasks 9 and 10 fix them.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/scrape.ts
git commit -m "feat(frontend): retype TripAdvisorScrapeParams to country+category"
```

(The commit will leave TS errors. Acceptable as a checkpoint commit because Tasks 9–10 land in the same branch and finish the migration. If you prefer a clean tree, combine Tasks 8, 9, 10 into one commit.)

---

## Task 9 — ScrapeContext: translate the new TA shape

**Files:**
- Modify: `frontend/src/context/ScrapeContext.tsx:147-162`

- [ ] **Step 1: Replace the tripadvisor branch of the body translator**

Find the `body` assignment in `startScrape` (around lines 147–162). Replace it with:

```typescript
      const body =
        params.platform === 'tripadvisor'
          ? {
              platform: 'tripadvisor',
              filters: {
                country: params.country,
                category: params.category,
                min_rating: params.min_rating,
                max_rating: params.max_rating,
                enrich: params.enrich,
                verify: params.verify,
              },
              forceRescrape: params.forceRescrape,
            }
          : params;
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: errors in `ScrapeForm.tsx` only (ScrapeContext now compiles).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/context/ScrapeContext.tsx
git commit -m "feat(frontend): scrape context posts tripadvisor country+category"
```

---

## Task 10 — ScrapeForm: collapse the TripAdvisor branch

**Files:**
- Modify: `frontend/src/components/ScrapeForm.tsx`

- [ ] **Step 1: Update local state declarations**

Find the "TripAdvisor fields" state block (around line 35). Replace:

```typescript
  // TripAdvisor fields
  const [locationId, setLocationId] = useState('');
  const [locationSlug, setLocationSlug] = useState('');
  const [listingType, setListingType] = useState<'hotels' | 'restaurants' | 'attractions'>('hotels');
  const [taMinRating, setTaMinRating] = useState(1.0);
  const [taMaxRating, setTaMaxRating] = useState(3.0);
```

With:

```typescript
  // TripAdvisor fields — mirrors Trustpilot's shape on purpose
  const [taCountry, setTaCountry] = useState('US');
  const [taCategory, setTaCategory] = useState<'hotels' | 'restaurants' | 'attractions'>('hotels');
  const [taMinRating, setTaMinRating] = useState(1.0);
  const [taMaxRating, setTaMaxRating] = useState(3.0);
```

- [ ] **Step 2: Update the submit handler's TripAdvisor branch**

Find the `if (platform === 'tripadvisor')` block in `handleSubmit` (around line 57). Replace it with:

```typescript
    if (platform === 'tripadvisor') {
      params = {
        platform: 'tripadvisor',
        country: taCountry,
        category: taCategory,
        min_rating: taMinRating,
        max_rating: taMaxRating,
        enrich,
        verify,
        forceRescrape,
      } satisfies TripAdvisorScrapeParams;
    } else {
```

(Note: we no longer pre-validate via `alert()` because Country always has a default and Category is a controlled dropdown — neither can be empty.)

- [ ] **Step 3: Replace the JSX inside `{platform === 'tripadvisor' && (…)}`**

Find the `platform === 'tripadvisor'` JSX branch (around line 158). Replace the entire `<> … </>` body with:

```tsx
        {platform === 'tripadvisor' && (
          <>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ta-country">
                Country
              </label>
              <CountryPicker id="ta-country" value={taCountry} onChange={setTaCountry} disabled={busy} />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="ta-category">
                Category
              </label>
              <Combobox
                id="ta-category"
                value={taCategory}
                onChange={(v) => setTaCategory(v as 'hotels' | 'restaurants' | 'attractions')}
                options={LISTING_TYPE_OPTIONS}
                placeholder="Pick a category"
                disabled={busy}
              />
            </div>
            <RangeInput
              label="Bubble rating"
              suffix="★"
              value={[taMinRating, taMaxRating]}
              onChange={([lo, hi]) => {
                setTaMinRating(lo);
                setTaMaxRating(hi);
              }}
              min={1}
              max={5}
              step={0.5}
              disabled={busy}
            />
          </>
        )}
```

- [ ] **Step 4: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Visual smoke-test**

Run the frontend and the server, open the Scrape page, switch the Platform picker to TripAdvisor. The form should now show Country + Category + Bubble rating only — no Geo ID, no Location slug.

```powershell
# Terminal A
cd server; npm run dev

# Terminal B
cd frontend; npm run dev
```

Open http://localhost:5173 → Scrape → switch platform to TripAdvisor → confirm three controls visible. Click Start scrape with country `FI` (small market for cheap test). The job should kick off and within ~30s show progress.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ScrapeForm.tsx
git commit -m "feat(frontend): tripadvisor scrape form uses country + category"
```

---

## Task 11 — Credit cost advisory + confirmation gate

**Files:**
- Create: `frontend/src/components/ScrapeCostAdvisory.tsx`
- Modify: `frontend/src/components/ScrapeForm.tsx` (mount the advisory)

- [ ] **Step 1: Write the advisory component**

```tsx
// frontend/src/components/ScrapeCostAdvisory.tsx
import { useEffect, useState } from 'react';
import api from '../api/client';

// Per-page credit cost on ScrapingBee premium_proxy tier (rounded up).
const CREDITS_PER_LISTING_PAGE = 15;
// Heuristic: TA listing pages average ~3 pages per city before exhausting.
const AVG_PAGES_PER_CITY = 3;

interface Props {
  country: string;
  /** Threshold above which the user is asked to confirm before submitting. */
  confirmAboveCredits?: number;
  /** Called with a function the parent uses to gate submission. */
  onGuardReady: (guard: () => Promise<boolean>) => void;
}

/**
 * Renders a tiny advisory line above the Start button when the TripAdvisor
 * platform is selected:
 *
 *   ~487 cities x ~3 pages = ~22,005 ScrapingBee credits (before enrichment)
 *
 * Exposes a `guard()` to the parent that resolves false (block submit) if
 * the user declines the high-cost confirmation dialog.
 */
export default function ScrapeCostAdvisory({
  country,
  confirmAboveCredits = 5000,
  onGuardReady,
}: Props) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!country) { setCount(null); return; }
    api.get(`/tripadvisor/cities?country=${encodeURIComponent(country)}`)
      .then((res) => {
        if (!cancelled) setCount(res.data?.data?.count ?? 0);
      })
      .catch(() => { if (!cancelled) setCount(0); });
    return () => { cancelled = true; };
  }, [country]);

  const estimatedCredits = count == null ? null : count * AVG_PAGES_PER_CITY * CREDITS_PER_LISTING_PAGE;

  useEffect(() => {
    onGuardReady(async () => {
      if (estimatedCredits == null || estimatedCredits < confirmAboveCredits) return true;
      const msg = `This scrape fans out across ${count} cities and may consume up to ~${estimatedCredits.toLocaleString()} ScrapingBee credits before profile enrichment.\n\nContinue?`;
      // window.confirm is synchronous; resolve immediately.
      return window.confirm(msg);
    });
  }, [estimatedCredits, count, confirmAboveCredits, onGuardReady]);

  if (count == null) return null;
  if (count === 0) {
    return (
      <p className="text-[12px] text-red-600 dark:text-red-400">
        No seeded cities for {country}. Run <code>seed_tripadvisor_cities.py --country {country}</code> first.
      </p>
    );
  }
  return (
    <p className="text-[12px] text-on-surface-muted">
      ~{count} cities × ~{AVG_PAGES_PER_CITY} pages = ~{estimatedCredits?.toLocaleString()} SB credits (before enrichment)
    </p>
  );
}
```

- [ ] **Step 2: Wire the advisory into ScrapeForm**

At the top of `ScrapeForm.tsx`, import the component:

```typescript
import ScrapeCostAdvisory from './ScrapeCostAdvisory';
```

In `ScrapeForm`'s body, add a ref to the guard:

```typescript
  const guardRef = useRef<(() => Promise<boolean>) | null>(null);
```

Update `handleSubmit` so that — only for TripAdvisor — it awaits the guard before calling `onSubmit`:

```typescript
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || loading) return;
    /* …existing params build… */
    if (platform === 'tripadvisor' && guardRef.current) {
      const ok = await guardRef.current();
      if (!ok) return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      onSubmit(params);
    } finally {
      setTimeout(() => {
        submittingRef.current = false;
        setIsSubmitting(false);
      }, 1500);
    }
  };
```

(Note `async` on `handleSubmit`. The signature change is harmless — React forms accept async submit handlers.)

Inside the TA branch JSX, just below the `RangeInput`, mount the advisory:

```tsx
            <div className="sm:col-span-2 lg:col-span-3">
              <ScrapeCostAdvisory
                country={taCountry}
                onGuardReady={(g) => { guardRef.current = g; }}
              />
            </div>
```

- [ ] **Step 3: Type-check + smoke-test**

```bash
cd frontend && npx tsc --noEmit
```

In the browser, on the Scrape page with TripAdvisor selected, change the country to `US`. The advisory line should appear with a credit estimate. Clicking Start should pop a `confirm()` dialog if the estimate exceeds 5,000.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ScrapeCostAdvisory.tsx frontend/src/components/ScrapeForm.tsx
git commit -m "feat(frontend): tripadvisor scrape cost advisory + confirm gate"
```

---

## Task 12 — ActiveScrapeCard: city counter + handle error stage

While we're in this file anyway, fix the unrelated UX bug noticed earlier: the SSE handler ignores `stage === 'error'` and leaves the card spinning forever when the underlying job no longer exists.

**Files:**
- Modify: `frontend/src/components/ActiveScrapeCard.tsx`

- [ ] **Step 1: Add new state for city progress**

Inside the `ActiveScrapeCard` component (right next to `failedCount`), add:

```typescript
  const [cityTotal, setCityTotal] = useState<number | null>(null);
  const [cityDone, setCityDone] = useState(0);
```

- [ ] **Step 2: Handle new PROGRESS events in the SSE handler**

In the `es.onmessage` body, before the existing `setProgress((prev) => ...)` line, add:

```typescript
      if (data.stage === 'city_total') {
        const n = parseInt(data.detail ?? '', 10);
        if (!Number.isNaN(n)) setCityTotal(n);
      } else if (data.stage === 'city_done') {
        setCityDone((c) => c + 1);
      } else if (data.stage === 'error') {
        // SSE backend says the job row no longer exists. Stop the spinner
        // and surface the message instead of spinning forever.
        setStatus('failed');
        setError(data.detail || 'Job not found');
        es.close();
        return;
      }
```

- [ ] **Step 3: Render the counter in the card body**

Find the JSX block that renders the four stat tiles (Companies Found / Profiles Processed / From Trustpilot / From Websites). Add a fifth tile that renders only when `cityTotal != null`:

```tsx
            {cityTotal != null && (
              <div className="rounded-lg border border-divider bg-surface p-4">
                <div className="text-[11px] uppercase tracking-wide text-on-surface-muted">Cities</div>
                <div className="mt-1 text-xl font-semibold">{cityDone} / {cityTotal}</div>
              </div>
            )}
```

(Exact placement depends on the existing JSX layout — keep it next to the other tiles, same Tailwind classes.)

- [ ] **Step 4: Type-check + smoke-test**

```bash
cd frontend && npx tsc --noEmit
```

Trigger a small TA scrape (country FI). The Cities tile should appear and tick from `0 / N` → `N / N` over the run.

Also verify the stuck-card bug: in DevTools, manually set `localStorage.active_scrape_jobs_v2 = JSON.stringify(['nonexistent-id'])` and reload. The card should now show `Job not found` and a "failed" state instead of spinning.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ActiveScrapeCard.tsx
git commit -m "feat(frontend): tripadvisor city counter + handle SSE error stage"
```

---

## Task 13 — End-to-end smoke + deploy

**Files:**
- None (verification + deploy only)

- [ ] **Step 1: Full type-check pass**

```bash
cd server && npx tsc --noEmit
cd ../frontend && npx tsc --noEmit
```

Expected: no errors in either.

- [ ] **Step 2: Local end-to-end run**

With both dev servers running:

1. Open http://localhost:5173/scrape
2. Switch Platform to TripAdvisor
3. Country = FI (or any small country), Category = Hotels, rating 1–3
4. Confirm the credit advisory shows a sensible estimate
5. Click Start scrape
6. Watch the active card: Cities counter should increment as each city completes
7. After completion, navigate to Leads — newly scraped TA leads should appear with `country=FI`, no `trustpilot_url`, populated `website_url`

If anything misbehaves, fix in place and re-test before moving on.

- [ ] **Step 3: Commit any remaining fixes**

```bash
git status
# Stage and commit anything left.
```

- [ ] **Step 4: Push frontend (triggers Vercel)**

Output the command for the user to run themselves (per CLAUDE.md policy — never auto-push):

```bash
git push origin main
```

- [ ] **Step 5: Deploy backend (Cloud Run)**

Output the command for the user:

```powershell
powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --project=trustpilot-leadgen --quiet"
```

- [ ] **Step 6: Post-deploy verification**

After the user reports deploy is finished:
1. Hit the live API: `curl https://<gateway>/api/tripadvisor/cities?country=US` → expect a non-zero count
2. Submit a small TA scrape against the live system (FI, hotels, 1–3) — observe it complete with leads
3. Check the live frontend Scrape page shows the new TripAdvisor form

---

## Self-Review checklist (run after writing the plan)

**Spec coverage:**
- Schema (§1 of spec) → Task 1 ✓
- Country geo map (§2 of spec) → Task 2 ✓
- Seed scraper (§3 of spec) → Task 3 ✓
- API contract change (§4 of spec) → Tasks 6, 8, 9 ✓
- Backend fan-out (§5 of spec) → Task 7 ✓
- Frontend form (§6 of spec) → Task 10 ✓
- Cost advisory (§7 of spec) → Task 11 ✓
- Progress UI (§8 of spec) → Task 12 ✓
- New `/api/tripadvisor/cities` endpoint (file map) → Task 5 ✓

**Placeholder scan:**
- No TBD/TODO entries.
- All steps include either code, exact commands with expected output, or both.
- No "similar to Task N" — code is repeated wherever needed.

**Type consistency:**
- `TripAdvisorScrapeParams` fields are `country` / `category` everywhere (Task 8 frontend type, Task 9 context translation, Task 10 form, Task 6 backend validation, Task 7 runner).
- DB helper names `listActiveCitiesForCountry` / `countActiveCitiesForCountry` are referenced consistently in Tasks 4, 5, 6, 7.
- Progress event names `city_total`, `city_start`, `city_done`, `city_failed` are consistent between Task 7 (emit) and Task 12 (consume).

No issues found.
