// URL sanitizer + validator for Trustpilot lead links.
// Mirrors tools/db/url_validator.py so manual edits made through the API
// produce the same canonical URL + link_status that the Python ingestion
// pipeline would.

import { fetchStatusViaScrapingbee, scrapingbeeEnabled } from './scrapers/tier5-scrapingbee.js';

export type LinkStatus = 'VALID' | 'FLAGGED_DEAD' | 'FLAGGED_REMOVED' | 'UNKNOWN';

const SOFT_404_MARKERS = [
  'this profile has been removed',
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

// Set VALIDATOR_USE_SCRAPINGBEE=false to force the cheap plain-HTTP path even
// when SCRAPINGBEE_API_KEY is set — useful for local debugging and to cap
// credit burn during smoke tests. Defaults to ScrapingBee when the key exists.
function shouldUseScrapingbee(): boolean {
  if (process.env.VALIDATOR_USE_SCRAPINGBEE === 'false') return false;
  return scrapingbeeEnabled();
}

export async function validateTrustpilotUrl(
  url: string,
  timeoutMs = 10_000,
): Promise<{ status: LinkStatus; error: string | null }> {
  if (!url) return { status: 'UNKNOWN', error: 'empty_url' };

  // ── ScrapingBee path ──
  // Premium-proxy fetch via ScrapingBee — the same Cloudflare bypass the
  // tier-5 scraper uses. ~10 credits per call (no JS render, premium proxy).
  // Trustpilot's "profile not found" page is server-side rendered, so we
  // skip render_js to save credits.
  if (shouldUseScrapingbee()) {
    const sb = await fetchStatusViaScrapingbee(url, { renderJs: false, premiumProxy: true });
    if (sb && sb.transportError === null && sb.apiStatus >= 200 && sb.apiStatus < 600) {
      return classifyResponse(sb.upstreamStatus ?? sb.apiStatus, sb.body);
    }
    // ScrapingBee itself failed (timeout, key issue, network) — fall through
    // to plain fetch so we still produce a verdict instead of UNKNOWN-by-default.
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
    return { status: 'UNKNOWN', error: `request_failed: ${name}` };
  } finally {
    clearTimeout(timer);
  }

  const body = await resp.text();
  return classifyResponse(resp.status, body);
}

// Same verdict ladder applied to whichever fetch path produced the response.
// Kept here so the ScrapingBee path and the plain-fetch path can never drift.
function classifyResponse(status: number, body: string | null): { status: LinkStatus; error: string | null } {

  // The only HTTP statuses that *prove* a profile is gone. 410 = explicitly
  // gone, 404 = not found. Anything else can be a transient block.
  if (status === 404 || status === 410) {
    return { status: 'FLAGGED_DEAD', error: `http_${status}` };
  }

  // Anti-bot / rate-limit responses. The page may very well be live — we
  // just couldn't see it from the server.
  if (status === 401 || status === 403 || status === 429 || status === 451) {
    return { status: 'UNKNOWN', error: `http_${status}_likely_bot_block` };
  }

  // 5xx and other 4xx — treat as inconclusive. Better to say "unknown" than
  // to falsely flag a working profile as dead.
  if (status >= 400) {
    return { status: 'UNKNOWN', error: `http_${status}` };
  }

  const lower = (body ?? '').toLowerCase();

  // Even with 200 OK, Cloudflare sometimes serves a challenge interstitial.
  // Detect that and bail out — same logic as the 403 branch above.
  for (const marker of CLOUDFLARE_CHALLENGE_MARKERS) {
    if (lower.includes(marker)) {
      return { status: 'UNKNOWN', error: `cloudflare_challenge: ${marker}` };
    }
  }

  // Real soft-404 markers — Trustpilot's "this profile has been removed" page.
  for (const marker of SOFT_404_MARKERS) {
    if (lower.includes(marker)) return { status: 'FLAGGED_REMOVED', error: `soft_404: ${marker}` };
  }
  return { status: 'VALID', error: null };
}
