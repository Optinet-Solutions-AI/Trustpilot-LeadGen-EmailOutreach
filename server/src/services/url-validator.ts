// URL sanitizer + validator for Trustpilot lead links.
// Mirrors tools/db/url_validator.py so manual edits made through the API
// produce the same canonical URL + link_status that the Python ingestion
// pipeline would.

import type { BrowserContext } from 'playwright';
import { fetchStatusViaScrapingbee, scrapingbeeEnabled } from './scrapers/tier5-scrapingbee.js';
import { handleCloudflareChallenge } from './scrapers/popup-handler.js';

export type LinkStatus = 'VALID' | 'FLAGGED_DEAD' | 'FLAGGED_REMOVED' | 'UNKNOWN';

const SOFT_404_MARKERS = [
  // Trustpilot's exact "removed profile" page copy. The page is JS-rendered
  // so the validator must use ScrapingBee with render_js=true to actually
  // see these strings.
  'this profile has been removed',
  'no longer visible on trustpilot',
  'goes against our guidelines',
  'why trustpilot removes profiles',
  // Generic "page gone" markers other parts of Trustpilot use.
  'this page does not exist',
  'page not found',
  'we could not find',
  "we couldn't find",
  "sorry, we couldn",
  "couldn't find the page",
];

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DUPLICATE_SCHEME = /^(https?:[/\\]+){2,}/i;
const SCHEME_PRESENT = /^https?:\/\//i;
const REPEATED_SLASHES = /(?<!:)\/{2,}/g;
const QUOTE_CHARS = /^["'“”‘’]+|["'“”‘’]+$/g;

export function sanitizeTrustpilotUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().replace(QUOTE_CHARS, '').replace(/\\/g, '/');
  s = s.replace(/\s+/g, '');
  if (!s) return null;
  s = s.replace(DUPLICATE_SCHEME, 'https://');
  if (!SCHEME_PRESENT.test(s)) s = 'https://' + s.replace(/^\/+/, '');

  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  const path = (parsed.pathname || '/').replace(REPEATED_SLASHES, '/');
  const cleaned = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}`;
  return cleaned.replace(/\/+$/, '') || null;
}

// Trustpilot sits behind Cloudflare's bot-management. Server-to-server fetches
// from Cloud Run regularly hit a challenge page (200 OK body that says "Just a
// moment…") OR get a 403/429/503 instead of the real profile. None of those
// mean the profile is dead — they mean we got blocked.
const CLOUDFLARE_CHALLENGE_MARKERS = [
  'just a moment',
  'checking your browser',
  'cf-browser-verification',
  'cf-challenge',
  'attention required! | cloudflare',
  'enable javascript and cookies to continue',
];

// Markers that prove the body IS a real Trustpilot profile page. Even when
// the upstream HTTP status is misleading (Cloudflare sometimes returns 403
// with the real page body intact for stealth-proxy traffic), spotting >=2
// of these in the DOM means the URL resolved to a live profile.
const LIVE_PROFILE_MARKERS = [
  'trustscore',
  'reviews are sorted',
  'sort by',
  'star rating',
  'verification badge',
  'companywebsite',
];

// Set VALIDATOR_USE_SCRAPINGBEE=false to force the cheap plain-HTTP path even
// when SCRAPINGBEE_API_KEY is set — useful for local debugging and to cap
// credit burn during smoke tests. Defaults to ScrapingBee when the key exists.
function shouldUseScrapingbee(): boolean {
  if (process.env.VALIDATOR_USE_SCRAPINGBEE === 'false') return false;
  return scrapingbeeEnabled();
}

// ── Playwright-based validation ────────────────────────────────────────────
//
// Uses the existing stealth Chromium pool (same one website-enricher uses).
// Free per-URL — pays the price in ~3-5s page-load instead of ~25 SB credits.
// The caller is expected to launch a browser at job start, pass the
// BrowserContext here, and close it at job end. Sharing one context across
// every URL in a batch keeps the per-URL cost down.
//
// On Trustpilot: stealth-Chromium handles Cloudflare challenges automatically;
// the explicit handleCloudflareChallenge call below is belt-and-braces for
// the rare case where the Cloudflare interstitial is JS-served and the
// browser needs an extra few seconds to solve it.

const PLAYWRIGHT_NAV_TIMEOUT_MS = 25_000;

export async function validateTrustpilotUrlViaPlaywright(
  context: BrowserContext,
  url: string,
): Promise<{ status: LinkStatus; error: string | null }> {
  const cleaned = sanitizeTrustpilotUrl(url);
  if (!cleaned) return { status: 'UNKNOWN', error: 'unsalvageable_url' };

  const playwrightResult = await runPlaywrightCheck(context, cleaned);

  // If Playwright got bot-blocked (403/429 from Cloudflare on specific
  // Trustpilot subdomains — au./ca./it./etc.), retry via ScrapingBee. SB's
  // residential proxies have a fresh IP per request so they're not on
  // Trustpilot's rate-limit list. Costs ~25 credits per fallback, NOT
  // per URL — only the small subset that Playwright couldn't see.
  const isBotBlock =
    playwrightResult.status === 'UNKNOWN' &&
    typeof playwrightResult.error === 'string' &&
    (playwrightResult.error.includes('bot_block') ||
     playwrightResult.error.includes('cloudflare_challenge') ||
     playwrightResult.error.startsWith('playwright_nav_failed'));

  if (isBotBlock && scrapingbeeEnabled() && process.env.VALIDATOR_USE_SCRAPINGBEE !== 'false') {
    // stealth_proxy is the ONLY path that reliably bypasses Trustpilot's
    // current Cloudflare config — premium_proxy is on their blocklist.
    // ~75 credits/call but only triggered when Playwright failed, so the
    // average cost per URL stays low (most don't reach this branch).
    const countryCode = inferCountryCode(cleaned);
    const sb = await fetchStatusViaScrapingbee(cleaned, {
      renderJs: true,
      stealthProxy: true,
      ...(countryCode ? { countryCode } : {}),
    });
    if (sb && sb.transportError === null && sb.apiStatus >= 200 && sb.apiStatus < 600) {
      const sbResult = classifyResponse(sb.upstreamStatus ?? sb.apiStatus, sb.body);
      return {
        status: sbResult.status,
        error: sbResult.error
          ? `${sbResult.error} (via scrapingbee_stealth after playwright ${playwrightResult.error ?? 'unknown'})`
          : null,
      };
    }
    return {
      status: 'UNKNOWN',
      error: `${playwrightResult.error ?? 'playwright_failed'} + scrapingbee_failed`,
    };
  }

  return playwrightResult;
}

// au.trustpilot.com → "au", de.trustpilot.com → "de", etc.
// Returns null for www. (no regional preference) or unparseable URLs.
function inferCountryCode(url: string): string | null {
  try {
    const host = new URL(url).host.toLowerCase();
    const m = host.match(/^([a-z]{2})\.trustpilot\.com$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function runPlaywrightCheck(
  context: BrowserContext,
  url: string,
): Promise<{ status: LinkStatus; error: string | null }> {
  const page = await context.newPage();
  try {
    let httpStatus = 0;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
      });
      httpStatus = response?.status() ?? 0;
    } catch (err) {
      // Distinguish DNS / unreachable from generic nav failures. DNS NXDOMAIN
      // means the URL is genuinely dead — different reason than "Trustpilot
      // showed a removed-profile page" — so flag it as DEAD with a specific
      // error so the badge tooltip can say "site can't be reached".
      const name = err instanceof Error ? err.name : 'Error';
      const msg = err instanceof Error ? err.message : String(err);
      const lowMsg = msg.toLowerCase();
      if (
        lowMsg.includes('err_name_not_resolved') ||
        lowMsg.includes('err_name_resolution_failed') ||
        lowMsg.includes('err_dns')
      ) {
        return { status: 'FLAGGED_DEAD', error: 'dns_nxdomain: site cant be reached' };
      }
      if (
        lowMsg.includes('err_connection_refused') ||
        lowMsg.includes('err_connection_reset') ||
        lowMsg.includes('err_connection_closed') ||
        lowMsg.includes('err_address_unreachable') ||
        lowMsg.includes('err_socket_not_connected')
      ) {
        return { status: 'FLAGGED_DEAD', error: 'connection_refused: site cant be reached' };
      }
      return { status: 'UNKNOWN', error: `playwright_nav_failed: ${name}` };
    }

    // 404/410 from Playwright is authoritative — Trustpilot really is gone.
    if (httpStatus === 404 || httpStatus === 410) {
      return { status: 'FLAGGED_DEAD', error: `http_${httpStatus}` };
    }

    const blockedHttp = httpStatus === 401 || httpStatus === 403 || httpStatus === 429 || httpStatus === 451;

    // If we landed on a Cloudflare interstitial, give stealth a chance to
    // clear it. Returns true once the real page renders.
    await handleCloudflareChallenge(page).catch(() => false);

    // Wait for the SPA to hydrate so soft-404 markers are in the DOM.
    await page.waitForTimeout(1500);

    const body = (await page.content()).toLowerCase();
    return classifyResponse(httpStatus || 200, body, { blockedHttp });
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function validateTrustpilotUrl(
  url: string,
  timeoutMs = 10_000,
): Promise<{ status: LinkStatus; error: string | null }> {
  // Sanitize at the entry point. Affiliate rows store tp_url without a
  // scheme ("au.trustpilot.com/review/foo") which both ScrapingBee and the
  // built-in fetch reject. Leads come in pre-sanitized but running it again
  // is cheap and idempotent — and keeps validateTrustpilotUrl safe to call
  // from any context (cron jobs, manual edits, ad-hoc scripts).
  const cleaned = sanitizeTrustpilotUrl(url);
  if (!cleaned) return { status: 'UNKNOWN', error: 'unsalvageable_url' };
  url = cleaned;
  if (!url) return { status: 'UNKNOWN', error: 'empty_url' };

  // ── ScrapingBee path ──
  // Premium-proxy + JS-render fetch via ScrapingBee. Trustpilot's profile
  // pages — including the "This profile has been removed" interstitial — are
  // SPA-rendered: HTTP 200 returns a near-empty shell and JS injects the real
  // copy. Without render_js we'd get the shell and miss every soft-404
  // (verdict drops to UNKNOWN even on genuinely-removed profiles).
  //
  // Cost: ~25 credits per call (premium_proxy + render_js). The trade-off is
  // accuracy — the previous render_js=false setting cost ~10 credits but
  // returned UNKNOWN for nearly everything. The ~10-credit cheap variant is
  // available behind VALIDATOR_CHEAP_RENDER=true for cost-sensitive batches.
  if (shouldUseScrapingbee()) {
    const renderJs = process.env.VALIDATOR_CHEAP_RENDER !== 'true';
    const sb = await fetchStatusViaScrapingbee(url, { renderJs, premiumProxy: true });
    // Only short-circuit on 2xx/3xx/4xx — a definitive answer from SB. SB
    // returns 5xx when it couldn't reach the upstream at all (DNS, connection
    // refused), so fall through to plain fetch where Node's undici cause
    // chain lets us distinguish ENOTFOUND vs ECONNREFUSED for a precise verdict.
    if (sb && sb.transportError === null && sb.apiStatus >= 200 && sb.apiStatus < 500) {
      return classifyResponse(sb.upstreamStatus ?? sb.apiStatus, sb.body);
    }
  }

  // ── Fallback: plain HTTPS ──
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: DEFAULT_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    // Node's undici fetch raises TypeError("fetch failed") with a `cause`
    // that contains the system error code (ENOTFOUND for DNS, ECONNREFUSED, etc.)
    const cause = (err as { cause?: { code?: string; errno?: number } })?.cause;
    const code = cause?.code || '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { status: 'FLAGGED_DEAD', error: 'dns_nxdomain: site cant be reached' };
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
      return { status: 'FLAGGED_DEAD', error: `connection_refused: ${code}` };
    }
    return { status: 'UNKNOWN', error: `request_failed: ${name}` };
  } finally {
    clearTimeout(timer);
  }

  const body = await resp.text();
  return classifyResponse(resp.status, body);
}

// Same verdict ladder applied to whichever fetch path produced the response.
// Kept here so the ScrapingBee, Playwright, and plain-fetch paths never drift.
function classifyResponse(
  status: number,
  body: string | null,
  hints: { blockedHttp?: boolean } = {},
): { status: LinkStatus; error: string | null } {
  const lower = (body ?? '').toLowerCase();

  // 1. Soft-404 markers — authoritative regardless of status. Trustpilot's
  //    "this profile has been removed" wording wins over everything because
  //    it directly answers the question we're trying to answer.
  for (const marker of SOFT_404_MARKERS) {
    if (lower.includes(marker)) return { status: 'FLAGGED_REMOVED', error: `soft_404: ${marker}` };
  }

  // 2. Hard-dead status codes — only reached when no removal marker matched.
  if (status === 404 || status === 410) {
    return { status: 'FLAGGED_DEAD', error: `http_${status}` };
  }

  // 3. Live-profile markers in a substantial body — page resolved. Cloudflare
  //    sometimes returns 403 status with the real 1.7MB page body intact
  //    when stealth-proxy IPs are flagged-but-not-rejected; trusting body
  //    content over status reverses that false-UNKNOWN. >30KB filters out
  //    error pages that just happen to mention "trustpilot" in a footer.
  if (lower.length > 30_000) {
    let hits = 0;
    for (const marker of LIVE_PROFILE_MARKERS) {
      if (lower.includes(marker)) hits++;
      if (hits >= 2) break;
    }
    if (hits >= 2) {
      return {
        status: 'VALID',
        error: status >= 400 ? `valid_body_despite_http_${status}` : null,
      };
    }
  }

  // 4. Cloudflare interstitial — body looks like the challenge page itself.
  for (const marker of CLOUDFLARE_CHALLENGE_MARKERS) {
    if (lower.includes(marker)) {
      return { status: 'UNKNOWN', error: `cloudflare_challenge: ${marker}` };
    }
  }

  // 5. Anti-bot status codes with no useful body content.
  if (status === 401 || status === 403 || status === 429 || status === 451) {
    return { status: 'UNKNOWN', error: `http_${status}_likely_bot_block` };
  }

  // 6. Other 4xx / 5xx — inconclusive.
  if (status >= 400) {
    return { status: 'UNKNOWN', error: `http_${status}` };
  }

  // 7. Playwright-side block hint when we couldn't tell from body or status.
  if (hints.blockedHttp) {
    return { status: 'UNKNOWN', error: `http_${status}_likely_bot_block` };
  }

  return { status: 'VALID', error: null };
}
