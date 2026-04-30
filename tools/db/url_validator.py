"""URL sanitization + validation for Trustpilot lead ingestion.

Two responsibilities:

1. ``sanitize_trustpilot_url`` — repairs malformed URLs that the scraper
   sometimes emits (duplicate ``http://https://`` prefixes, smart quotes,
   stray whitespace, backslashes, missing scheme, query-string noise).

2. ``validate_trustpilot_url`` — fetches the cleaned URL and returns one of
   ``VALID`` / ``FLAGGED_DEAD`` / ``FLAGGED_REMOVED`` / ``UNKNOWN``. Detects
   both hard 404s and Trustpilot soft-404s ("this profile has been removed").

Designed to be called from ``upsert_leads.py`` *before* the row is sent to
Supabase, so the DB only ever sees canonical URLs and an honest link_status.
"""
from __future__ import annotations

import re
from typing import Tuple
from urllib.parse import urlparse, urlunparse

import requests

# Soft-404 markers Trustpilot serves with HTTP 200 when a /review/<slug>
# profile has been delisted, the slug never existed, or the company was
# removed. Lower-cased for case-insensitive matching.
SOFT_404_MARKERS: tuple[str, ...] = (
    "this profile has been removed",
    "this page does not exist",
    "page not found",
    "we could not find",
    "we couldn't find",
    "sorry, we couldn",
    "couldn't find the page",
)

# Realistic browser headers — Trustpilot returns a 403 challenge page when
# requested with the default ``python-requests/x.y.z`` user-agent.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}

_DUPLICATE_SCHEME = re.compile(r"^(https?:[/\\]+){2,}", re.IGNORECASE)
_SCHEME_PRESENT = re.compile(r"^https?://", re.IGNORECASE)
_REPEATED_SLASHES = re.compile(r"(?<!:)/{2,}")
_QUOTE_CHARS = "“”‘’\"'"


def sanitize_trustpilot_url(url: str | None) -> str | None:
    """Return a canonical Trustpilot URL, or ``None`` if it can't be salvaged.

    Fixes (in order):
      - strips wrapping whitespace and smart/curly quotes
      - converts backslashes to forward slashes
      - removes internal whitespace (``http: //example.com``)
      - collapses duplicate schemes (``http://https://example.com``)
      - prepends ``https://`` when no scheme is present
      - drops query strings + fragments (Trustpilot review pages don't need them)
      - lowercases the host, normalizes repeated slashes in the path
      - removes a single trailing slash
    """
    if not url:
        return None

    s = str(url).strip().strip(_QUOTE_CHARS).replace("\\", "/")
    s = re.sub(r"\s+", "", s)
    if not s:
        return None

    s = _DUPLICATE_SCHEME.sub("https://", s)
    if not _SCHEME_PRESENT.match(s):
        s = "https://" + s.lstrip("/")

    try:
        parsed = urlparse(s)
    except ValueError:
        return None
    if not parsed.netloc:
        return None

    netloc = parsed.netloc.lower()
    path = _REPEATED_SLASHES.sub("/", parsed.path or "/")
    cleaned = urlunparse((parsed.scheme.lower(), netloc, path, "", "", ""))
    return cleaned.rstrip("/") or None


def validate_trustpilot_url(
    url: str,
    timeout: float = 10.0,
    session: requests.Session | None = None,
) -> Tuple[str, str | None]:
    """Fetch ``url`` and classify its current state.

    Returns ``(link_status, error_message)``:
      - ``("VALID", None)``                   — 2xx/3xx and no soft-404 marker
      - ``("FLAGGED_DEAD", "http_404")``      — hard 4xx
      - ``("FLAGGED_REMOVED", "soft_404...")``— 200 OK but DOM says "removed"
      - ``("UNKNOWN", "request_failed: ...")``— network error or 5xx

    The caller is responsible for throttling — this function does no sleeping.
    """
    if not url:
        return "UNKNOWN", "empty_url"

    http = session or requests
    try:
        resp = http.get(
            url,
            headers=DEFAULT_HEADERS,
            timeout=timeout,
            allow_redirects=True,
        )
    except requests.RequestException as e:
        return "UNKNOWN", f"request_failed: {type(e).__name__}"

    status = resp.status_code
    if status == 404 or status == 410:
        return "FLAGGED_DEAD", f"http_{status}"
    if status >= 500:
        return "UNKNOWN", f"http_{status}"
    if status >= 400:
        return "FLAGGED_DEAD", f"http_{status}"

    body = (resp.text or "").lower()
    for marker in SOFT_404_MARKERS:
        if marker in body:
            return "FLAGGED_REMOVED", f"soft_404: {marker}"
    return "VALID", None
