"""Report what a scrape spent, in a line the runner can parse.

TripAdvisor and Yelp are the two platforms that cannot be scraped for free.
Every run spends ScrapingBee credits, Apify items or OpenAI calls, and until
now none of it surfaced in the app — the only way to learn what a run cost was
to open the vendor's console afterwards. That is how a Spanish TripAdvisor run
burned 101,595 ScrapingBee credits against a 1,000 allowance on 2026-09-24 and
still reported "completed, 0 found".

Every paid path prints:

    COST:{platform}|{vendor}|{usd}|{units}|{unit_label}

`usd` is left EMPTY rather than guessed when only the native unit is known.
A blank field is honest; a made-up dollar figure would be quoted back as fact.
"""
from __future__ import annotations

import os
from typing import Optional

# Public list price, USD per ScrapingBee credit, overridable because it
# depends entirely on the plan. Left unset by default: printing an invented
# dollar amount is worse than printing the credits alone.
_SCRAPINGBEE_USD_PER_CREDIT = os.environ.get('SCRAPINGBEE_USD_PER_CREDIT', '').strip()


# Set once by run.py so the deep call sites (a ScrapingBee fetch three layers
# down) do not each have to be handed the platform name.
_PLATFORM = 'unknown'


def set_cost_platform(platform: str) -> None:
    global _PLATFORM
    _PLATFORM = (platform or 'unknown').strip() or 'unknown'


def current_platform() -> str:
    return _PLATFORM


def report_cost(
    platform: Optional[str],
    vendor: str,
    *,
    units: float,
    unit_label: str,
    usd: Optional[float] = None,
) -> None:
    """Print one unit of spend. Never raises — reporting must not break a run."""
    try:
        amount = '' if usd is None else f'{max(0.0, float(usd)):.6f}'
        print(
            f'COST:{platform or _PLATFORM}|{vendor}|{amount}|{units:g}|{unit_label}',
            flush=True,
        )
    except Exception:
        pass


def report_scrapingbee(platform: Optional[str], credits: float, pages: int = 1) -> None:
    """ScrapingBee spend, in credits — and in USD only if a rate is configured."""
    usd: Optional[float] = None
    if _SCRAPINGBEE_USD_PER_CREDIT:
        try:
            usd = float(_SCRAPINGBEE_USD_PER_CREDIT) * float(credits)
        except ValueError:
            usd = None
    report_cost(platform, 'scrapingbee', units=credits, unit_label='credits', usd=usd)


def report_apify(platform: Optional[str], items: int, usd_per_item: float) -> None:
    """Apify spend. The per-item rate is known from the actor's listing."""
    report_cost(platform, 'apify', units=items, unit_label='items',
                usd=items * usd_per_item)


def report_openai(platform: Optional[str], usd: float, leads: int) -> None:
    """OpenAI spend, exact — the API reports token usage on every call."""
    report_cost(platform, 'openai', units=leads, unit_label='leads', usd=usd)
