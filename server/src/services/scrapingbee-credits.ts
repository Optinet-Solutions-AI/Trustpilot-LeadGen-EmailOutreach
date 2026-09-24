/**
 * ScrapingBee credit pre-flight.
 *
 * TripAdvisor is 100% ScrapingBee. With the pool drained, every page comes
 * back empty and the job used to finish as "completed, 0 found" — which reads
 * exactly like a market with no matching businesses (the ES hotels/restaurants/
 * attractions runs of 2026-09-24: 101,595 used of a 1,000 allowance). This
 * asks ScrapingBee's usage endpoint first, which costs no credits, so a
 * drained account is refused up front with a message that says to top up.
 *
 * Fails OPEN on anything but a definite answer: a missing key, a network
 * error or a malformed response returns 'unknown' and the scrape proceeds.
 * A flaky usage endpoint must never block scraping — only a confirmed empty
 * pool does.
 */

const USAGE_URL = 'https://app.scrapingbee.com/api/v1/usage';
const TIMEOUT_MS = 8_000;
const CACHE_MS = 60_000;

/** One stealth_proxy page — the most a single TripAdvisor fetch can cost. */
export const MIN_CREDITS_FOR_SCRAPE = 75;

export interface ScrapingBeeCredits {
  status: 'ok' | 'exhausted' | 'unknown';
  remaining?: number;
  used?: number;
  max?: number;
  renewal?: string;
  reason?: string;
}

let cache: { at: number; value: ScrapingBeeCredits } | null = null;

export async function getScrapingBeeCredits(opts: { fresh?: boolean } = {}): Promise<ScrapingBeeCredits> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) return { status: 'unknown', reason: 'SCRAPINGBEE_API_KEY not set in this process' };

  let value: ScrapingBeeCredits;
  try {
    const res = await fetch(`${USAGE_URL}?api_key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      value = { status: 'exhausted', reason: 'ScrapingBee rejected the API key (401)' };
    } else if (!res.ok) {
      value = { status: 'unknown', reason: `usage endpoint HTTP ${res.status}` };
    } else {
      const body = (await res.json()) as Record<string, unknown>;
      const max = Number(body.max_api_credit);
      const used = Number(body.used_api_credit);
      if (!Number.isFinite(max) || !Number.isFinite(used)) {
        value = { status: 'unknown', reason: 'usage endpoint returned no credit figures' };
      } else {
        const remaining = Math.max(0, max - used);
        value = {
          status: remaining < MIN_CREDITS_FOR_SCRAPE ? 'exhausted' : 'ok',
          remaining,
          used,
          max,
          renewal: typeof body.renewal_subscription_date === 'string'
            ? body.renewal_subscription_date
            : undefined,
        };
      }
    }
  } catch (err) {
    value = { status: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }

  console.log(`[${new Date().toISOString()}] [scrapingbee-credits] ${JSON.stringify(value)}`);
  cache = { at: Date.now(), value };
  return value;
}

/** Operator-facing message for an exhausted pool. */
export function scrapingBeeExhaustedMessage(c: ScrapingBeeCredits, platformLabel = 'TripAdvisor'): string {
  const figures = c.used !== undefined && c.max !== undefined
    ? ` (${c.used.toLocaleString('en-US')} of ${c.max.toLocaleString('en-US')} credits used)`
    : c.reason ? ` (${c.reason})` : '';
  return (
    `ScrapingBee is out of credits${figures}. ${platformLabel} can't be scraped until the ` +
    `ScrapingBee account is topped up — please top up at app.scrapingbee.com and try again.`
  );
}
