# Workflow: Scrape Yelp

**Objective:** Scrape Yelp listings for low-rated businesses, enrich with website/phone, upsert via the multi-platform path.

Yelp's PerimeterX edge rejects direct Playwright across the board, and ScrapingBee `stealth_proxy` ONLY reaches `/biz/<slug>` profile pages — every attempt against `/search` times out at 90 seconds (verified by smoke test 2026-05-18). So Yelp uses a **two-source design**: listing through Yelp Fusion (free, 5,000/day), profile enrichment through ScrapingBee.

---

## Inputs

| Filter | Required | Notes |
|---|---|---|
| `country` | yes | One of `US`, `CA`, `UK`, `IE`, `AU`, `NZ`. Drives city fan-out via `yelp_country_cities.json`. |
| `category` | yes | Slug from the curated category seed (`yelp_categories.json`) — e.g. `plumbers`, `restaurants`, `auto-repair`. The slug is passed verbatim as `find_desc=` on the search URL. |
| `max_rating` | no | Default 3.5 |
| `min_rating` | no | Default 1.0 |
| `min_review_count` | no | Default 5 — filters out businesses with too few reviews to act on |
| `max_pages` | no | Default 5 pages per city — overrides credit budget |

---

## Tools

| Step | Tool |
|---|---|
| Listing | `tools/scraper/platforms/yelp.py` → `scrape_listing()` calls Fusion `GET /v3/businesses/search` |
| Fusion client | `tools/scraper/shared/yelp_fusion.py` — wraps `search_businesses_paged`, `list_categories` |
| Profile enrichment | `tools/scraper/platforms/yelp.py` → `enrich_profiles()` fetches `/biz/<slug>` via ScrapingBee `stealth_proxy` |
| Profile parser | `_extract_profile_detail()` unwraps `/biz_redir?url=…` for the business website |
| City seed | `tools/scraper/data/yelp_country_cities.json` (13 markets) |
| Category seed | `tools/scraper/data/yelp_categories.json` (30 SMB verticals) |
| Upsert | `tools/db/upsert_leads.py` → `_upsert_nontrustpilot_lead` (writes `lead_platform_presences(platform='yelp')`) |

---

## Network strategy

**Two sources, picked by what each can actually reach:**

| Call | URL / Endpoint | Service | Credits |
|---|---|---|---|
| Listing | `GET https://api.yelp.com/v3/businesses/search` | Yelp Fusion API | Free (5k/day) |
| Profile page | `https://www.yelp.com/biz/<slug>` | ScrapingBee `stealth_proxy` | 75 / fetch |
| Screenshot | bundled with profile fetch | ScrapingBee | free |

**Why split:** ScrapingBee `stealth_proxy` can reach `/biz/<slug>` (verified — 200 OK, 1.8 MB HTML in the original probe) but CANNOT reach `/search` (verified — 100% timeout, 5/5 in the 2026-05-18 smoke test). Fusion is the only way into Yelp's listing data without burning credits on a service that doesn't work.

**Cost model:** ~30 Fusion calls (free) + ~30-60 ScrapingBee profile fetches at 75 cr = **2,250-4,500 credits per scrape**.

---

## Parsing the `/search` page

| Field | Source |
|---|---|
| `name` | text of the `/biz/<slug>` anchor that isn't a "N reviews" link or a bare digit |
| `profile_url` | `https://www.yelp.com/biz/<slug>` (query params + fragment stripped) |
| `rating` | `aria-label="X.X star rating"` within the card boundary |
| `review_count` | first `\b(\d+)\s+reviews?\b` match in the card text |

Card boundary = nearest `<li>` (or `[role="listitem"]`) ancestor. **Critical** — without it, ancestor walks pick up an adjacent card's rating and assign it to a rating-less business.

## Parsing the `/biz/<slug>` page

| Field | Parsing notes |
|---|---|
| `website_url` | "Business website" link wraps `/biz_redir?url=<URL-encoded target>&...`. Unwrap + URL-decode the `url=` param. Many businesses don't link a website — emit `website_url=None`. |
| `phone` | `<a href="tel:...">` is profile-authoritative |
| `profile_claimed` | "Claim this business" CTA → False (highest-converting cold-outreach target); "Claimed" badge or "Verified License" → True |

---

## Expected output

Per lead:
```python
{
  'platform': 'yelp',
  'profile_url': 'https://www.yelp.com/biz/<slug>',
  'company_name': '...',
  'rating': 2.5,
  'review_count': 47,
  'website_url': '<unwrapped or None>',
  'phone': '<from profile or None>',
  'profile_claimed': False,
  'website_email': '<from scrape_website.py if website_url present>',
  'screenshot_path': '<Supabase Storage URL>',
  'country': 'US',
  'category': 'plumbers',
}
```

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `FAILED:listing|yelp|missing_key|SCRAPINGBEE_API_KEY` | Env var not set | `gcloud run services update trustpilot-crm --update-env-vars SCRAPINGBEE_API_KEY=...` or set in local `.env` |
| `FAILED:listing|<url>|empty_html` | ScrapingBee returned nothing (could be 403, 500, or timeout) | Confirm `stealth_proxy=True` (it is — never use `premium_proxy`); if persistent, ScrapingBee's stealth pool is degraded — escalate to support |
| Zero matched listings | Either every result was over the rating cap OR the parser drifted | Re-run with a wider `max_rating`; if still zero, check the live `/search` HTML against the parser selectors |
| `FAILED:profile|<url>|empty_html` | ScrapingBee returned nothing for the profile | Retry once; if persistent, the slug may be dead |

