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

// ScrapingBee server-side timeout. Their max is 140s; 20s is plenty for
// homepage + /contact and keeps our per-lead 60s budget intact.
const SCRAPINGBEE_TIMEOUT_MS = 20_000;
// Local socket timeout — ScrapingBee timeout + buffer for network roundtrip.
const SOCKET_TIMEOUT_MS = 30_000;
// Cap response body to avoid pulling 10MB pages that won't help anyway.
const MAX_BYTES = 2_000_000;

export interface ScrapingbeeFetchOpts {
  /** Render JS via headless browser (5 credits). Required for SPAs. */
  renderJs?: boolean;
  /** Use premium residential proxies (10–25 credits). Required for Cloudflare. */
  premiumProxy?: boolean;
  /** Block images/CSS/fonts to speed up render. */
  blockResources?: boolean;
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
    block_resources: String(opts.blockResources ?? true),
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
        res.resume();
        return finish(null);
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
