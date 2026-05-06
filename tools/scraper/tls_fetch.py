"""
Tier 1.5 — Chrome-TLS-fingerprint HTTP fetch (curl_cffi).

Purpose:
  Cloudflare's first line of bot detection inspects the TLS ClientHello
  (JA3/JA4 fingerprint). Node's stock https.get and Python's stock requests
  both expose fingerprints that Cloudflare flags instantly. curl_cffi wraps
  libcurl-impersonate to send a TLS handshake byte-identical to real Chrome,
  which clears ~40-60% of Cloudflare-protected sites without launching a
  browser or paying a proxy provider.

Usage:
  python tls_fetch.py --url https://example.com --paths /,/contact,/about
  python tls_fetch.py --url https://example.com --paths / --timeout 8

Output:
  Single JSON object on stdout:
    {
      "probes": [
        {"url": "...", "status": 200, "html": "...", "blockReason": null,
         "elapsedMs": 1234},
        ...
      ],
      "error": null
    }

  Each probe's html is omitted if blockReason is set (CF challenge or 4xx/5xx)
  to keep stdout small. Caller decides whether to retry via a heavier tier.

Exit codes:
  0 — ran to completion (individual probes may still have failed)
  1 — fatal error before any probe ran (bad args, curl_cffi missing, etc.)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

try:
    from curl_cffi import requests as curl_requests
except ImportError as e:
    sys.stdout.write(json.dumps({
        "probes": [],
        "error": f"curl_cffi_not_installed: {e}. Run: pip install curl_cffi",
    }))
    sys.exit(1)

# Cloudflare interstitial markers — same set used by popup-handler.ts and the
# tier5 ScrapingBee HTML scanner. Kept in sync deliberately.
CF_MARKERS = (
    "just a moment",
    "checking your browser",
    "cf-browser-verification",
    "attention required",
    "enable javascript and cookies",
    "ddos protection by cloudflare",
)

# Browser fingerprints curl_cffi can impersonate. chrome131 is the newest
# stable signature as of curl-impersonate v1.1+. Falls back to chrome120 if
# unavailable in the installed wheel.
PREFERRED_IMPERSONATE = ("chrome131", "chrome124", "chrome120", "chrome116")


def pick_impersonate() -> str:
    """Find the newest Chrome fingerprint actually available in this curl_cffi build."""
    try:
        from curl_cffi.requests import BrowserType
        available = {bt.value for bt in BrowserType}
    except Exception:
        # If introspection fails, fall back to a known-good tag and let curl_cffi error out
        return "chrome120"
    for tag in PREFERRED_IMPERSONATE:
        if tag in available:
            return tag
    return "chrome120"


def looks_cloudflare_blocked(html: str) -> bool:
    if not html:
        return False
    lower = html.lower()
    return any(marker in lower for marker in CF_MARKERS)


def fetch_one(session: Any, target: str, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    try:
        resp = session.get(
            target,
            timeout=timeout,
            allow_redirects=True,
            # Don't bother decompressing massive responses — we cap the body below
            stream=False,
        )
    except Exception as e:
        return {
            "url": target,
            "status": 0,
            "blockReason": f"transport_error:{type(e).__name__}",
            "elapsedMs": int((time.monotonic() - started) * 1000),
        }

    elapsed_ms = int((time.monotonic() - started) * 1000)
    status = getattr(resp, "status_code", 0)
    # Cap body at 2MB — any contact email worth scraping appears in the first
    # chunk of HTML, not in a 5MB SPA bundle. Bigger payloads slow stdout
    # serialization and risk blowing the Node IPC buffer.
    raw_text = resp.text or ""
    if len(raw_text) > 2_000_000:
        raw_text = raw_text[:2_000_000]

    if status >= 400:
        return {
            "url": target,
            "status": status,
            "blockReason": f"http_{status}",
            "elapsedMs": elapsed_ms,
        }
    if looks_cloudflare_blocked(raw_text):
        return {
            "url": target,
            "status": status,
            "blockReason": "cloudflare_challenge",
            "elapsedMs": elapsed_ms,
        }

    return {
        "url": target,
        "status": status,
        "html": raw_text,
        "blockReason": None,
        "elapsedMs": elapsed_ms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Chrome-TLS-fingerprint HTTP fetcher")
    parser.add_argument("--url", required=True, help="Target homepage URL (with scheme)")
    parser.add_argument(
        "--paths",
        default="/",
        help="Comma-separated subpaths to probe relative to the homepage (e.g. '/,/contact,/about')",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=8.0,
        help="Per-request timeout in seconds (default 8)",
    )
    parser.add_argument(
        "--max-probes",
        type=int,
        default=4,
        help="Hard cap on probe count regardless of --paths length (default 4)",
    )
    args = parser.parse_args()

    impersonate = pick_impersonate()
    base = args.url.rstrip("/")
    paths = [p.strip() for p in args.paths.split(",") if p.strip()]
    if not paths:
        paths = ["/"]
    paths = paths[: args.max_probes]

    session = curl_requests.Session(impersonate=impersonate)
    probes = []
    for raw_path in paths:
        path = raw_path if raw_path.startswith("/") else f"/{raw_path}"
        target = f"{base}{path}" if path != "/" else (args.url if args.url.endswith("/") else f"{args.url}/")
        result = fetch_one(session, target, args.timeout)
        probes.append(result)
        # Early exit: a single probe surfaced a top-priority email candidate
        # would be ideal, but parsing emails here would duplicate the TS
        # extraction pipeline — keep this script dumb and let the caller decide.

    sys.stdout.write(json.dumps({"probes": probes, "impersonate": impersonate, "error": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
