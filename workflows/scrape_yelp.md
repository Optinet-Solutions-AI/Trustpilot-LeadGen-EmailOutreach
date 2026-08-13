# Workflow: Scrape Yelp

**Objective:** Scrape Yelp listings for low-rated businesses, enrich with website/phone, upsert via the multi-platform path.

Yelp's PerimeterX edge rejects direct Playwright across the board, and ScrapingBee `stealth_proxy` ONLY reaches `/biz/<slug>` profile pages — every attempt against `/search` times out at 90 seconds (verified by smoke test 2026-05-18). **Listing now defaults to a cookieless Apify actor** (`YELP_LISTING_SOURCE=apify`, `memo23/yelp-scraper`) that returns listing and profile data in one call, so the default path needs no browser and no Fusion key. Yelp Fusion has since gone paid with an expired trial, and the headed-browser (`browser`) and residential-proxy DataDome (`relay`) paths further down are fallbacks for a withdrawn actor or an unverified market.

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
| Listing | `tools/scraper/platforms/yelp.py` → `scrape_listing()` — source-dependent; **default `apify`** delegates to `tools/scraper/platforms/yelp_apify.py` (see below), `fusion` calls `GET /v3/businesses/search`, `browser`/`relay` scrape the `/search` HTML |
| Fusion client | `tools/scraper/shared/yelp_fusion.py` — wraps `search_businesses_paged`, `list_categories` (used only when `YELP_LISTING_SOURCE=fusion`) |
| Profile enrichment | `tools/scraper/platforms/yelp.py` → `enrich_profiles()` — on `apify` this is screenshot-only, no HTML fetch; on `browser`/`fusion`/`relay` it fetches `/biz/<slug>` via ScrapingBee `stealth_proxy` |
| Profile parser | `_extract_profile_detail()` unwraps `/biz_redir?url=…` for the business website |
| City seed | `tools/scraper/data/yelp_country_cities.json` (24 markets) |
| Category seed | `tools/scraper/data/yelp_categories.json` (30 SMB verticals) |
| Upsert | `tools/db/upsert_leads.py` → `_upsert_nontrustpilot_lead` (writes `lead_platform_presences(platform='yelp')`) |

---

## Network strategy

> Fallback-only material: describes the `fusion`/`browser`/`relay` combo (Fusion or browser-scraped listing + ScrapingBee profile fetch). The default path is Apify — see "Listing via Apify" below.

**Two sources, picked by what each can actually reach:**

| Call | URL / Endpoint | Service | Credits |
|---|---|---|---|
| Listing | `GET https://api.yelp.com/v3/businesses/search` | Yelp Fusion API | Free (5k/day) |
| Profile page | `https://www.yelp.com/biz/<slug>` | ScrapingBee `stealth_proxy` (`fetch_via_scrapingbee`) | 75 / fetch |
| Screenshot | `https://www.yelp.com/biz/<slug>` | ScrapingBee `stealth_proxy` (`fetch_screenshot_via_scrapingbee` — a SEPARATE paid call, not bundled) | 75 / fetch |

**Why split:** ScrapingBee `stealth_proxy` can reach `/biz/<slug>` (verified — 200 OK, 1.8 MB HTML in the original probe) but CANNOT reach `/search` (verified — 100% timeout, 5/5 in the 2026-05-18 smoke test). Fusion is the only way into Yelp's listing data without burning credits on a service that doesn't work.

**Cost model (`browser`/`fusion`/`relay` fallback paths):** ~30 Fusion calls
(free) + ~30-60 leads × TWO ScrapingBee calls each (profile HTML fetch +
screenshot fetch, 75 cr/call = 150 cr/lead) = **4,500-9,000 credits per
scrape**. The default `apify` path pays ScrapingBee for the screenshot only
(no profile-HTML call) — 75 cr/lead, half this — see "Listing via Apify"
below.

---

## Listing via Apify — `YELP_LISTING_SOURCE=apify` (DEFAULT)

