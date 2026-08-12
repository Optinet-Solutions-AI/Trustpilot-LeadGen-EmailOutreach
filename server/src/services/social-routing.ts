/** Routing decisions for social-platform scrape jobs, extracted as pure
 *  functions so scrape-runner stays thin and these stay unit-testable. */
const SOCIAL_PLATFORMS = new Set(['facebook', 'instagram']);

/** Does a Facebook job actually open a browser? Discovery via Apify plus
 *  stub enrichment is pure HTTP, so it carries none of the Linux
 *  fingerprint risk that motivated the refusal below. Both default to the
 *  browserless mode, matching the Python defaults in facebook.py. */
export function facebookJobUsesBrowser(env: Record<string, string | undefined>): boolean {
  const discovery = (env.FB_DISCOVERY || 'apify').trim().toLowerCase();
  const enrich = (env.FB_ENRICH || 'stub').trim().toLowerCase();
  return discovery !== 'apify' || enrich !== 'stub';
}

/**
 * Default search phrase for a Facebook CONSUMER-mode job when the operator
 * didn't supply one.
 *
 * Intent-shaped, NOT geo-stuffed. Measured 2026-08-03 on live Apify data
 * (open-feed post search, 20 results): the old geo-stuffed phrasing
 * "looking for a plumber in Manchester" returned 0 usable consumer asks out of
 * 20 — every hit was an advert — while intent phrasing such as
 * "need a plumber recommendation" returned genuine consumer asks. Query
 * phrasing is the single biggest lever on cost per lead, so geography stays in
 * the `location` filter (which still scopes groups/country and the Gemini
 * location match) rather than being stuffed into the query text.
 *
 * The frontend has its own copy of this shape in
 * frontend/src/components/ScrapeForm.tsx (`defaultFbQuery`) because it cannot
 * import server code — keep the two identical.
 */
export function defaultFbConsumerQuery(niche = '', location = ''): string {
  const n = niche.trim().replace(/\s+/g, ' ');
  if (n) return `need a ${n} recommendation`;
  // No niche at all: nothing intent-shaped to build, so fall back to the bare
  // location rather than emitting "need a recommendation", which matches
  // nothing useful. run.py still requires a non-empty query for search-posts.
  return location.trim().replace(/\s+/g, ' ');
}

/** Is this Facebook job in consumer (post-author) mode rather than business
 *  (Page-owner) mode? The two dispatch through completely different Python
 *  entry points, so this single predicate is the authority for BOTH the
 *  dispatch in scrape-runner and the Linux browser guard below — if the two
 *  ever disagree, a browser-driven job can slip past the guard.
 *
 *  An absent or blank `lead_type` counts as CONSUMERS, mirroring
 *  facebook.py, which reads `(filters.get('lead_type') or 'consumers')` in
 *  both `scrape_listing` and `search_posts`. Anything explicitly other than
 *  'consumers' (including 'businesses') is treated as non-consumer and
 *  therefore browser-bound — the safe direction. */
export function isFacebookConsumerJob(filters: unknown): boolean {
  const leadType = (filters ?? {}) as Record<string, unknown>;
  const raw = leadType.lead_type;
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value === '' || value === 'consumers';
}

/** Does this scrape job actually open a browser on the worker that runs it?
 *
 *  Only Facebook CONSUMER mode can be browserless (Apify discovery + stub
 *  enrichment is pure HTTP). Facebook BUSINESS mode dispatches
 *  `--action list` → `_sync_scrape_pages` and `--action enrich` →
 *  `_sync_enrich_pages`, both of which call `_claim_or_raise()` and
 *  `_open_session()` unconditionally and never consult FB_DISCOVERY /
 *  FB_ENRICH — so it is always browser-driven, whatever those are set to.
 *  Every other platform (Instagram included) is browser-driven too. */
export function scrapeJobUsesBrowser(
  platform: string,
  filters: unknown,
  env: Record<string, string | undefined>,
): boolean {
  if (platform !== 'facebook') return true;
  if (!isFacebookConsumerJob(filters)) return true;
  return facebookJobUsesBrowser(env);
}

export function shouldRefuseSocialOnLinux(
  platform: string,
  osPlatform: NodeJS.Platform | string,
  opts: { usesBrowser?: boolean } = {},
): boolean {
  if (!SOCIAL_PLATFORMS.has(platform) || osPlatform !== 'linux') return false;
  // Defaults to true: a caller that does not know whether a browser is
  // involved gets the old, safe behaviour.
  return opts.usesBrowser ?? true;
}

export function socialProfileEnv(platform: string, socialAccountId?: string | null): Record<string, string> {
  if (!socialAccountId) return {};
  if (platform === 'facebook') return { FB_PROFILE_DIR: `C:\\fb-profiles\\${socialAccountId}` };
  if (platform === 'instagram') return { IG_PROFILE_DIR: `C:\\ig-profiles\\${socialAccountId}` };
  return {};
}