---

## Env vars

| Variable | Required | Notes |
|---|---|---|
| `SCRAPINGBEE_API_KEY` | Yes | Same key used for TripAdvisor; powers both listing and profile for Yelp |

`YELP_API_KEY` is **no longer used** — removed when listing pivoted from Fusion to `/search` via ScrapingBee.

---

## Server-side listing via residential proxy — `YELP_LISTING_SOURCE=relay` (DataDome)

Yelp's `/search` is guarded by **DataDome** (not PerimeterX). Verified empirically 2026-07-14:

- ScrapingBee (stealth/premium, JS on/off) → HTTP 500 / timeout on `/search` (DataDome defeats it server-side). Only `/biz/<slug>` works on ScrapingBee.
- A residential exit IP + **real (non-MITM) browser TLS** is required. selenium-wire (the FB/IG proxy path in `uc_driver.py`) MITMs TLS and is flagged instantly by DataDome — and crashes on Windows — so it is NOT usable here.
- DataDome serves an **interactive slider** to every fresh cookieless session (headed or headless, US or owner IP). It does not auto-clear. A human solves it **once**; that mints a `datadome` cookie which then unlocks other cities/searches.
- Cookie reuse **works only in a HEADED browser**. Headless is re-fingerprinted and re-challenged even with a valid cookie + same IP. So the server path is **headed Chrome under a virtual display (xvfb/noVNC)** on the EC2 worker — the same pattern as Facebook.
- The `datadome` cookie is bound to the **exit IP**, so the whole crawl must hold ONE IP. Enigma pins an IP when the password carries a `_session-<token>` suffix (verified sticky for minutes+).

**How it's wired:**

| Piece | File |
|---|---|
| Non-MITM CONNECT auth relay (real TLS end-to-end, upstream `Proxy-Authorization`) | `tools/scraper/shared/proxy_relay.py` (`RelayServer`) |
| Opt-in proxy/profile/cookie/headless options on the browser fetcher | `tools/scraper/shared/local_browser.py` (`LocalBrowserFetcher`) |
| `relay` listing source (starts relay on sticky session, injects cookie) | `tools/scraper/platforms/yelp.py` (`scrape_listing`) |
| One-time human cookie mint (solve the slider) | `tools/scraper/mint_yelp_datadome.py` |

**Operator flow (mirror the FB noVNC checkpoint pattern):**

1. On a machine with a visible display (owner desktop, or EC2 under xvfb/noVNC), mint the cookie once:
   ```
   PYTHONUTF8=1 .venv/Scripts/python.exe -m tools.scraper.mint_yelp_datadome
   ```
   A Chrome window opens on Yelp `/search`; **drag the DataDome slider to solve it**. On success the `datadome` cookie is saved to `tools/scraper/data/yelp_datadome_cookie.json` (override with `YELP_DATADOME_COOKIE_FILE`), along with the exit IP and sticky-session token.
2. Run listing with the relay source (headed / xvfb), reusing the SAME sticky session + country:
   ```
   YELP_LISTING_SOURCE=relay YELP_STICKY_SESSION=<token> YELP_PROXY_COUNTRY=US \
   .venv/Scripts/python.exe -m tools.scraper.run --platform yelp --action list \
     --filters '{"country":"US","category":"plumbers","max_rating":5.0,"min_review_count":1}'
   ```
3. **Re-solve when it expires.** When the cookie expires or the sticky IP drifts, the relay source emits `FAILED:listing|yelp|datadome_challenge` — just re-run step 1 (solve the slider again). This is the Yelp equivalent of an FB checkpoint recovery.

Smoke-verified 2026-07-14: minted once (10 cards, plumbers/Chicago), then headed reuse returned real cards for other cities — dentists/Austin (24), and via the wired `relay` source, plumbers/New York (5 rows written). Headless reuse returned the slider (expected).

**Relay-source env vars:**

| Variable | Default | Notes |
|---|---|---|
| `YELP_LISTING_SOURCE=relay` | `browser` | Selects this path |
| `YELP_PROXY_COUNTRY` | the scrape's `country` | Enigma exit country ISO-2; must match the country the cookie was minted on |
| `YELP_STICKY_SESSION` | `optirate-yelp` | Enigma `_session-<token>`; must match the mint |
| `YELP_PROXY_PROFILE_DIR` | none | Optional persistent Chrome profile (also carries the solved state) |
| `YELP_DATADOME_COOKIE_FILE` | `tools/scraper/data/yelp_datadome_cookie.json` | Minted cookie bundle |
| `YELP_DATADOME_COOKIE` | none | Raw cookie value (overrides the file) |
| `YELP_RELAY_HEADLESS` | `false` | Keep false — headless is re-challenged. Only true under xvfb where the fingerprint reads as headed. |

