/**
 * What a scrape cost, surfaced on the job instead of left in a vendor console.
 *
 * TripAdvisor and Yelp are the two platforms that cannot be scraped for free:
 * every run spends ScrapingBee credits, Apify items or OpenAI calls. None of
 * it used to appear anywhere in the app, so the only way to learn what a run
 * cost was to open the vendor's dashboard afterwards. That is how a Spanish
 * TripAdvisor run burned 101,595 ScrapingBee credits against a 1,000 allowance
 * on 2026-09-24 and still reported "completed, 0 found".
 *
 * Each paid path prints one line per unit of spend, which the scrape runner
 * collects off stdout:
 *
 *   COST:{platform}|{vendor}|{usd}|{units}|{unitLabel}
 *
 * USD is exact where we meter it — OpenAI reports token usage on every call,
 * so that figure is real. Where only the native unit is known (ScrapingBee
 * credits, Apify items) the USD field may be empty, and the units are shown
 * on their own rather than dressed up as a dollar amount we cannot vouch for.
 */

export interface CostEntry {
  platform: string;
  vendor: string;
  /** Exact where metered, an estimate where derived, 0 where unknown. */
  usd: number;
  units: number;
  unitLabel: string;
}

export interface VendorCost {
  vendor: string;
  usd: number;
  units: number;
  unitLabel: string;
}

export interface ScrapeCostSummary {
  totalUsd: number;
  byVendor: VendorCost[];
  /** Null when the run produced no leads — the question has no answer then. */
  usdPerLead: number | null;
}

const LINE = /^COST:([^|]+)\|([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)$/;

/** One `COST:` line, or null for anything else the scraper printed. */
export function parseCostLine(line: string): CostEntry | null {
  const m = LINE.exec((line ?? '').trim());
  if (!m) return null;

  const [, platform, vendor, usdRaw, unitsRaw, unitLabel] = m;
  // An empty USD is legitimate: the units are real spend even when the rate
  // is not known. Anything non-numeric is a malformed line, not a zero.
  const usd = usdRaw.trim() === '' ? 0 : Number(usdRaw);
  const units = unitsRaw.trim() === '' ? 0 : Number(unitsRaw);
  if (!Number.isFinite(usd) || !Number.isFinite(units)) return null;
  if (!platform.trim() || !vendor.trim()) return null;

  return {
    platform: platform.trim(),
    vendor: vendor.trim(),
    usd,
    units,
    unitLabel: unitLabel.trim(),
  };
}

/** Everything one job spent, grouped by vendor, biggest bill first. */
export function summariseScrapeCost(
  lines: string[],
  leadsFound?: number,
): ScrapeCostSummary {
  const byVendor = new Map<string, VendorCost>();

  for (const line of lines) {
    const entry = parseCostLine(line);
    if (!entry) continue;
    const got = byVendor.get(entry.vendor);
    if (got) {
      got.usd += entry.usd;
      got.units += entry.units;
    } else {
      byVendor.set(entry.vendor, {
        vendor: entry.vendor,
        usd: entry.usd,
        units: entry.units,
        unitLabel: entry.unitLabel,
      });
    }
  }

  // Float addition leaves 0.30000000000000004 behind, which then renders as
  // "$0.3000000000000000" in the UI.
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  for (const v of byVendor.values()) v.usd = round(v.usd);

  const vendors = [...byVendor.values()].sort(
    (a, b) => b.usd - a.usd || b.units - a.units || a.vendor.localeCompare(b.vendor),
  );
  const totalUsd = round(vendors.reduce((n, v) => n + v.usd, 0));

  return {
    totalUsd,
    byVendor: vendors,
    // Null when there is nothing to divide OR nothing to divide BY: a free
    // run has no per-lead cost to report, and the UI simply says "free".
    usdPerLead: totalUsd > 0 && leadsFound && leadsFound > 0
      ? round(totalUsd / leadsFound)
      : null,
  };
}

/**
 * Money, at the precision the number deserves.
 *
 * Per-lead costs live in fractions of a cent — $0.0032 is the entire argument
 * for batching pass 1 — and rendering that as "$0.00" throws away the point.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return 'free';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
