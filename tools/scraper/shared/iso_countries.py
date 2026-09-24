"""ISO-3166-1 alpha-2 → display name, shared by every platform plugin.

Lived inline in tripadvisor.py until the Booking plugin needed the same map:
Booking's actor takes a human "City, Country" string, while the Scrape form's
country picker speaks ISO codes, so something has to translate. Duplicating
the table would have meant two lists drifting apart, and importing it from
tripadvisor.py would have dragged that module's ScrapingBee and browser
imports into a plugin that needs neither.

Covers every country code seeded in tripadvisor_cities and
yelp_country_cities.json, plus a generous tail of additional markets so
expanding a seed list stays a data edit rather than a code edit.
"""
from __future__ import annotations

ISO_COUNTRY_NAMES: dict[str, str] = {
    'AE': 'United Arab Emirates', 'AR': 'Argentina', 'AT': 'Austria', 'AU': 'Australia',
    'BE': 'Belgium', 'BG': 'Bulgaria', 'BR': 'Brazil', 'CA': 'Canada', 'CH': 'Switzerland',
    'CL': 'Chile', 'CN': 'China', 'CO': 'Colombia', 'CR': 'Costa Rica', 'CY': 'Cyprus',
    'CZ': 'Czech Republic', 'DE': 'Germany', 'DK': 'Denmark', 'EE': 'Estonia', 'EG': 'Egypt',
    'ES': 'Spain', 'FI': 'Finland', 'FR': 'France', 'GB': 'United Kingdom', 'UK': 'United Kingdom',
    'GR': 'Greece', 'HK': 'Hong Kong', 'HR': 'Croatia', 'HU': 'Hungary', 'ID': 'Indonesia',
    'IE': 'Ireland', 'IL': 'Israel', 'IN': 'India', 'IS': 'Iceland', 'IT': 'Italy',
    'JP': 'Japan', 'KR': 'South Korea', 'LT': 'Lithuania', 'LU': 'Luxembourg', 'LV': 'Latvia',
    'MT': 'Malta', 'MX': 'Mexico', 'MY': 'Malaysia', 'NL': 'Netherlands', 'NO': 'Norway',
    'NZ': 'New Zealand', 'PE': 'Peru', 'PH': 'Philippines', 'PL': 'Poland', 'PT': 'Portugal',
    'RO': 'Romania', 'RU': 'Russia', 'SA': 'Saudi Arabia', 'SE': 'Sweden', 'SG': 'Singapore',
    'SI': 'Slovenia', 'SK': 'Slovakia', 'TH': 'Thailand', 'TR': 'Turkey', 'TW': 'Taiwan',
    'UA': 'Ukraine', 'US': 'United States', 'VN': 'Vietnam', 'ZA': 'South Africa',
    'BH': 'Bahrain', 'DO': 'Dominican Republic', 'JO': 'Jordan', 'MA': 'Morocco',
    'OM': 'Oman', 'QA': 'Qatar',
}


def country_name(code: str | None) -> str:
    """Display name for an ISO code; unknown codes fall back to the code itself."""
    text = str(code or '').strip().upper()
    return ISO_COUNTRY_NAMES.get(text, text)
