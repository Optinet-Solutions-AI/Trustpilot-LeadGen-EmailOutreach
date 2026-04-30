// URL sanitizer + validator for Trustpilot lead links.
// Mirrors tools/db/url_validator.py so manual edits made through the API
// produce the same canonical URL + link_status that the Python ingestion
// pipeline would.

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

export async function validateTrustpilotUrl(
  url: string,
  timeoutMs = 10_000,
): Promise<{ status: LinkStatus; error: string | null }> {
  if (!url) return { status: 'UNKNOWN', error: 'empty_url' };

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

  const status = resp.status;

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

  const body = (await resp.text()).toLowerCase();

  // Even with 200 OK, Cloudflare sometimes serves a challenge interstitial.
  // Detect that and bail out — same logic as the 403 branch above.
  for (const marker of CLOUDFLARE_CHALLENGE_MARKERS) {
    if (body.includes(marker)) {
      return { status: 'UNKNOWN', error: `cloudflare_challenge: ${marker}` };
    }
  }

  // Real soft-404 markers — Trustpilot's "this profile has been removed" page.
  for (const marker of SOFT_404_MARKERS) {
    if (body.includes(marker)) return { status: 'FLAGGED_REMOVED', error: `soft_404: ${marker}` };
  }
  return { status: 'VALID', error: null };
}
