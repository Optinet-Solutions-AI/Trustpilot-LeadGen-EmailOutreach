"""
BasePlatformScraper — contract every platform plugin must satisfy.

Phase 2 introduces this abstraction so the API layer can address any
review-platform scraper through one entry point (run.py) instead of
hard-coding spawn paths to Trustpilot-specific scripts. Adding a new
platform = subclass BasePlatformScraper + register in __init__.py.

The contract is intentionally minimal — three pipeline steps that map
1:1 onto how the API already orchestrates scrapes:

    1. scrape_listing(filters)        →  list of profile stubs
    2. enrich_profiles(profile_stubs) →  contact/website/screenshot data
    3. discover_taxonomy()            →  categories + countries/regions
                                          (only used by the taxonomy refresh
                                           endpoint; platforms without a
                                           browseable taxonomy can return {})

filter_schema is what the frontend reads to render its dynamic form. Each
field describes its own type so the same <DynamicFilterFields> component
works for every platform (Trustpilot needs country+category+rating;
TripAdvisor needs location+listing_type+rating; etc.).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable, Literal, Optional, TypedDict


class FilterField(TypedDict, total=False):
    """One input on the Scrape page form, declared by the platform."""

    name: str  # filter key (becomes scrape_jobs.filters[name])
    type: Literal['text', 'number', 'select', 'multiselect', 'boolean']
    label: str  # display label
    required: bool
    default: Any
    # For number fields:
    min: float
    max: float
    step: float
    # For select / multiselect:
    options: list[dict]  # static options: [{value, label}]
    options_source: str  # dynamic: 'taxonomy:countries' | 'taxonomy:categories' | ...


ProgressCallback = Optional[Callable[[dict], None]]


class BasePlatformScraper(ABC):
    """
    A review-platform scraper plugin. Subclasses MUST set the class-level
    metadata (name, base_url, filter_schema) and implement the two
    pipeline methods. discover_taxonomy is optional — override if the
    platform has a browseable taxonomy worth caching.
    """

    # ── Plugin metadata (override on subclass) ────────────────────────
    name: str = ''  # platform key, e.g. 'trustpilot', 'tripadvisor'
    base_url: str = ''
    filter_schema: list[FilterField] = []
    # Informational only in v1 — the orchestrator does NOT enforce this.
    # Flagged so the frontend can hint "this platform may need a proxy
    # when run from the cloud worker" and the operator can pick local mode.
    requires_proxy: bool = False

    # ── Pipeline ──────────────────────────────────────────────────────

    @abstractmethod
    async def scrape_listing(
        self,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[dict]:
        """
        Step 1 — paginate the platform's listing/category/location pages
        and return profile stubs. Each stub MUST include at minimum:

            {
                'name':        str,   # company / business name
                'profile_url': str,   # canonical platform profile URL (unique)
                'rating':      float | None,
            }

        Platform-specific fields (slug, listing_type, location_id, …) may
        be included and will be passed through to enrich_profiles.
        """
        raise NotImplementedError

    @abstractmethod
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
        """
        Step 2 — visit each profile page and enrich with contact info.
        Returned dicts should superset the input stubs and may include:

            company_name, website_url, platform_email, phone,
            screenshot_path, profile_claimed, ...

        Platforms that have nothing useful to extract beyond what the
        listing already returned may return the input unchanged.
        """
        raise NotImplementedError

    async def discover_taxonomy(self) -> dict:
        """
        Optional — re-discover the platform's category + country/region
        taxonomy. Default no-op for platforms without one. When
        implemented, return:

            {
                'categories': [{slug, parent_slug, display_name, sort_order, ...}],
                'countries':  [{code, name}],   # or 'locations' for travel platforms
            }
        """
        return {'categories': [], 'countries': []}

    # ── Metadata helper used by /api/scrape/platforms ─────────────────
    @classmethod
    def manifest(cls) -> dict:
        """Serializable plugin descriptor for the frontend platform picker."""
        return {
            'name': cls.name,
            'base_url': cls.base_url,
            'filter_schema': cls.filter_schema,
            'requires_proxy': cls.requires_proxy,
        }