Cookieless HTTP. No browser, no DataDome slider, no sticky IP — so it runs on
Cloud Run and the Linux worker, which is what makes Yelp available to users
other than the owner.

| Piece | File |
|---|---|
| Actor input, mapping, over-fetch, market gate | `tools/scraper/platforms/yelp_apify.py` |
| Listing branch | `tools/scraper/platforms/yelp.py` (`scrape_listing`, `source == 'apify'`) |
| Screenshot-only enrichment | `tools/scraper/platforms/yelp.py` (`enrich_profiles`) |
| Shared actor client (timeout recovery, 402 handling) | `tools/scraper/shared/apify.py` |

**Measured cost (2026-08-12):** `memo23/yelp-scraper` billed $0.0365 for 10
businesses — roughly $3.65 per 1,000 — and returned rating, review count,
phone (10/10), website (8/10), contact email (5/10) and claimed status
(10/10). The alternative `epctex/yelp-business-api` is ~$0.50 per 1,000 but
returns no email and no claimed status.

**One call now does both stages.** Listing and profile data arrive together,
so `enrich_profiles` performs no HTML fetch — only screenshots. That halves
ScrapingBee calls per lead and removes the old `YELP_MAX_ENRICH=25` data cap,
which used to discard website and phone for every lead past the 25th.

**Rating filtering is client-side, by necessity.** `searchSortBy` offers only
`''` (Recommended), `rating` (DESCENDING) and `review_count`. Nothing sorts
ascending, so low-rated leads are reached by over-fetching the Recommended
feed (`YELP_APIFY_OVERFETCH`, ceiling `YELP_APIFY_MAX_ITEMS`) and filtering
locally.

**Measured yield (2026-08-13, 233 live US businesses):**

| Rating band | Share of the Recommended feed |
|---|---|
| 5.0 | 34.8% |
| 4.5–4.9 | 31.8% |
| 4.0–4.4 | 11.6% |
| 3.5–3.9 | 6.4% |
| ≤3.4 | 15.5% |

Only **16.3%** land at or below the default `max_rating` of 3.5. So roughly
**6 businesses must be fetched per usable lead** — about **$0.017 per lead**
at $0.00275/item — which is why the over-fetch default is **6x**, not the 4x
originally guessed (4x returned only ~65% of the leads a run asked for).
Contact coverage across the same sample: website **52%**, contact email
**18%**. Each city logs `returned N businesses, K matched filter`; if a
market's ratio drifts well below 16%, raise the multiplier for it.

**Do not raise the multiplier by more than the ceiling allows.** Every
fetched business is billed whether or not it survives the filter, and the
per-city ask is also bounded by what the job still needs (`max_results`).

**US only until probed.** `YELP_APIFY_MARKETS` (default `US`) gates it. Other
countries fail with `FAILED:listing|yelp|apify_market_unverified|<country>`
rather than silently returning zero. To add one: run a single-city probe for
that country, confirm real rows, then add the ISO code to the env var.

| Failure | Meaning |
|---|---|
| `FAILED:listing\|yelp\|apify_credit` | Apify account out of credit — top up |
| `FAILED:listing\|yelp\|apify_empty\|<city>` | Actor returned nothing; if every city does this, the actor broke |
| `FAILED:listing\|yelp\|apify_error` | Generic Apify failure (missing token, 5xx, malformed payload) — leads already gathered from earlier cities in the same run are preserved |
| `FAILED:listing\|yelp\|filter_too_strict` | Rows returned but none in the rating band — widen `max_rating` |
| `FAILED:listing\|yelp\|apify_market_unverified` | Country not in `YELP_APIFY_MARKETS` |

---

## Parsing the `/search` page

> Applies to the `browser`/`relay` fallback sources, which scrape this HTML page directly. The default `apify` source receives structured JSON from the actor and never touches this markup.

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

