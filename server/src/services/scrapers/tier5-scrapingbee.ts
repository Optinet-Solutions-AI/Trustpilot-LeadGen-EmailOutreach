/**
 * Tier 5 — ScrapingBee managed-proxy fallback.
 *
 * Last-resort enrichment path: when local stealth (tier 2) and proxy tiers (3/4)
 * all return cloudflare_challenge / bot_detected / access_denied, we hand the
 * URL to ScrapingBee's API. They render JS server-side via residential proxies
 * and return raw HTML. We reuse the same email extractors as the browser path.
 *
 * Cost: ~25 credits per call (premium_proxy + render_js). Only invoked when
 * cheaper tiers have already failed, so volume stays bounded.
 *
 * Disabled when SCRAPINGBEE_API_KEY is not set — the tier ladder skips it
 * silently and behaves identically to the previous 4-tier setup.
 */

import https from 'node:https';

const SCRAPINGBEE_BASE = 'https://app.scrapingbee.com/api/v1/';

// ScrapingBee server-side timeout. Their range is 1000–140000ms.
// Cloudflare-protected sites with premium_proxy + render_js routinely take
// 30–60s on their backend. 20s caused mass "socket hang up" errors because
// their edge proxy was killing slow renders mid-flight. 70s gives real
// rendering room while staying well under their hard cap.
const SCRAPINGBEE_TIMEOUT_MS = 70_000;
// Local socket timeout — ScrapingBee timeout + buffer for network roundtrip.
// Must exceed SCRAPINGBEE_TIMEOUT_MS so their server-side error response
// reaches us before we abort the connection ourselves.
const SOCKET_TIMEOUT_MS = 90_000;
// Cap response body to avoid pulling 10MB pages that won't help anyway.
const MAX_BYTES = 2_000_000;

export interface ScrapingbeeFetchOpts {
  /** Render JS via headless browser (5 credits). Required for SPAs. */
  renderJs?: boolean;
  /** Use premium residential proxies (10–25 credits). Required for Cloudflare. */
  premiumProxy?: boolean;
  /**
   * Use ScrapingBee's stealth_proxy tier (~75 credits). Their highest-tier
   * proxy with browser-fingerprint stealth and a much larger residential IP
   * pool. Use as a last resort when premium_proxy gets 403'd — Trustpilot
   * has actively blocked ScrapingBee's premium_proxy ranges, so the only
   * way through is stealth_proxy.
   */
  stealthProxy?: boolean;
  /**
   * Block images/CSS/fonts to speed up render. DEFAULT: false.
   * ScrapingBee returns HTTP 500 on many SPA / casino sites when this is true
   * (their backend's rendering pipeline can't handle resource blocking on
   * sites that lazy-load content via CSS). Their own error message says
   * "try with block_resources=False" so we respect it as the safer default.
   */
  blockResources?: boolean;
  /**
   * 2-letter country code (e.g. "au", "de") forces ScrapingBee to use a proxy
   * IP from that country. Helps with regional Trustpilot subdomains where
   * country-specific IPs are less aggressively blocked.
   */
  countryCode?: string;
}

/**
 * Fetch a URL through ScrapingBee and return raw HTML.
 * Returns null on any failure — caller treats it as "no email found".
 */
export async function fetchViaScrapingbee(
  targetUrl: string,
  opts: ScrapingbeeFetchOpts = {},
): Promise<string | null> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: String(opts.renderJs ?? true),
    premium_proxy: String(opts.premiumProxy ?? true),
    block_resources: String(opts.blockResources ?? false),
    timeout: String(SCRAPINGBEE_TIMEOUT_MS),
  });

  const apiUrl = `${SCRAPINGBEE_BASE}?${params.toString()}`;

  return new Promise<string | null>((resolve) => {
    let resolved = false;
    const finish = (v: string | null) => { if (!resolved) { resolved = true; resolve(v); } };

    const req = https.get(apiUrl, { timeout: SOCKET_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      // 200: OK with HTML. 4xx/5xx: ScrapingBee couldn't fetch the target — treat as miss.
      // 401/403/429: API key / quota issue — log so the user notices, but don't crash.
      if (status === 401 || status === 403) {
        console.warn(`[tier5] ScrapingBee returned ${status} — check SCRAPINGBEE_API_KEY validity`);
      } else if (status === 429) {
        console.warn(`[tier5] ScrapingBee returned 429 — credit pool depleted or rate limited`);
      }
      if (status < 200 || status >= 300) {
        // Drain body so we can log ScrapingBee's actual error message — they
        // return useful diagnostics like "Cloudflare challenge unresolved" that
        // we'd lose if we just discarded the response.
        let errBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { if (errBody.length < 500) errBody += chunk; });
        res.on('end', () => {
          if (status !== 401 && status !== 403 && status !== 429) {
            console.warn(`[tier5] ScrapingBee returned ${status}: ${errBody.slice(0, 200)}`);
          }
          finish(null);
        });
        res.on('error', () => finish(null));
        return;
      }
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_BYTES) {
          req.destroy();
          return;
        }
        body += chunk;
      });
      res.on('end', () => finish(body));
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', (err) => {
      console.warn(`[tier5] ScrapingBee request error: ${err.message}`);
      finish(null);
    });
  });
}

