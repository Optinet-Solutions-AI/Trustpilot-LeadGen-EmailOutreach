/**
 * Tier 5b — ScrapFly managed-proxy fallback.
 *
 * Triggered after Tier 5 (ScrapingBee) returns null on a still-blocked lead.
 * Different IP pool and rendering infra from ScrapingBee, so domains that
 * have ScrapingBee's residential ranges blocked often clear ScrapFly on the
 * first try (and vice versa). Free tier: 1,000 credits/month, permanent.
 *
 * `asp=true` enables ScrapFly's Anti-Scraping Protection — their purpose-built
 * Cloudflare/PerimeterX/DataDome bypass. Costs 5 credits per call vs 1 for a
 * vanilla request, so each lead is bounded at ~10 credits (homepage + contact).
 *
 * Disabled silently when SCRAPFLY_API_KEY is not set.
 */

import https from 'node:https';

const SCRAPFLY_BASE = 'https://api.scrapfly.io/scrape';
const SCRAPFLY_TIMEOUT_MS = 60_000;
const SOCKET_TIMEOUT_MS = 80_000;
const MAX_BYTES = 5_000_000;

export interface ScrapflyFetchOpts {
  /** Render JS via headless browser. */
  renderJs?: boolean;
  /**
   * Anti-Scraping Protection — ScrapFly's CF/PerimeterX/DataDome bypass.
   * Costs ~5x a vanilla request but is the entire point of using this tier.
   * Default: true.
   */
  asp?: boolean;
  /** 2-letter country code for proxy geo-targeting (e.g. "no", "gb"). */
  countryCode?: string;
}

interface ScrapflyEnvelope {
  result?: {
    content?: string;
    response_headers?: Record<string, string>;
    status_code?: number;
  };
  // ScrapFly returns rich error objects; we only need the message.
  error?: { code?: string; message?: string };
}

/** Fetch a URL through ScrapFly. Returns raw HTML, or null on any failure. */
export async function fetchViaScrapfly(
  targetUrl: string,
  opts: ScrapflyFetchOpts = {},
): Promise<string | null> {
  const apiKey = process.env.SCRAPFLY_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    key: apiKey,
    url: targetUrl,
    render_js: String(opts.renderJs ?? true),
    asp: String(opts.asp ?? true),
    // Use ScrapFly's residential pool — datacenter pool will not pass CF.
    proxy_pool: 'public_residential_pool',
    timeout: String(SCRAPFLY_TIMEOUT_MS),
  });
  if (opts.countryCode) params.set('country', opts.countryCode);

  const apiUrl = `${SCRAPFLY_BASE}?${params.toString()}`;

  return new Promise<string | null>((resolve) => {
    let resolved = false;
    const finish = (v: string | null) => { if (!resolved) { resolved = true; resolve(v); } };

    const req = https.get(apiUrl, { timeout: SOCKET_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_BYTES) { req.destroy(); return; }
        body += chunk;
      });
      res.on('end', () => {
        // ScrapFly always returns 200 with a JSON envelope. The envelope's
        // result.status_code carries the upstream HTTP status.
        if (status === 401 || status === 403) {
          console.warn(`[tier5b] ScrapFly returned ${status} — check SCRAPFLY_API_KEY validity`);
          return finish(null);
        }
        if (status === 429) {
          console.warn(`[tier5b] ScrapFly returned 429 — credit pool depleted or rate limited`);
          return finish(null);
        }
        try {
          const envelope = JSON.parse(body) as ScrapflyEnvelope;
          if (envelope.error) {
            console.warn(`[tier5b] ScrapFly error: ${envelope.error.code ?? '?'} ${envelope.error.message ?? ''}`.trim());
            return finish(null);
          }
          const html = envelope.result?.content ?? null;
          finish(html);
        } catch (err) {
          console.warn(`[tier5b] ScrapFly response parse error: ${(err as Error).message}`);
          finish(null);
        }
      });
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', (err) => {
      console.warn(`[tier5b] ScrapFly request error: ${err.message}`);
      finish(null);
    });
  });
}

export function scrapflyEnabled(): boolean {
  return !!process.env.SCRAPFLY_API_KEY;
}