> Fallback-source failure modes (`browser`/`fusion`/`relay`). For the default Apify path's failure codes, see "Listing via Apify" above.

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
| `SCRAPINGBEE_API_KEY` | Yes | Same key used for TripAdvisor. On the default `apify` path it buys ONLY the enrichment screenshot — one 75-credit `/biz/<slug>` fetch per lead. On the `browser`/`fusion`/`relay` fallback paths it also fetches profile HTML for website/phone/claimed status — two 75-credit calls per lead where the Apify path needs one. |

`YELP_API_KEY` is only needed when `YELP_LISTING_SOURCE=fusion` — Fusion is a fallback, not the default, and its trial has expired (`400 TRIAL_EXPIRED`).

The full `YELP_LISTING_SOURCE=apify` variable set (`APIFY_YELP_ACTOR`, `YELP_APIFY_ENRICH_EMAILS`, `YELP_APIFY_OVERFETCH`, `YELP_APIFY_MAX_ITEMS`, `YELP_APIFY_CACHE_DAYS`, `YELP_APIFY_MARKETS`) is documented in "Listing via Apify" above and in `CLAUDE.md`'s env var table — not duplicated here.

---

## Server-side listing via residential proxy — `YELP_LISTING_SOURCE=relay` (DataDome)

> Fallback only — the default path is Apify (see above). Use this when an actor is withdrawn or for a market Apify cannot reach.

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
| `YELP_RELAY_SOFTWARE_GL` | `false` | **Set `true` on the GPU-less Linux EC2 box.** Enables software WebGL (SwiftShader) + managed-window flags so xvfb Chrome fingerprints as a real desktop. Leave `false` on the owner's real-GPU desktop — forcing SwiftShader there is itself a headless tell. |

Requires the shared `RESIDENTIAL_PROXY_*` (Enigma) env already used by FB/IG.

### Linux EC2 (headless box under xvfb) — DataDome fingerprint hardening

Live-tested 2026-07-14: on a GPU-less Linux EC2 box under xvfb the relay flow **HARD-BLOCKED** (not a solvable slider) on two clean Enigma US IPs — block reasons "Something is preventing JavaScript from working" + "browsing faster than a human" + headless-like. The SAME cookie/relay flow gets a **solvable slider** on a real Windows desktop, so the differentiator is the **xvfb browser fingerprint**, not the IP. Chief tell: with no GPU, Chrome's WebGL silently fails and `getParameter(UNMASKED_RENDERER_WEBGL)` returns null.

The hardening (gated behind `YELP_RELAY_SOFTWARE_GL=true`, applied to BOTH `mint_yelp_datadome.py` and the relay scrape via `local_browser.software_gl`):

- **Software WebGL** — `--enable-unsafe-swiftshader` (Chrome 120+), `--use-gl=angle`, `--use-angle=swiftshader`, `--ignore-gpu-blocklist`, `--enable-webgl`. Do NOT add `--disable-gpu` (kills WebGL → reads headless).
- **Window manager** — `scripts/ec2-linux-yelp-setup.sh` installs and starts **fluxbox** on `:99` so windows are managed (focus/decorations) like a desktop.
- **Realistic display** — Xvfb `1920x1080x24`, `--window-size=1920,1080`, never `--headless`, keep `--disable-blink-features=AutomationControlled` and the default Linux-desktop UA.

**Re-test runbook (operator, on the EC2 box):**