/** True if the env is configured to use ScrapingBee. */
export function scrapingbeeEnabled(): boolean {
  return !!process.env.SCRAPINGBEE_API_KEY;
}

// ── Validation-specific fetch ──────────────────────────────────────────────
//
// The link validator needs the *upstream* HTTP status code (Trustpilot's
// 404/410 vs ScrapingBee's own 4xx) so it can distinguish "page is gone" from
// "we got rate-limited." ScrapingBee surfaces upstream status in the
// `Spb-Original-Status-Code` header.
//
// Render JS is OFF by default — Trustpilot's "profile not found" page is
// server-side rendered, so we save credits (~10/call instead of ~25). Premium
// proxy stays on; without it Cloudflare blocks ScrapingBee's data-center IPs.

export interface ScrapingbeeStatusResult {
  /** Upstream (Trustpilot) HTTP status, or null if ScrapingBee itself errored. */
  upstreamStatus: number | null;
  /** ScrapingBee's own HTTP status. 200 = success, 4xx/5xx = SB error. */
  apiStatus: number;
  body: string | null;
  /** Set when we couldn't reach ScrapingBee at all (network error, timeout). */
  transportError: string | null;
}

export async function fetchStatusViaScrapingbee(
  targetUrl: string,
  opts: ScrapingbeeFetchOpts = {},
): Promise<ScrapingbeeStatusResult | null> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: String(opts.renderJs ?? false),
    block_resources: String(opts.blockResources ?? false),
    timeout: String(SCRAPINGBEE_TIMEOUT_MS),
    // Without this flag SB rewrites 4xx upstream responses into a generic
    // ScrapingBee error and we lose the 404 signal we need.
    transparent_status_code: 'true',
  });
  // stealth_proxy and premium_proxy are mutually exclusive — stealth wins
  // when both are set. Stealth implies premium-tier traffic + extra fingerprint.
  if (opts.stealthProxy) params.set('stealth_proxy', 'true');
  else params.set('premium_proxy', String(opts.premiumProxy ?? true));
  if (opts.countryCode) params.set('country_code', opts.countryCode);

  const apiUrl = `${SCRAPINGBEE_BASE}?${params.toString()}`;

  return new Promise<ScrapingbeeStatusResult>((resolve) => {
    let resolved = false;
    const finish = (v: ScrapingbeeStatusResult) => { if (!resolved) { resolved = true; resolve(v); } };

    const req = https.get(apiUrl, { timeout: SOCKET_TIMEOUT_MS }, (res) => {
      const apiStatus = res.statusCode ?? 0;
      const upstreamHeader =
        (res.headers['spb-original-status-code'] as string | undefined) ??
        (res.headers['Spb-Original-Status-Code'] as string | undefined);
      const upstreamStatus = upstreamHeader ? parseInt(upstreamHeader, 10) : apiStatus;

      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_BYTES) { req.destroy(); return; }
        body += chunk;
      });
      res.on('end', () => finish({ apiStatus, upstreamStatus, body: body || null, transportError: null }));
      res.on('error', (err) => finish({ apiStatus, upstreamStatus, body: null, transportError: err.message }));
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ apiStatus: 0, upstreamStatus: null, body: null, transportError: 'socket_timeout' });
    });
    req.on('error', (err) => {
      finish({ apiStatus: 0, upstreamStatus: null, body: null, transportError: err.message });
    });
  });
}
