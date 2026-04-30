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
    # Trustpilot's exact "removed profile" page copy. Their page is JS-rendered,
    # so unless we proxy through ScrapingBee with render_js the body the
    # validator sees is the empty SPA shell and these never match.
    "this profile has been removed",
    "no longer visible on trustpilot",
    "goes against our guidelines",
    "why trustpilot removes profiles",
    # Generic "page gone" markers.
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


# Cloudflare interstitials show up as 200 OK with these phrases in the body.
# Trustpilot occasionally serves them when bot-management decides we look fishy.
CLOUDFLARE_CHALLENGE_MARKERS: tuple[str, ...] = (
    "just a moment",
    "checking your browser",
    "cf-browser-verification",
    "cf-challenge",
    "attention required! | cloudflare",
    "enable javascript and cookies to continue",
)


def validate_trustpilot_url(
    url: str,
    timeout: float = 10.0,
    session: requests.Session | None = None,
) -> Tuple[str, str | None]:
    """Fetch ``url`` and classify its current state.

    Returns ``(link_status, error_message)``:
      - ``("VALID", None)``                            — 2xx/3xx, no challenge, no soft-404
      - ``("FLAGGED_DEAD", "http_404")``               — 404/410 (proven gone)
      - ``("FLAGGED_REMOVED", "soft_404: ...")``       — 200 OK with "profile removed" copy
      - ``("UNKNOWN", "http_403_likely_bot_block")``   — Cloudflare/anti-bot
      - ``("UNKNOWN", "request_failed: ...")``         — network error/timeout
      - ``("UNKNOWN", "cloudflare_challenge: ...")``   — 200 OK but we got the challenge page

    Trustpilot is Cloudflare-protected; from a Cloud Run egress IP we'll hit
    bot-management often. Mapping every 4xx to FLAGGED_DEAD produced false
    positives, so the new policy is: only 404/410 mean dead, the rest are
    inconclusive.
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

    # Proven-dead signals.
    if status in (404, 410):
        return "FLAGGED_DEAD", f"http_{status}"

    # Anti-bot / rate-limit. Page may be live, we just couldn't see it.
    if status in (401, 403, 429, 451):
        return "UNKNOWN", f"http_{status}_likely_bot_block"

    # All other 4xx and 5xx — inconclusive.
    if status >= 400:
        return "UNKNOWN", f"http_{status}"

    body = (resp.text or "").lower()

    # Soft-404 markers FIRST — a confirmed "this profile has been removed"
    # signal is authoritative; we don't want a stray Cloudflare-ish footer
    # string to override it.
    for marker in SOFT_404_MARKERS:
        if marker in body:
            return "FLAGGED_REMOVED", f"soft_404: {marker}"

    # Cloudflare interstitial check — only reached when no removal marker hit.
    for marker in CLOUDFLARE_CHALLENGE_MARKERS:
        if marker in body:
            return "UNKNOWN", f"cloudflare_challenge: {marker}"

    return "VALID", None
