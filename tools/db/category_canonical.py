"""Canonical lead-category map — the single source of truth.

Why this exists
---------------
Every scraping platform writes its own taxonomy string into `leads.category`.
Trustpilot writes its category slug, Yelp writes its *search* slug
("plumbers"), Facebook writes whatever niche the operator typed ("plumber").
Nothing normalised them, so the live table holds 60 distinct values in which
several are the same trade spelled three different ways — and a filter for one
spelling silently misses the others:

    plumber (4) + plumbers (39) + plumbing (66)   → one trade, three labels
    electrician (80) + electricians (78)          → one trade, two labels

Scope discipline (read before adding anything)
---------------------------------------------
Only *morphological* variants of the SAME trade are grouped here:

  * singular vs plural           electrician / electricians
  * agent noun vs activity noun  plumber / plumbing, roofer / roofing
  * separator / spelling variant autorepair / auto_repair

Anything that needs a business judgement to merge is deliberately NOT grouped.
See DELIBERATELY_UNMERGED below — it is enforced by a test, so a future
"obvious" merge of the gambling cluster cannot happen by accident.

Canonical-form convention
-------------------------
1. lowercase snake_case, always.
2. For a *trade* (something a person does), the canonical form is the singular
   **agent noun** — the business, not the activity: `plumber` not `plumbing`,
   `roofer` not `roofing`, `electrician` not `electricians`. Rationale: the
   CRM's unit is a business, and the agent noun is what an operator types when
   naming who they want to reach (the Facebook scraper literally stores
   `filters.niche = "plumber"`).
3. For a *sector slug* that has no natural one-word agent noun (`hvac`,
   `autorepair`, `car_dealer`, `utilities`, `game_store`), the platform's own
   established form stays canonical and the variants hang off it as aliases.
   Those families therefore cost the backfill zero row rewrites — they exist
   purely so the filter and future writes converge.

Mirror
------
The TypeScript mirror lives at server/src/services/lead-categories.ts. Both
sides carry a drift test that parses the *other* file and fails loudly if the
two maps diverge, so the duplication cannot rot silently.

Public API
----------
    slugify_category(value)     -> lowercase snake_case slug (or None)
    canonicalize_category(value)-> canonical form; unknown values pass through
    category_family(value)      -> every label in the value's family
    category_filter_patterns(v) -> minimal substring needles for a LIKE filter
"""
from __future__ import annotations

import re

# ─────────────────────────────────────────────────────────────────────────────
# THE MAP.  canonical -> every label that means the same trade.
#
# Keep ONE family per line: the drift tests on both sides parse this block
# line-by-line, and a multi-line tuple will not be seen.
# The canonical form must itself appear in its own alias tuple.
# ─────────────────────────────────────────────────────────────────────────────
CANONICAL_FAMILIES: dict[str, tuple[str, ...]] = {
    # ── Trades: canonical is the singular agent noun (rule 2) ──
    "plumber": ("plumber", "plumbers", "plumbing", "plumbing_service", "plumbing_services"),
    "electrician": ("electrician", "electricians", "electrical", "electrical_service", "electrical_services"),
    "roofer": ("roofer", "roofers", "roofing", "roofing_service", "roofing_services"),
    "landscaper": ("landscaper", "landscapers", "landscaping", "landscaping_service", "landscaping_services"),
    "handyman": ("handyman", "handymen", "handyman_service", "handyman_services"),
    "locksmith": ("locksmith", "locksmiths"),
    "chiropractor": ("chiropractor", "chiropractors"),
    "lawyer": ("lawyer", "lawyers"),
    "contractor": ("contractor", "contractors"),
    # ── Business kinds: canonical is the singular noun (rule 2) ──
    "restaurant": ("restaurant", "restaurants"),
    "hotel": ("hotel", "hotels"),
    "gym": ("gym", "gyms"),
    "clinic": ("clinic", "clinics"),
    # ── Sector slugs: platform's own form stays canonical (rule 3) ──
    "hvac": ("hvac", "hvac_service", "hvac_services"),
    "autorepair": ("autorepair", "autorepairs", "auto_repair", "auto_repairs", "auto_repair_shop"),
    "car_dealer": ("car_dealer", "car_dealers", "car_dealership", "car_dealerships"),
    "game_store": ("game_store", "game_stores"),
    "video_game_store": ("video_game_store", "video_game_stores"),
    "clothing_store": ("clothing_store", "clothing_stores"),
    "event_venue": ("event_venue", "event_venues"),
    "wedding_venue": ("wedding_venue", "wedding_venues"),
    "utilities": ("utilities", "utility"),
}

