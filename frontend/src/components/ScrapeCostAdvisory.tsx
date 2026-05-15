import { useEffect, useState } from 'react';
import api from '../api/client';

// Per-page credit cost on ScrapingBee's premium_proxy tier (rounded up).
const CREDITS_PER_LISTING_PAGE = 15;
// Heuristic: TA listing pages average ~3 pages per city before exhausting.
const AVG_PAGES_PER_CITY = 3;

interface Props {
  country: string;
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
  confirmAboveCredits = 5000,
  onGuardReady,
}: Props) {
  const [count, setCount] = useState<number | null>(null);

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

  const estimatedCredits =
    count == null ? null : count * AVG_PAGES_PER_CITY * CREDITS_PER_LISTING_PAGE;

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
  return (
    <p className="text-[12px] text-on-surface-muted">
      ~{count} cities × ~{AVG_PAGES_PER_CITY} pages = ~{estimatedCredits?.toLocaleString()} SB credits (before enrichment)
    </p>
  );
}
