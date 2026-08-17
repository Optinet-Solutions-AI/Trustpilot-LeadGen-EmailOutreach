/**
 * Scrape body shape per platform.
 *
 * Trustpilot keeps its legacy flat shape (country/category/minRating/maxRating)
 * for backwards compatibility with the existing form, hooks, and any callers
 * that pre-date multi-platform support. TripAdvisor uses the new {platform,
 * filters} envelope because its filters don't map onto the Trustpilot shape.
 *
 * ScrapeContext.startScrape inspects `platform` and translates each variant
 * to the right POST /api/scrape body shape. The backend accepts both.
 */
export interface TrustpilotScrapeParams {
  platform?: 'trustpilot';   // optional — undefined treated as 'trustpilot'
  country: string;
  category: string;
  minRating: number;
  maxRating: number;
  enrich: boolean;
  verify: boolean;
  forceRescrape: boolean;
}

export interface TripAdvisorScrapeParams {
  platform: 'tripadvisor';
  country: string;
  category: 'hotels' | 'restaurants' | 'attractions';
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  forceRescrape: boolean;
}

export interface YelpScrapeParams {
  platform: 'yelp';
  country: string;
  category: string;          // free-form Yelp category slug (plumbers, restaurants, ...)
  min_rating: number;
  max_rating: number;
  min_review_count: number;  // Yelp-specific: don't outreach businesses with too few reviews to act on
  include_unrated?: boolean;  // Yelp-specific: keep listings Yelp has no rating for at all
  enrich: boolean;
  verify: boolean;
  forceRescrape: boolean;
}

export interface FacebookScrapeParams {
  platform: 'facebook';
  lead_type: 'consumers' | 'businesses';
  // Consumer mode (group-first flow). Niche + location get
  // concatenated server-side for the groups discovery query;
  // each discovered group is then searched for posts matching
  // 'looking for a <niche>'.
  niche?: string;
  location?: string;
  // Legacy single-query field, still accepted for back-compat
  // (the Python plugin falls back to it when niche is empty).
  query?: string;
  // Escape hatch: setting groups_only=false reverts to the
  // legacy open-feed search (kept for debugging).
  groups_only?: boolean;
  // Business mode
  category?: string;
  country?: string;
  // Shared
  enrich: boolean;
  verify: boolean;
  forceRescrape: boolean;
}

export type ScrapeParams = TrustpilotScrapeParams | TripAdvisorScrapeParams | YelpScrapeParams | FacebookScrapeParams;

export interface ScrapeJob {
  id: string;
  platform?: string;
  country: string;
  category: string;
  /** Platform-specific filters jsonb. For non-Trustpilot platforms, the
   *  authoritative country/category live here — the top-level columns
   *  carry placeholders like '_yelp_' / 'all'. */
  filters?: Record<string, unknown> | null;
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed';
  total_found: number;
  total_scraped: number;
  total_enriched: number;
  total_verified: number;
  total_failed: number;
  total_skipped: number;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  // Last ~30 PROGRESS events emitted during the scrape (migration 042).
  // Persisted by scrape-runner.ts so the polling fallback can render Live
  // Activity even when the API Gateway swallows the SSE stream. Each
  // entry: {stage, detail, ts}. ActiveScrapeCard merges these into its
  // local progress buffer on every poll, deduped by timestamp.
  recent_events?: Array<{ stage: string; detail: string; ts: string }>;
}

export interface ScrapeProgress {
  jobId: string;
  stage: string;
  detail: string;
  timestamp?: string;
}
