"""
Platform plugin registry.

Adding a new platform = (1) drop a new module in this directory that
subclasses BasePlatformScraper, (2) import + register it here, (3)
ensure its filter_schema has matching frontend field renderers. No
other code path needs to know it exists.

The registry is keyed by `name` (lowercase, stable) — this is what
scrape_jobs.platform stores, what the API accepts as `?platform=`,
and what `lead_platform_presences.platform` records.
"""
from __future__ import annotations

from typing import Optional, Type

from tools.scraper.platforms.base import BasePlatformScraper
from tools.scraper.platforms.trustpilot import TrustpilotScraper
from tools.scraper.platforms.tripadvisor import TripAdvisorScraper
from tools.scraper.platforms.yelp import YelpScraper
from tools.scraper.platforms.facebook import FacebookScraper

# Order here is the order the frontend's PlatformPicker dropdown shows.
PLATFORMS: dict[str, Type[BasePlatformScraper]] = {
    TrustpilotScraper.name: TrustpilotScraper,
    TripAdvisorScraper.name: TripAdvisorScraper,
    YelpScraper.name: YelpScraper,
    FacebookScraper.name: FacebookScraper,
}


def get_platform(name: str) -> BasePlatformScraper:
    """Instantiate the plugin for a given platform name."""
    cls = PLATFORMS.get(name.lower())
    if cls is None:
        known = ', '.join(sorted(PLATFORMS.keys()))
        raise ValueError(f"Unknown platform '{name}'. Known: {known}.")
    return cls()


def list_manifests() -> list[dict]:
    """Serializable list of all registered plugins — what GET /api/scrape/platforms returns."""
    return [cls.manifest() for cls in PLATFORMS.values()]


__all__ = ['PLATFORMS', 'get_platform', 'list_manifests', 'BasePlatformScraper']
