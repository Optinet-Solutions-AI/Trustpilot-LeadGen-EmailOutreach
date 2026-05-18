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
  enrich: boolean;
  verify: boolean;
  forceRescrape: boolean;
}

export type ScrapeParams = TrustpilotScrapeParams | TripAdvisorScrapeParams | YelpScrapeParams;

export interface ScrapeJob {
  id: string;
  platform?: string;
  country: string;
  category: string;
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
}

export interface ScrapeProgress {
  jobId: string;
  stage: string;
  detail: string;
  timestamp?: string;
}
