export interface ScrapeParams {
  country: string;
  category: string;
  minRating: number;
  maxRating: number;
  enrich: boolean;
  verify: boolean;
  forceRescrape: boolean;
}

export interface ScrapeJob {
  id: string;
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