1. `sudo /opt/scraper/scripts/ec2-linux-yelp-setup.sh` — installs fluxbox, starts Xvfb `:99` + fluxbox + x11vnc.
2. Add `YELP_RELAY_SOFTWARE_GL=true` (plus the other relay vars) to `/etc/scraper-worker.env`.
3. Confirm WebGL renders: `DISPLAY=:99 python3 -m tools.scraper.verify_webgl` → expect `PASS` with a SwiftShader/ANGLE renderer (a null renderer means the flags didn't take — fix before continuing).
4. Mint under xvfb via noVNC: `DISPLAY=:99 YELP_RELAY_SOFTWARE_GL=true YELP_STICKY_SESSION=optirate-yelp YELP_PROXY_COUNTRY=US python3 -m tools.scraper.mint_yelp_datadome` → **expect a SOLVABLE slider** (not the hard-block page); solve it.
5. Smoke one city: `DISPLAY=:99 YELP_LISTING_SOURCE=relay YELP_RELAY_SOFTWARE_GL=true ... python3 -m tools.scraper.run --platform yelp --action list --filters '{"country":"US","category":"plumbers","max_rating":5.0,"min_review_count":1}' --max-results 6` → PASS = real rows; FAIL = `FAILED:listing|yelp|datadome_challenge`.

**Unverified until the operator tests on the box** — this dev machine is a real-GPU Windows desktop and already gets a slider, so it cannot reproduce the xvfb hard-block. If step 4 still hard-blocks, capture the block page and report; keep Yelp on Windows meanwhile.

### Sticky exit IP & cookie lifetime (the mint→scrape IP must match)

The DataDome cookie is **bound to the exit IP** it was minted on. Both the mint and the scrape build the **identical** Enigma sticky password via `proxy_relay._build_upstream_password` (`..._country-US_session-<token>_lifetime-<ttl>`), so they land on the same IP — as long as the session still holds it.

Measured 2026-07-14 (network-level, from the dev box): a `_session-<token>` pins **one** exit IP across **separate connections/processes**, held **stable for 10+ minutes with zero drift**. Enigma's exact TTL/lifetime convention is **unverified** — `_lifetime-30m` is accepted (HTTP 200) and appended best-effort via `RESIDENTIAL_PROXY_SESSION_LIFETIME` (default `30m`; set empty to omit), but it may be ignored. Residential exit nodes can also drop at any time, forcing reassignment regardless of TTL.

- **Drift guard:** the relay scrape probes the current exit IP and compares it to the minted IP (recorded in the cookie bundle, or `YELP_DATADOME_EXPECTED_IP`). On mismatch it fails fast with `FAILED:listing|yelp|sticky_ip_drift` (re-mint needed) instead of a wasted load + confusing `datadome_challenge`.
- **`RESIDENTIAL_PROXY_SESSION_LIFETIME`** (default `30m`) — appended to the sticky password; keep it identical for mint and scrape (it is, since both use the same builder).

**Operating model (honest):** one mint reliably covers a crawl started within ~10 min of minting (sticky held ≥10 min with no drift in testing; anecdotally ~20 min). It is **not** guaranteed to survive a mint-once-scrape-hours-later gap — residential IPs drift/drop. So the practical pattern is **mint immediately before a batch run** (or when the worker is about to process queued Yelp jobs), not a set-once-forget cookie. The drift guard makes a stale cookie a clear "re-mint" signal rather than a silent failure. Longer-hold viability (30–60 min+) is unconfirmed and should be soak-tested on the box if hands-off on-demand scraping is required.

---

## EC2 activation runbook — making the `relay` fallback run for ALL users

> Fallback only. Apify already makes Yelp listing available to every user with
> no dedicated worker, no EC2 relay, and no slider-solving (see "Listing via
> Apify" above) — that's the default path. This runbook exists for the
> `relay` fallback: use it only if the Apify actor is withdrawn or a market
> is unreachable via Apify.

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

- **New country:** add a `"XX": ["City, Region", ...]` entry to `tools/scraper/data/yelp_country_cities.json`. Format mirrors what Yelp's `find_loc=` param accepts. JSON edit only — no code change. On the default `apify` path a country also needs a live single-city probe and its ISO code added to `YELP_APIFY_MARKETS` (see "Listing via Apify" above) before it will return anything.
- **New category:** add `{"slug": "...", "display_name": "..."}` to `tools/scraper/data/yelp_categories.json`. Slugs are passed verbatim as `find_desc=` on the search URL; Yelp accepts category aliases AND human-readable keywords there. Run taxonomy refresh to land it in `platform_categories`.
