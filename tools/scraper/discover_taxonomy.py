"""
Trustpilot Taxonomy Discovery — scrapes /categories and the country selector
to enumerate every category + country Trustpilot exposes.

Idempotent. Upserts into trustpilot_categories and trustpilot_countries.
Stale slugs are NOT deleted — their last_seen_at just stops advancing.

Usage:
  python tools/scraper/discover_taxonomy.py            # full refresh + DB write
  python tools/scraper/discover_taxonomy.py --dry-run  # print results, no DB write
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.browser_utils import launch_browser, human_delay, safe_goto


CATEGORIES_INDEX_URL = "https://www.trustpilot.com/categories"

# Concurrency for the per-parent sub-page fetch. 5 is a safe trade-off between
# wall-clock time (~2 min for 211 pages) and CloudFlare rate-limit risk.
SUB_FETCH_CONCURRENCY = 5

# Trustpilot accepts any ISO 3166-1 alpha-2 code via ?country=XX even when
# there is no localized market site for it — businesses get filtered by the
# `country` field on their listing. So the picker should expose the broad
# list, not just Trustpilot's 22 localized markets. We curate this manually
# (rather than scraping a 250-code ISO dropdown) because we want a clean,
# stable list — and curating beats including obvious dead ends like
# Antarctica.
SUPPORTED_COUNTRIES: list[tuple[str, str]] = [
    # ── Europe ────────────────────────────────────────────────
    ('AT', 'Austria'), ('BE', 'Belgium'), ('BG', 'Bulgaria'),
    ('HR', 'Croatia'), ('CY', 'Cyprus'), ('CZ', 'Czech Republic'),
    ('DK', 'Denmark'), ('EE', 'Estonia'), ('FI', 'Finland'),
    ('FR', 'France'), ('DE', 'Germany'), ('GR', 'Greece'),
    ('HU', 'Hungary'), ('IS', 'Iceland'), ('IE', 'Ireland'),
    ('IT', 'Italy'), ('LV', 'Latvia'), ('LT', 'Lithuania'),
    ('LU', 'Luxembourg'), ('MT', 'Malta'), ('NL', 'Netherlands'),
    ('NO', 'Norway'), ('PL', 'Poland'), ('PT', 'Portugal'),
    ('RO', 'Romania'), ('SK', 'Slovakia'), ('SI', 'Slovenia'),
    ('ES', 'Spain'), ('SE', 'Sweden'), ('CH', 'Switzerland'),
    ('GB', 'United Kingdom'), ('UA', 'Ukraine'),
    # ── North America ────────────────────────────────────────
    ('CA', 'Canada'), ('MX', 'Mexico'), ('US', 'United States'),
    # ── Latin America & Caribbean ─────────────────────────────
    ('AR', 'Argentina'), ('BR', 'Brazil'), ('CL', 'Chile'),
    ('CO', 'Colombia'), ('CR', 'Costa Rica'), ('DO', 'Dominican Republic'),
    ('EC', 'Ecuador'), ('PA', 'Panama'), ('PE', 'Peru'),
    ('UY', 'Uruguay'), ('VE', 'Venezuela'),
    # ── Asia ─────────────────────────────────────────────────
    ('BD', 'Bangladesh'), ('CN', 'China'), ('HK', 'Hong Kong'),
    ('IN', 'India'), ('ID', 'Indonesia'), ('IL', 'Israel'),
    ('JP', 'Japan'), ('JO', 'Jordan'), ('KR', 'South Korea'),
    ('KZ', 'Kazakhstan'), ('LB', 'Lebanon'), ('MY', 'Malaysia'),
    ('PK', 'Pakistan'), ('PH', 'Philippines'), ('QA', 'Qatar'),
    ('SA', 'Saudi Arabia'), ('SG', 'Singapore'), ('LK', 'Sri Lanka'),
    ('TW', 'Taiwan'), ('TH', 'Thailand'), ('TR', 'Turkey'),
    ('AE', 'United Arab Emirates'), ('VN', 'Vietnam'),
    # ── Africa ───────────────────────────────────────────────
    ('DZ', 'Algeria'), ('EG', 'Egypt'), ('GH', 'Ghana'),
    ('KE', 'Kenya'), ('MA', 'Morocco'), ('NG', 'Nigeria'),
    ('ZA', 'South Africa'), ('TN', 'Tunisia'), ('UG', 'Uganda'),
    # ── Oceania ──────────────────────────────────────────────
    ('AU', 'Australia'), ('NZ', 'New Zealand'),
]


def slug_to_label(slug: str) -> str:
    """Synthesize a display name from a slug.

    Used as a fallback when a scraped link text is empty or noisy
    (e.g. concatenated parent + child labels from card layouts).
    """
    small = {'and', 'or', 'in', 'on', 'of', 'the', 'a', 'an', 'to', 'for', 'by'}
    words = [w for w in slug.replace('-', '_').split('_') if w]
    out: list[str] = []
    for i, w in enumerate(words):
        if i > 0 and w.lower() in small:
            out.append(w.lower())
        else:
            out.append(w[0].upper() + w[1:].lower())
    return ' '.join(out) or slug


def clean_label(scraped: str, slug: str) -> str:
    """Pick the cleanest of (scraped, slug-derived). Long or empty → fallback."""
    s = (scraped or '').strip()
    if not s or len(s) > 45:
        return slug_to_label(slug)
    return s


def _progress(stage: str, detail: str = "") -> None:
    print(f"PROGRESS:taxonomy_{stage}:{detail}", flush=True)


async def discover_top_level_categories(page) -> list[dict]:
    """Visit /categories and extract every top-level category link."""
    _progress("loading_index")
    if not await safe_goto(page, CATEGORIES_INDEX_URL):
        raise RuntimeError("Failed to load /categories index")

    await human_delay(1.5, 3.0)

    extract_js = r"""() => {
        const links = Array.from(document.querySelectorAll('a[href^="/categories/"]'));
        const seen = new Set();
        const results = [];
        for (const link of links) {
            const href = link.getAttribute('href') || '';
            const m = href.match(/^\/categories\/([^\/?#]+)/);
            if (!m) continue;
            const slug = m[1];
            if (seen.has(slug)) continue;
            seen.add(slug);
            const text = (link.textContent || '').trim();
            if (!text || text.length > 80) continue;
            results.push({ slug, display_name: text });
        }
        return results;
    }"""

    items = await page.evaluate(extract_js)
    _progress("top_level_done", str(len(items)))
    return items


def supported_countries() -> list[dict]:
    """Return the curated list of countries the picker exposes.

    See SUPPORTED_COUNTRIES for why we hardcode this instead of scraping
    Trustpilot's country dropdown.
    """
    _progress("countries_done", str(len(SUPPORTED_COUNTRIES)))
    return [{'code': c, 'name': n} for c, n in SUPPORTED_COUNTRIES]


_SUBCATS_JS = r"""(parentSlug) => {
    const links = Array.from(document.querySelectorAll('a[href^="/categories/"]'));
    const seen = new Set();
    const results = [];
    for (const link of links) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/^\/categories\/([^\/?#]+)/);
        if (!m) continue;
        const slug = m[1];
        if (slug === parentSlug) continue;
        if (seen.has(slug)) continue;
        seen.add(slug);
        // Prefer a heading-ish child element over the full link textContent,
        // which often concatenates child label + parent crumb on card layouts.
        const heading = link.querySelector('h3, h4, [class*="title"], [class*="name"], [class*="label"]');
        const raw = (heading?.textContent || link.textContent || '').trim();
        // Collapse internal whitespace + split at clear breaks so labels like
        // "Adult EntertainmentEvents & Entertainment" reduce to "Adult Entertainment".
        const tidied = raw.replace(/\s+/g, ' ').split(/(?<=[a-z])(?=[A-Z][a-z]{2,})/)[0];
        if (!tidied) continue;
        results.push({ slug, display_name: tidied });
    }
    return results;
}"""


async def discover_subcategories(context, parent_slug: str) -> list[dict]:
    """Open a new page, fetch /categories/{parent_slug}, extract sub-slugs."""
    page = await context.new_page()
    try:
        url = f"https://www.trustpilot.com/categories/{parent_slug}"
        if not await safe_goto(page, url):
            return []
        await human_delay(0.5, 1.5)
        return await page.evaluate(_SUBCATS_JS, parent_slug)
    except Exception as e:
        print(f"  Sub-fetch failed for /{parent_slug}: {e}")
        return []
    finally:
        try:
            await page.close()
        except Exception:
            pass


async def fan_out_subcategories(context, parent_slugs: list[str]) -> list[dict]:
    """Visit every parent page in parallel batches; merge unique sub-slugs."""
    sem = asyncio.Semaphore(SUB_FETCH_CONCURRENCY)
    done = 0
    total = len(parent_slugs)
    collected: list[tuple[str, str, str]] = []  # (slug, display_name, parent_slug)

    async def one(slug: str) -> None:
        nonlocal done
        async with sem:
            subs = await discover_subcategories(context, slug)
            for s in subs:
                collected.append((s['slug'], s['display_name'], slug))
        done += 1
        # Throttle progress events to roughly every ~5%.
        if done == 1 or done == total or done % max(1, total // 20) == 0:
            _progress("expand_progress", f"{done}/{total}")

    await asyncio.gather(*(one(slug) for slug in parent_slugs))
    return [{'slug': s, 'display_name': d, 'parent_slug': p} for s, d, p in collected]


def _upsert_supabase(categories: list[dict], countries: list[dict]) -> None:
    """Bulk-upsert via PostgREST. Imported lazily so --dry-run works without creds."""
    from tools.db.supabase_client import get_client

    client = get_client()
    now_iso = datetime.now(timezone.utc).isoformat()

    if categories:
        _progress("saving_categories", str(len(categories)))
        rows = [
            {
                'slug': c['slug'],
                'parent_slug': c['parent_slug'],
                'display_name': c['display_name'],
                'sort_order': i,
                'last_seen_at': now_iso,
            }
            for i, c in enumerate(categories)
        ]
        client.from_('trustpilot_categories').upsert(rows, on_conflict='slug').execute()

    if countries:
        _progress("saving_countries", str(len(countries)))
        client.from_('trustpilot_countries').upsert(
            [{'code': c['code'], 'name': c['name'], 'last_seen_at': now_iso} for c in countries],
            on_conflict='code',
        ).execute()


async def run_discovery(dry_run: bool = False) -> dict:
    browser, context, page = await launch_browser()
    categories: list[dict] = []
    countries: list[dict] = []

    try:
        # Phase 1 — /categories index gives us the high-level nav grid
        # (~211 slugs). This includes top-level categories like `gambling`
        # and featured sub-categories like `casino` — but NOT every leaf,
        # because Trustpilot's index page is curated.
        discovered = await discover_top_level_categories(page)
        index_slugs = []
        seen: set[str] = set()
        for d in discovered:
            if d['slug'] in seen:
                continue
            seen.add(d['slug'])
            index_slugs.append(d['slug'])
            categories.append({
                'slug': d['slug'],
                'parent_slug': None,
                'display_name': clean_label(d['display_name'], d['slug']),
            })

        # Phase 2 — fan out to each /categories/{slug} page in parallel and
        # harvest the subcategory chips. This picks up leaf slugs like
        # `bingo_hall`, `online_casino_or_bookmaker`, etc. that are NOT on
        # the index. ~211 pages at concurrency 5 = ~2 min wall time.
        _progress("expand_start", str(len(index_slugs)))
        subs = await fan_out_subcategories(context, index_slugs)
        for s in subs:
            if s['slug'] in seen:
                continue
            seen.add(s['slug'])
            categories.append({
                'slug': s['slug'],
                'parent_slug': None,
                'display_name': clean_label(s['display_name'], s['slug']),
            })
        _progress("expand_done", str(len(categories)))

        countries = supported_countries()
    finally:
        await browser.close()

    summary = {'categories': len(categories), 'countries': len(countries)}
    print(f"\nDiscovered {summary['categories']} categories, {summary['countries']} countries.")

    if dry_run:
        print(json.dumps({
            'categories_sample': categories[:10],
            'countries_sample': countries[:10],
            'total_categories': len(categories),
            'total_countries': len(countries),
        }, indent=2, ensure_ascii=False))
        _progress("dry_run_done", f"{summary['categories']}|{summary['countries']}")
        return summary

    _upsert_supabase(categories, countries)
    _progress("done", f"{summary['categories']}|{summary['countries']}")
    return summary


def main():
    parser = argparse.ArgumentParser(description='Discover the full Trustpilot taxonomy.')
    parser.add_argument('--dry-run', action='store_true', help='Parse + print, do not write to DB')
    args = parser.parse_args()

    try:
        asyncio.run(run_discovery(dry_run=args.dry_run))
    except Exception as e:
        print(f"PROGRESS:taxonomy_error:{e}", flush=True)
        raise


if __name__ == '__main__':
    main()
