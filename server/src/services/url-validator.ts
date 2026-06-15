// URL sanitizer + validator for Trustpilot lead links.
// Mirrors tools/db/url_validator.py so manual edits made through the API
// produce the same canonical URL + link_status that the Python ingestion
// pipeline would.

import type { BrowserContext } from 'playwright';
import { fetchStatusViaScrapingbee, scrapingbeeEnabled } from './scrapers/tier5-scrapingbee.js';
import { handleCloudflareChallenge } from './scrapers/popup-handler.js';
import { extractAffiliateMeta, type AffiliateMeta } from './affiliate-meta-extractor.js';

export type LinkStatus = 'VALID' | 'FLAGGED_DEAD' | 'FLAGGED_REMOVED' | 'UNKNOWN';

export interface UrlCheckResult {
  status: LinkStatus;
  error: string | null;
  meta?: AffiliateMeta;
}

// Trustpilot's "removed profile" copy localized per regional subdomain.
// The page is JS-rendered so the validator must use Playwright OR
// ScrapingBee with render_js=true to actually see these strings.
//
// IMPORTANT: every match must be checked against the *script-stripped* body —
// Trustpilot's Next.js bundle inlines the entire i18n string table into a
// <script id="__NEXT_DATA__"> blob on every page (live or removed), so
// matching against raw HTML produces false positives on live pages.
const SOFT_404_MARKERS = [
  // English (au./ca./www./.co.uk/etc.)
  'this profile has been removed',
  'no longer visible on trustpilot',
  // German (de.)
  'dieses profil wurde entfernt',
  'verstößt gegen unsere richtlinien',
  'unternehmen, das sie suchen',
  // Italian (it.)
  'questo profilo è stato rimosso',
  'questo profilo e stato rimosso',
  // French (fr.)
  'ce profil a été supprimé',
  'ce profil a ete supprime',
  // Spanish (es.)
  'este perfil ha sido eliminado',
  // Dutch (nl.)
  'dit profiel is verwijderd',
  // Danish (dk.)
  'denne profil er blevet fjernet',
  // Swedish (se.)
  'den här profilen har tagits bort',
  // Norwegian (no.)
  'denne profilen er fjernet',
  // Finnish (fi.)
  'tämä profiili on poistettu',
  // Polish (pl.)
  'ten profil został usunięty',
  // Generic "page gone" markers other parts of Trustpilot use.
  'this page does not exist',
  'page not found',
  'we could not find',
  "we couldn't find",
];

// Structural markers that prove the body IS a live Trustpilot profile page.
// These are React data attributes / CSS class names — language-agnostic and
// harder to false-positive than localized text strings. Presence of any one
// of these in the script-stripped body means the profile rendered.
const LIVE_STRUCTURAL_MARKERS = [
  'data-business-unit',
  'data-service-review-',
  'styles_reviewlist',
  'reviewslist',
  'business-unit-id',
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
  opts: { extractMeta?: boolean } = {},
): Promise<UrlCheckResult> {
  const cleaned = sanitizeTrustpilotUrl(url);
  if (!cleaned) return { status: 'UNKNOWN', error: 'unsalvageable_url' };

  const playwrightResult = await runPlaywrightCheck(context, cleaned, opts.extractMeta ?? false);

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
     playwrightResult.error.includes('no_recognizable_signals') ||
     playwrightResult.error.startsWith('playwright_nav_failed') ||
     playwrightResult.error.startsWith('playwright_content_failed'));

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
        ...(opts.extractMeta && sb.body ? { meta: extractAffiliateMeta(sb.body) } : {}),
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
  extractMeta: boolean,
): Promise<UrlCheckResult> {
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

    // page.content() throws "Unable to retrieve content" when the page is in
    // a transitional state (about to navigate, mid-network-error). Treat that
    // as a Playwright failure so the SB fallback in the calling function
    // gets to retry — without this wrap, the worker_exception bubbled up to
    // the job runner and the URL was stuck on UNKNOWN.
    let rawBody: string;
    try {
      rawBody = await page.content();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'UNKNOWN', error: `playwright_content_failed: ${name} ${msg.slice(0, 80)}` };
    }
    const result: UrlCheckResult = classifyResponse(httpStatus || 200, rawBody.toLowerCase(), { blockedHttp });
    if (extractMeta) result.meta = extractAffiliateMeta(rawBody);
    return result;
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
// Trustpilot's Next.js SPA serializes the entire i18n string table —
// including the literal "this profile has been removed" copy — into a
// <script id="__NEXT_DATA__"> blob on EVERY page. Searching the raw HTML
// matched those bundled strings on live pages too, producing false
// FLAGGED_REMOVED verdicts. Stripping <script> and <style> content
// before searching restricts the match to actually-rendered DOM text.
function stripNonContent(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
}

function classifyResponse(
  status: number,
  body: string | null,
  hints: { blockedHttp?: boolean } = {},
): { status: LinkStatus; error: string | null } {
  const lower = stripNonContent(body ?? '').toLowerCase();

  // Detect structural live-profile markers (React data attributes / CSS
  // class names). These are language-agnostic — present on every live
  // profile page regardless of locale, absent on removed pages.
  let liveStructural: string | null = null;
  for (const marker of LIVE_STRUCTURAL_MARKERS) {
    if (lower.includes(marker)) { liveStructural = marker; break; }
  }

  // Detect any localized soft-404 marker.
  let soft404: string | null = null;
  for (const marker of SOFT_404_MARKERS) {
    if (lower.includes(marker)) { soft404 = marker; break; }
  }

  // 1. Hard-dead status codes — Trustpilot is gone, no body needed.
  if (status === 404 || status === 410) {
    return { status: 'FLAGGED_DEAD', error: `http_${status}` };
  }

  // 2. Confirmed REMOVED: localized removal text in body AND no live structure.
  //    Both conditions matter — some live pages embed the German/English
  //    removal copy in scripts, but stripNonContent already filtered those.
  //    The structural-absence check is the safety net.
  if (soft404 && !liveStructural) {
    return { status: 'FLAGGED_REMOVED', error: `soft_404: ${soft404}` };
  }

  // 3. Confirmed LIVE: structural marker present. Wins over a 4xx status,
  //    because Cloudflare sometimes returns 403 with the real page body
  //    intact for stealth-proxied requests (verified manually).
  if (liveStructural) {
    return {
      status: 'VALID',
      error: status >= 400 ? `valid_body_despite_http_${status}` : null,
    };
  }

  // 4. Cloudflare interstitial in the body — we couldn't see the real page.
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

  // 8. 2xx with no structural marker AND no removal marker — the response
  //    looks superficially fine but has neither a live profile nor a known
  //    removal page. Could be a removed page in an unsupported language,
  //    or a ScrapingBee error page. Be conservative: UNKNOWN, not VALID.
  return {
    status: 'UNKNOWN',
    error: 'no_recognizable_signals_in_body',
  };
}
