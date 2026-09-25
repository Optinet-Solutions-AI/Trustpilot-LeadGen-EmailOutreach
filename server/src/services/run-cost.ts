/**
 * What a run will cost, before it runs — and what it actually cost, after.
 *
 * Scraping already reports spend as it happens (`COST:` lines collected by
 * scrape-runner). Two other things that spend money did not:
 *
 *   - **Enrichment** creates a `scrape_jobs` row and never wrote a cost to it,
 *     so tier 10 could spend real money invisibly.
 *   - **Verification** had no job row at all, so ZeroBounce credits vanished
 *     entirely.
 *
 * ESTIMATE BEFORE, MEASURE AFTER
 *
 * Enrichment and verification can be priced up front because the work is
 * known: a list of leads, a list of addresses. Scraping cannot — the whole
 * point is discovering businesses nobody has counted yet — so its estimate is
 * a CEILING derived from the fan-out (cities x per-city cap), and the run
 * reports the real figure as it goes.
 *
 * NEVER INVENT A RATE
 *
 * A vendor whose price we do not hold reports its NATIVE unit — credits — and
 * no dollars. An invented figure gets quoted back as fact; a credit count is
 * true whether or not anyone has configured a price. ZeroBounce, MillionVerifier
 * and Hunter are all in that position unless their `*_USD_PER_CREDIT` var is set.
 */

export interface CostEstimate {
  /** Null when no dollar rate is known — the units still are. */
  usd: number | null;
  units: number;
  unitLabel: string;
  vendor: string;
  /** True when this is a ceiling rather than a prediction. */
  isCeiling: boolean;
  /** One line a human can read, for the UI. */
  summary: string;
}

const money = (usd: number): string =>
  usd < 0.01 ? `$${usd.toFixed(4)}` : usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;

function rateFromEnv(key: string): number | null {
  const raw = (process.env[key] ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Measured 2026-09-25: $0.047 per lead attempted, $0.079 per email found. */
export const ENRICH_OPENAI_USD_PER_LEAD = 0.047;

/**
 * What enriching this many leads will cost.
 *
 * Only tier 10 costs money. Every tier before it is either free or running on
 * a dead account (ScrapingBee is a free tier 100x over its allowance,
 * ScrapFly is unset, Hunter's free tier is 50 calls a month), so with tier 10
 * off the honest answer is zero rather than a guess at credits nobody is
 * paying for.
 */
export function estimateEnrichCost(leadCount: number, opts: { openAiEnabled: boolean; maxCalls?: number }): CostEstimate {
  const leads = Math.max(0, Math.floor(leadCount || 0));
  if (!opts.openAiEnabled) {
    return {
      usd: 0, units: leads, unitLabel: 'leads', vendor: 'none', isCeiling: false,
      summary: `${leads} leads · free (the paid tier is off)`,
    };
  }
  // A per-run ceiling caps the spend regardless of how many leads are queued.
  const billable = opts.maxCalls && opts.maxCalls > 0 ? Math.min(leads, opts.maxCalls) : leads;
  const usd = billable * ENRICH_OPENAI_USD_PER_LEAD;
  const capped = billable < leads ? ` (capped at ${billable})` : '';
  return {
    usd, units: billable, unitLabel: 'lookups', vendor: 'openai', isCeiling: true,
    summary: `${leads} leads${capped} · up to ${money(usd)} · ~60% find an address`,
  };
}

/**
 * What verifying this many addresses will cost.
 *
 * One ZeroBounce credit per address. The dollar figure appears only when
 * `ZEROBOUNCE_USD_PER_CREDIT` is set, because the rate depends entirely on the
 * plan and a made-up number would be repeated as fact.
 */
export function estimateVerifyCost(emailCount: number): CostEstimate {
  const emails = Math.max(0, Math.floor(emailCount || 0));
  const rate = rateFromEnv('ZEROBOUNCE_USD_PER_CREDIT');
  const usd = rate === null ? null : emails * rate;
  return {
    usd, units: emails, unitLabel: 'credits', vendor: 'zerobounce', isCeiling: false,
    summary: usd === null
      ? `${emails} addresses · ${emails} ZeroBounce credits (no USD rate configured)`
      : `${emails} addresses · ${money(usd)}`,
  };
}

/**
 * The CEILING for a scrape, not a prediction.
 *
 * A scrape discovers businesses nobody has counted, so the real figure is
 * unknowable up front. What IS knowable is the most it can fetch: cities times
 * the per-city cap. The measured keep-rate is roughly 1 in 7, so the ceiling
 * overstates a typical run by a lot — which is the right direction for a
 * number shown before someone spends money.
 */
export function estimateScrapeCost(
  cities: number,
  perCityCap: number,
  usdPerItem: number,
): CostEstimate {
  const items = Math.max(0, Math.floor(cities || 0)) * Math.max(0, Math.floor(perCityCap || 0));
  const usd = items * usdPerItem;
  return {
    usd, units: items, unitLabel: 'items', vendor: 'apify', isCeiling: true,
    summary: `up to ${items.toLocaleString()} items · at most ${money(usd)}`
      + ` · typically ~1 lead per 7 fetched`,
  };
}

/**
 * Actual spend accumulated during a run, in the shape `scrape_jobs.cost_detail`
 * already uses — so enrichment and verification land beside scraping rather
 * than in a format of their own.
 */
export class RunCost {
  private readonly byVendor = new Map<string, { usd: number; units: number; unitLabel: string }>();

  add(vendor: string, usd: number, units = 1, unitLabel = 'calls'): void {
    const got = this.byVendor.get(vendor);
    const safeUsd = Number.isFinite(usd) && usd > 0 ? usd : 0;
    if (got) {
      got.usd += safeUsd;
      got.units += units;
    } else {
      this.byVendor.set(vendor, { usd: safeUsd, units, unitLabel });
    }
  }

  get totalUsd(): number {
    // Float addition leaves 0.30000000000000004 behind, which renders badly.
    return Math.round([...this.byVendor.values()].reduce((n, v) => n + v.usd, 0) * 1e6) / 1e6;
  }

  get isEmpty(): boolean {
    return this.byVendor.size === 0;
  }

  /** The patch for a scrape_jobs row, or {} when nothing was spent. */
  toJobPatch(unitsFound?: number): Record<string, unknown> {
    if (this.isEmpty) return {};
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    const vendors = [...this.byVendor.entries()]
      .map(([vendor, v]) => ({ vendor, usd: round(v.usd), units: v.units, unitLabel: v.unitLabel }))
      .sort((a, b) => b.usd - a.usd || a.vendor.localeCompare(b.vendor));
    const total = this.totalUsd;
    return {
      cost_usd: total,
      cost_detail: {
        byVendor: vendors,
        usdPerLead: total > 0 && unitsFound && unitsFound > 0 ? round(total / unitsFound) : null,
      },
    };
  }
}