# ─────────────────────────────────────────────────────────────────────────────
# Values that LOOK mergeable and are deliberately left fragmented, with the
# reason. A test asserts every label listed here canonicalises to ITSELF, so
# nobody can quietly fold them into a family later.
# ─────────────────────────────────────────────────────────────────────────────
DELIBERATELY_UNMERGED: dict[str, tuple[str, ...]] = {
    # A land-based casino, an online bookmaker, a bingo hall and a "gambling
    # instructor" are different businesses with different buying triggers.
    # 3,000+ rows and the bulk of live outreach sit here — merging on a guess
    # is a commercial decision, not a normalisation.
    "gambling_cluster": (
        "casino", "gambling", "gambling_service", "gambling_house",
        "online_casino_or_bookmaker", "betting_agency", "bingo_hall",
        "online_sports_betting", "bookmaker", "gambling_instructor",
        "gaming", "gaming_service_provider",
    ),
    # Same reasoning, one step removed: a corner shop that sells scratchcards
    # is not an online lottery ticket vendor.
    "lottery_cluster": (
        "lottery_vendor", "lottery_retailer", "lottery_shop",
        "online_lottery_ticket_vendor",
    ),
    # Composite platform labels. "bars_cafes" and "restaurants_bars" overlap
    # but neither contains the other, and folding either into `restaurant`
    # would silently re-label cafés and bars.
    "hospitality_composites": ("bars_cafes", "restaurants_bars"),
    # A dental practice, a physio clinic and a beauty salon are not one
    # audience. `clinics` -> `clinic` is normalised (same word); these are not
    # folded into it.
    "health_beauty_composites": ("clinic", "dental_services", "salons_clinics", "wellness_spa"),
    # "repair_services" is generic (phones, appliances, anything);
    # "autorepair" is a specific trade. Merging would pull the wrong leads
    # into a car-trade campaign.
    "repair_composites": ("repair_services",),
    # Contractors + consultants is a composite that includes consultants,
    # so it is not a spelling variant of `contractors`.
    "contractor_composites": ("contractors_consultants",),
    # A shop selling board games is not a shop selling video games, and
    # neither is a general electronics retailer — all three are distinct
    # categories on the source platform. Each is normalised for plurals on its
    # own; they are never folded together.
    "retail_lookalikes": ("game_store", "video_game_store", "electronics_technology", "shopping_fashion"),
    # Event *company* vs event *venue* vs entertainment sector: different
    # businesses; `event_venue` is normalised on its own (plural only).
    "event_composites": ("event_management_company", "events_entertainment", "amusement_center", "theater_opera"),
}

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def _build_alias_index() -> dict[str, str]:
    """Flatten CANONICAL_FAMILIES into alias -> canonical, rejecting overlaps.

    An alias that appears in two families would make canonicalisation depend
    on dict ordering, so we fail at import time rather than ship a coin flip.
    """
    index: dict[str, str] = {}
    for canonical, aliases in CANONICAL_FAMILIES.items():
        if canonical not in aliases:
            raise ValueError(
                f"category family '{canonical}' does not list its own canonical form as an alias"
            )
        for alias in aliases:
            if alias in index and index[alias] != canonical:
                raise ValueError(
                    f"category alias '{alias}' is claimed by both "
                    f"'{index[alias]}' and '{canonical}'"
                )
            index[alias] = canonical
    return index


ALIAS_TO_CANONICAL: dict[str, str] = _build_alias_index()


def slugify_category(value: str | None) -> str | None:
    """Lowercase snake_case a raw category string.

    Every one of the 60 values live in the DB today is already a lowercase
    snake_case slug, so this is a no-op on existing data. It only bites on
    operator free-text ("Pool Cleaning" -> "pool_cleaning"), which is exactly
    the new fragmentation we want to stop at the door.
    """
    if value is None:
        return None
    slug = _SLUG_STRIP.sub("_", str(value).strip().lower()).strip("_")
    return slug or None


def canonicalize_category(value: str | None) -> str | None:
    """Return the canonical label for `value`.

    Known family member -> the family's canonical form.
    Anything else       -> the slugified value, unchanged in meaning. We do NOT
                           guess: an unrecognised category keeps its identity.
    """
    slug = slugify_category(value)
    if slug is None:
        return None
    return ALIAS_TO_CANONICAL.get(slug, slug)


def category_family(value: str | None) -> list[str]:
    """Every label that means the same thing as `value`, canonical first.

    For a value with no family this is just `[canonical]` — so callers can
    always treat the result as "the set of DB labels to match".
    """
    canonical = canonicalize_category(value)
    if canonical is None:
        return []
    aliases = CANONICAL_FAMILIES.get(canonical)
    if not aliases:
        return [canonical]
    rest = sorted(a for a in aliases if a != canonical)
    return [canonical, *rest]


def category_filter_patterns(value: str | None) -> list[str]:
    """Minimal set of substring needles for a case-insensitive LIKE filter.

    A needle is dropped when another needle is a substring of it, because
    `%plumbing%` already matches everything `%plumbing_services%` would.
    That keeps the generated `or=(...)` short — the filter runs against a
    13k-row table through a URL-length-limited REST API.

    Substring (rather than equality) matching is kept on purpose: the Lead
    Matrix has always let the operator type a partial category ("plumb",
    "dentis") and still see matches.
    """
    members = category_family(value)
    if not members:
        return []
    unique = sorted(set(members))
    minimal = [
        m for m in unique
        if not any(other != m and other in m for other in unique)
    ]
    return sorted(minimal)