Requires the shared `RESIDENTIAL_PROXY_*` (Enigma) env already used by FB/IG.

---

## EC2 activation runbook — making Yelp discovery run for ALL users

> **Preferred host: the Linux worker under xvfb (cheaper).** The Windows box
> carries a Windows-license premium and is only needed for FB/IG. To avoid
> paying for it, run Yelp on the **Linux** worker headed-under-xvfb and *stop*
> (not terminate) the Windows box — see **`scripts/ec2-linux-yelp-setup.sh`**,
> which installs xvfb+x11vnc, and its printed steps (env vars, one-time cookie
> mint via the existing `ec2-expose-vnc.sh` noVNC tunnel, a **verification scrape**,
> then worker restart). **Verify Yelp actually returns cards under xvfb BEFORE
> stopping the Windows box** — xvfb-headed vs DataDome is unproven (though it's a
> different anti-bot system from the Meta checkpoints that block FB/IG on Linux,
> so the FB-on-Linux failure does not predict Yelp's outcome). Stopping the
> Windows box is reversible (Start it again to resume FB/IG; disk is preserved).
>
> The Windows two-worker setup below remains the fallback if xvfb is challenged.

The relay path only activates when a **headed** worker with `YELP_LISTING_SOURCE=relay`
claims the Yelp jobs. The default worker topology does NOT do this: the claim RPC's
`PLATFORM_FILTER` is exact single-match (migration 043), so the FB worker (headed,
`PLATFORM_FILTER=facebook`) won't take Yelp, and the Linux worker (which claims
"everything except fb/ig" via the comma-list `PLATFORM_EXCLUDE`, migration 047) is
**headless** and can't run the relay. So Yelp needs its OWN headed worker.

**One-time setup (operator, on the boxes — needs box access + one human slider-solve):**

1. **Deploy** — push to `main`; the Windows EC2 box auto-pulls, or force via
   `scripts/ec2-windows-deploy.ps1`. Then `cd C:\scraper\server; npm run build`.
2. **Mint the cookie once** in the noVNC desktop (interactive — NOT as a service):
   ```powershell
   cd C:\scraper
   $env:YELP_STICKY_SESSION="optirate-yelp"; $env:YELP_PROXY_COUNTRY="US"
   python -m tools.scraper.mint_yelp_datadome    # solve the DataDome slider in the window
   ```
   Cookie lands in `C:\scraper\tools\scraper\data\yelp_datadome_cookie.json`.
3. **Install the dedicated Yelp worker service** (mirrors the FB worker service):
   ```powershell
   # PowerShell as Administrator; STICKY inside the script must match step 2
   .\scripts\ec2-windows-install-yelp-worker-service.ps1
   nssm edit scraper-worker-yelp     # Log on -> .\Administrator + password
   nssm start scraper-worker-yelp
   Get-Content C:\scraper\server\logs\worker-yelp.log -Wait -Tail 20
   ```
   Confirm `RESIDENTIAL_PROXY_*` (Enigma) env is present for the service account.
4. **Stop the Linux worker from grabbing Yelp** (it can't run it headed): on the
   Singapore Linux box, add `yelp` to the exclude list and restart:
   ```bash
   sudo sed -i 's/^PLATFORM_EXCLUDE=.*/PLATFORM_EXCLUDE=facebook,instagram,yelp/' /etc/scraper-worker.env
   # (add the line if it doesn't exist)
   sudo systemctl restart scraper-worker.service
   ```
5. **Re-solve on expiry** — when the cookie expires / sticky IP drifts, the worker
   logs `FAILED:listing|yelp|datadome_challenge`; re-run step 2 in noVNC. Same cadence
   as an FB checkpoint.

**Session-0 caveat:** the NSSM service runs in session 0 (no visible desktop). It
launches a real (non-`--headless`) Chrome, which normally reads as headed to
DataDome. If the worker log shows repeated `datadome_challenge` right after a fresh
mint, DataDome is treating session-0 Chrome as headless — fall back to running the
worker **inside the interactive noVNC session** (same place FB login runs), e.g.
`cd C:\scraper\server; $env:PLATFORM_FILTER="yelp"; ...; node dist/worker/scraper-worker.js`.

---

## Adding markets and categories

- **New country:** add a `"XX": ["City, Region", ...]` entry to `tools/scraper/data/yelp_country_cities.json`. Format mirrors what Yelp's `find_loc=` param accepts. JSON edit only — no code change.
- **New category:** add `{"slug": "...", "display_name": "..."}` to `tools/scraper/data/yelp_categories.json`. Slugs are passed verbatim as `find_desc=` on the search URL; Yelp accepts category aliases AND human-readable keywords there. Run taxonomy refresh to land it in `platform_categories`.
