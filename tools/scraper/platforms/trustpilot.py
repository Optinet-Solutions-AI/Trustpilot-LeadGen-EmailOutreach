"""
Trustpilot platform plugin.

Phase 2 wraps — does not rewrite — the existing scrape_category.py,
scrape_profile.py, and discover_taxonomy.py modules. The legacy CLI
scripts continue to work; this plugin is the new entry point that
run.py and the API layer call through. When the legacy spawn paths
are retired (Phase 3+), no Trustpilot extraction logic moves: the
implementation already lives in the modules this plugin imports.
"""
from __future__ import annotations

from typing import Optional

from tools.scraper.platforms.base import (
    BasePlatformScraper,
    FilterField,
    ProgressCallback,
)
from tools.scraper.scrape_category import scrape_category as _scrape_category
from tools.scraper.scrape_profile import scrape_profiles as _scrape_profiles


class TrustpilotScraper(BasePlatformScraper):
    name = 'trustpilot'
    base_url = 'https://www.trustpilot.com'
    requires_proxy = False

    filter_schema: list[FilterField] = [
        {
            'name': 'country',
            'type': 'select',
            'label': 'Country',
            'required': True,
            'options_source': 'taxonomy:countries',
        },
        {
            'name': 'category',
            'type': 'select',
            'label': 'Category',
            'required': True,
            'options_source': 'taxonomy:categories',
        },
        {
            'name': 'min_rating',
            'type': 'number',
            'label': 'Min rating',
            'required': False,
            'default': 1.0,
            'min': 1.0,
            'max': 5.0,
            'step': 0.1,
        },
        {
            'name': 'max_rating',
            'type': 'number',
            'label': 'Max rating',
            'required': False,
            'default': 3.5,
            'min': 1.0,
            'max': 5.0,
            'step': 0.1,
        },
    ]

    async def scrape_listing(
        self,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        # Delegate to the existing implementation; normalize the output to
        # the plugin contract (every stub carries `profile_url`).
        results = await _scrape_category(
            country=filters['country'],
            category=filters['category'],
            min_rating=float(filters.get('min_rating', 1.0)),
            max_rating=float(filters.get('max_rating', 3.5)),
            max_pages=int(filters.get('max_pages', 50)),
            progress_callback=on_progress,
        )

        # The legacy function returns {name, slug, rating, trustpilot_url, country, category}.
        # Add `profile_url` as the platform-agnostic alias the contract expects;
        # keep `trustpilot_url` so the existing downstream code paths
        # (upsert_leads.py, screenshots, frontend) keep working unchanged.
        for r in results:
            if 'trustpilot_url' in r and 'profile_url' not in r:
                r['profile_url'] = r['trustpilot_url']
            # Annotate every row with the platform name so multi-platform
            # consumers (run.py, scrape-runner) don't have to guess.
            r['platform'] = self.name

        if max_results is not None:
            results = results[:max_results]
        return results

    async def enrich_profiles(
        self,
        profile_stubs: list[dict],
        *,
        screenshots_dir: str = '',
        parallel_tabs: int = 3,
        output_path: str = '',
        flush_every: int = 25,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        enriched = await _scrape_profiles(
            profile_stubs,
            screenshots_dir=screenshots_dir,
            parallel_tabs=parallel_tabs,
            progress_callback=on_progress,
            output_path=output_path,
            flush_every=flush_every,
        )

        # Normalize: every enriched row gets `platform_email` (contract
        # field) mirrored from the trustpilot-specific `trustpilot_email`
        # column the existing extractor writes.
        for r in enriched:
            if 'trustpilot_email' in r and 'platform_email' not in r:
                r['platform_email'] = r['trustpilot_email']
            if 'platform' not in r:
                r['platform'] = self.name
        return enriched

    async def discover_taxonomy(self) -> dict:
        # run_discovery() upserts the discovered taxonomy into
        # platform_categories / platform_countries directly (see
        # tools/scraper/discover_taxonomy.py:_upsert_supabase). It returns
        # a count summary, not the full payload — consumers read the DB
        # after this returns.
        from tools.scraper.discover_taxonomy import run_discovery

        return await run_discovery(dry_run=False)
