import { useEffect, useState } from 'react';
import api from '../api/client';

// Per-page credit cost on ScrapingBee's premium_proxy tier (rounded up).
const CREDITS_PER_LISTING_PAGE = 15;
// Server-side default: scrape-runner walks the top-10 cities and pulls 1
// listing page from each (see runScrapeJobViaRunPy in scrape-runner.ts).
// Kept in sync with the runner's `max_cities` / `max_pages_per_city`
// defaults — change both together. 2026-05-20: lowered from 3 → 1 page
// and capped fan-out to 10 cities after measuring 9-min/780-credit US
// scrapes that returned ~2 hotels.
const MAX_CITIES_DEFAULT = 10;
const AVG_PAGES_PER_CITY = 1;

interface Props {
  country: string;
  /**
   * Which backend will actually fetch the listings. On `openai` no
   * ScrapingBee credit is spent at all, so quoting a credit figure would be
   * plainly wrong — the run is priced in dollars instead.
   */
  listingSource?: string;
  /** Threshold above which the user is asked to confirm before submitting. */
  confirmAboveCredits?: number;
  /** Called with a function the parent uses to gate submission. */
  onGuardReady: (guard: () => Promise<boolean>) => void;
}

/**
 * Renders a tiny advisory line above the Start button when the TripAdvisor
 * platform is selected:
 *
 *   ~487 cities x ~3 pages = ~22,005 ScrapingBee credits (before enrichment)
 *
 * Exposes a `guard()` to the parent that resolves false (block submit) if
 * the user declines the high-cost confirmation dialog.
 */
export default function ScrapeCostAdvisory({
  country,
  listingSource,
  confirmAboveCredits = 5000,
  onGuardReady,
}: Props) {
  const [count, setCount] = useState<number | null>(null);
  // Resolved from the server rather than passed in, so the advisory is right
  // the moment the env var flips — no redeploy, and no prop threaded through
  // a form that has no reason to know about scraping backends.
  const [source, setSource] = useState<string | undefined>(listingSource);

  useEffect(() => {
    if (listingSource) { setSource(listingSource); return; }
    let cancelled = false;
    api.get('/scrape/platforms')
      .then((res) => {
        if (cancelled) return;
        const list = (res.data?.data ?? []) as Array<{ name?: string; listing_source?: string }>;
        setSource(list.find((p) => p.name === 'tripadvisor')?.listing_source);
      })
      .catch(() => { /* fall through to the credit estimate */ });
    return () => { cancelled = true; };
  }, [listingSource]);

  useEffect(() => {
    let cancelled = false;
    if (!country) { setCount(null); return; }
    api.get(`/tripadvisor/cities?country=${encodeURIComponent(country)}`)
      .then((res) => {
        if (!cancelled) setCount(res.data?.data?.count ?? 0);
      })
      .catch(() => { if (!cancelled) setCount(0); });
    return () => { cancelled = true; };
  }, [country]);

  // Effective fan-out = min(seeded cities, server-side cap). Reflects what
  // the scrape will actually walk so the operator sees a realistic budget.
  const effectiveCities = count == null ? null : Math.min(count, MAX_CITIES_DEFAULT);
  const estimatedCredits =
    effectiveCities == null ? null : effectiveCities * AVG_PAGES_PER_CITY * CREDITS_PER_LISTING_PAGE;

  useEffect(() => {
    onGuardReady(async () => {
      if (estimatedCredits == null || estimatedCredits < confirmAboveCredits) return true;
      const msg = `This scrape fans out across ${count} cities and may consume up to ~${estimatedCredits.toLocaleString()} ScrapingBee credits before profile enrichment.\n\nContinue?`;
      return window.confirm(msg);
    });
  }, [estimatedCredits, count, confirmAboveCredits, onGuardReady]);

  if (count == null) return null;
  if (count === 0) {
    return (
      <p className="text-[12px] text-red-600 dark:text-red-400">
        No seeded cities for {country}. Run <code>seed_tripadvisor_cities.py --country {country}</code> first.
      </p>
    );
  }
  // The openai source touches ScrapingBee not at all, so a credit figure
  // would be plainly wrong. It is metered in dollars instead — measured
  // 2026-09-24 at roughly $0.07-0.085 per confirmed lead, bounded per job by
  // OPENAI_MAX_SPEND_PER_JOB.
  if (source === 'openai') {
    return (
      <p className="text-[12px] text-on-surface-muted">
        Top {effectiveCities} of {count} cities, billed to OpenAI at roughly
        $0.07–0.09 per lead — no ScrapingBee credits. Each run stops at its
        spend limit and reports what it cost.
      </p>
    );
  }

  return (
    <p className="text-[12px] text-on-surface-muted">
      Top {effectiveCities} of {count} cities × {AVG_PAGES_PER_CITY} page
      {AVG_PAGES_PER_CITY === 1 ? '' : 's'} = ~{estimatedCredits?.toLocaleString()} SB credits
      (stops early if 50 leads collected).
    </p>
  );
}
