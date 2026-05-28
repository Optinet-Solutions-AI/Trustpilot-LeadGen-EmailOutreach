import { Router, Request, Response } from 'express';
import { createJob, getJob, getJobs, findActiveJobForParams, resolveDuplicateActiveJob, deleteJob, deleteEmptyJobs } from '../db/scrape-jobs.js';
import { getFailuresByJob, getUnresolvedFailures, markResolved } from '../db/scrape-failures.js';
import { runScrapeJob, cancelScrapeJob, scrapeEvents } from '../services/scrape-runner.js';
import { listCategories, listCountries, getMaxLastSeen } from '../db/taxonomy.js';
import {
  startOrAttachDiscovery,
  getAnyActiveDiscovery,
  type TaxonomyProgressEvent,
} from '../services/taxonomy-discovery.js';
import { config } from '../config.js';
import { getSupabase } from '../lib/supabase.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// Source-of-truth registry of supported platforms. Mirrors
// tools/scraper/platforms/__init__.py — if you add a Python plugin,
// add its manifest here too. We mirror in TS rather than shelling out
// to Python at every /platforms call to keep the endpoint cheap.
interface PlatformManifest {
  name: string;
  label: string;
  base_url: string;
  filter_schema: Array<Record<string, unknown>>;
  requires_proxy: boolean;
  // Social platforms (Facebook, Instagram) declare these so the
  // frontend can render the post-search variant of the form instead
  // of the category-picker variant.
  supports_post_search?: boolean;
  supports_group_search?: boolean;
}
const PLATFORM_MANIFESTS: PlatformManifest[] = [
  {
    name: 'trustpilot',
    label: 'Trustpilot',
    base_url: 'https://www.trustpilot.com',
    requires_proxy: false,
    filter_schema: [
      { name: 'country',    type: 'select', label: 'Country',    required: true,  options_source: 'taxonomy:countries' },
      { name: 'category',   type: 'select', label: 'Category',   required: true,  options_source: 'taxonomy:categories' },
      { name: 'min_rating', type: 'number', label: 'Min rating', required: false, default: 1.0, min: 1.0, max: 5.0, step: 0.1 },
      { name: 'max_rating', type: 'number', label: 'Max rating', required: false, default: 3.5, min: 1.0, max: 5.0, step: 0.1 },
    ],
  },
  {
    name: 'tripadvisor',
    label: 'TripAdvisor',
    base_url: 'https://www.tripadvisor.com',
    // CF + fingerprinting blocks Cloud Run / EC2 source IPs reliably.
    // The frontend uses this flag to nudge the operator toward local-mode.
    requires_proxy: true,
    filter_schema: [
      { name: 'country',    type: 'select', label: 'Country',    required: true,  options_source: 'taxonomy:countries' },
      { name: 'category',   type: 'select', label: 'Category',   required: true,
        options: [
          { value: 'hotels',      label: 'Hotels' },
          { value: 'restaurants', label: 'Restaurants' },
          { value: 'attractions', label: 'Attractions' },
        ] },
      { name: 'min_rating', type: 'number', label: 'Min rating', required: false, default: 1.0, min: 1.0, max: 5.0, step: 0.5 },
      { name: 'max_rating', type: 'number', label: 'Max rating', required: false, default: 3.0, min: 1.0, max: 5.0, step: 0.5 },
    ],
  },
  {
    name: 'yelp',
    label: 'Yelp',
    base_url: 'https://www.yelp.com',
    // PerimeterX blocks Cloud Run / EC2 IPs on /, /search, and /biz pages.
    // Listing routes through the free Fusion API (YELP_API_KEY) but profile
    // enrichment still needs ScrapingBee stealth_proxy from any IP, so we
    // surface the local-mode hint to operators.
    requires_proxy: true,
    filter_schema: [
      { name: 'country',          type: 'select', label: 'Country',         required: true,  options_source: 'taxonomy:countries' },
      { name: 'category',         type: 'select', label: 'Category',        required: true,  options_source: 'taxonomy:categories' },
      { name: 'max_rating',       type: 'number', label: 'Max rating',      required: false, default: 3.5, min: 1.0, max: 5.0, step: 0.5 },
      { name: 'min_rating',       type: 'number', label: 'Min rating',      required: false, default: 1.0, min: 1.0, max: 5.0, step: 0.5 },
      { name: 'min_review_count', type: 'number', label: 'Min review count',required: false, default: 5,   min: 1,   max: 1000, step: 1 },
    ],
  },
  {
    name: 'facebook',
    label: 'Facebook',
    base_url: 'https://www.facebook.com',
    requires_proxy: true,
    supports_post_search: true,
    supports_group_search: true,
    filter_schema: [
      { name: 'lead_type', type: 'select', label: 'Lead type', required: true,
        default: 'consumers',
        options: [
          { value: 'consumers',  label: 'People asking for a service (post authors)' },
          { value: 'businesses', label: 'Businesses in a niche (page owners)' },
        ] },
      // Consumer-mode fields
      { name: 'query',        type: 'text',    label: 'Keyword / phrase' },
      { name: 'groups_only',  type: 'boolean', label: 'Search inside groups only', default: false },
      { name: 'date_from',    type: 'text',    label: 'Date from (YYYY-MM-DD)' },
      { name: 'date_to',      type: 'text',    label: 'Date to (YYYY-MM-DD)' },
      // Business-mode fields
      { name: 'category',     type: 'text',    label: 'Page category (slug)' },
      { name: 'country',      type: 'select',  label: 'Country', options_source: 'taxonomy:countries' },
    ],
  },
  {
    name: 'instagram',
    label: 'Instagram',
    base_url: 'https://www.instagram.com',
    requires_proxy: true,
    supports_post_search: true,
    supports_group_search: false,
    filter_schema: [
      { name: 'lead_type', type: 'select', label: 'Lead type', required: true,
        default: 'consumers',
        options: [
          { value: 'consumers',  label: 'People posting under a hashtag (post authors)' },
          { value: 'businesses', label: 'Business profiles by category (explore feed)' },
        ] },
      { name: 'query',    type: 'text', label: 'Hashtag (without #)' },
      { name: 'category', type: 'text', label: 'Explore category' },
    ],
  },
];
const KNOWN_PLATFORMS = new Set(PLATFORM_MANIFESTS.map(p => p.name));

// GET /api/scrape/platforms — registry of supported platforms.
// Drives the frontend platform picker; static at deploy time.
router.get('/platforms', (_req: Request, res: Response) => {
  res.json({ success: true, data: PLATFORM_MANIFESTS });
});

// GET /api/scrape/taxonomy[?platform=...] — categories + countries for the form pickers
router.get('/taxonomy', async (req: Request, res: Response) => {
  try {
    const platform = param((req.query.platform as string | string[] | undefined) ?? 'trustpilot');
    if (!KNOWN_PLATFORMS.has(platform)) {
      res.status(400).json({ success: false, error: `Unknown platform '${platform}'` });
      return;
    }
    const [categories, countries, lastSeenAt] = await Promise.all([
      listCategories(platform),
      listCountries(platform),
      getMaxLastSeen(platform),
    ]);
    // Always serve fresh. The previous max-age=300 cached stale data across
    // the Refresh roundtrip — users saw "No results" for newly-discovered
    // slugs even after a refresh because the browser still held the old body.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { platform, categories, countries, lastSeenAt } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET|POST /api/scrape/taxonomy/refresh[?platform=...] — SSE stream that
// re-runs discovery. GET so EventSource can attach; the underlying
// discovery is single-flight per-platform so re-hitting it never
// double-fires for the same target.
//
// Trustpilot uses the legacy discover_taxonomy.py script directly;
// every other platform routes through run.py --action discover-taxonomy
// (see taxonomy-discovery.ts).
const taxonomyRefreshHandler = async (req: Request, res: Response) => {
  const platform = param((req.query.platform as string | string[] | undefined) ?? 'trustpilot');
  if (!KNOWN_PLATFORMS.has(platform)) {
    res.status(400).json({ success: false, error: `Unknown platform '${platform}'` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { run, isNew } = startOrAttachDiscovery(platform);

  // Replay any progress already buffered so a late-joining client doesn't miss
  // events emitted before its EventSource was attached.
  for (const event of run.events) {
    res.write(`data: ${JSON.stringify({ ...event, replay: true })}\n\n`);
  }
  if (!isNew) {
    res.write(`data: ${JSON.stringify({ stage: 'attached', detail: 'already-in-flight' })}\n\n`);
  }

  const onProgress = (event: TaxonomyProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const onDone = (result: { categories: number; countries: number }) => {
    res.write(
      `data: ${JSON.stringify({ stage: 'done', detail: `${result.categories}|${result.countries}` })}\n\n`,
    );
    setTimeout(() => { try { res.end(); } catch { /* ignore */ } }, 500);
  };
  const onError = (err: Error) => {
    res.write(`data: ${JSON.stringify({ stage: 'error', detail: err.message })}\n\n`);
    setTimeout(() => { try { res.end(); } catch { /* ignore */ } }, 500);
  };

  run.on('progress', onProgress);
  run.once('done', onDone);
  run.once('error', onError);

  req.on('close', () => {
    run.off('progress', onProgress);
    run.off('done', onDone);
    run.off('error', onError);
  });
};
router.get('/taxonomy/refresh', taxonomyRefreshHandler);
router.post('/taxonomy/refresh', taxonomyRefreshHandler);

// GET /api/scrape/taxonomy/status — lightweight peek at in-flight discovery.
// Reports the first active platform run; multi-platform parallel runs can
// be observed by hitting /taxonomy/refresh?platform=... directly.
router.get('/taxonomy/status', async (_req: Request, res: Response) => {
  const active = getAnyActiveDiscovery();
  res.json({
    success: true,
    data: {
      running: !!active,
      platform: active?.platform ?? null,
      startedAt: active?.startedAt ?? null,
      lastEvent: active?.events[active.events.length - 1] ?? null,
    },
  });
});

// POST /api/scrape — start a new scrape job.
//
// Accepts two body shapes:
//
//   NEW  (multi-platform):
//     { platform: 'trustpilot', filters: { country, category, min_rating, max_rating, enrich?, verify? }, forceRescrape? }
//
//   LEGACY (Trustpilot-only, pre-migration-032 callers):
//     { country, category, minRating?, maxRating?, enrich?, verify?, forceRescrape? }
//
// The legacy shape is normalized to the new shape with platform='trustpilot'.
// Non-Trustpilot platforms currently return 501 — scrape-runner needs the
// platform-aware spawn branch added in Phase 5 before they can actually execute.
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const platform = (body.platform as string | undefined)?.toLowerCase() ?? 'trustpilot';

    // Pull filters either from the new envelope or from the legacy top-level
    // fields. camelCase-or-snake-case both accepted on the way in; we
    // normalize to snake_case internally because that matches the DB columns
    // and the Python plugin's filter_schema.
    const rawFilters = (body.filters as Record<string, unknown> | undefined) ?? {};
    const country   = (rawFilters.country   ?? body.country)   as string | undefined;
    const category  = (rawFilters.category  ?? body.category)  as string | undefined;
    const minRating = Number(rawFilters.min_rating ?? body.minRating ?? 1.0);
    const maxRating = Number(rawFilters.max_rating ?? body.maxRating ?? 3.5);
    const enrich    = Boolean(rawFilters.enrich ?? body.enrich ?? false);
    const verify    = Boolean(rawFilters.verify ?? body.verify ?? false);
    const forceRescrape = Boolean(body.forceRescrape);

    if (!KNOWN_PLATFORMS.has(platform)) {
      res.status(400).json({ success: false, error: `Unknown platform '${platform}'` });
      return;
    }

    // Per-platform required-filter validation. Trustpilot wants country +
    // category; TripAdvisor wants location_id + location_slug + listing_type.
    // The plugin manifest declares the same requirements — we mirror them
    // here so the API rejects bad inputs before queueing a doomed job.
    if (platform === 'trustpilot') {
      if (!country || !category) {
        res.status(400).json({ success: false, error: 'country and category are required for trustpilot' });
        return;
      }
    } else if (platform === 'tripadvisor') {
      const taCountry = (rawFilters.country ?? body.country) as string | undefined;
      const taCategory = (rawFilters.category ?? body.category) as string | undefined;
      if (!taCountry || !taCategory) {
        res.status(400).json({
          success: false,
          error: 'tripadvisor requires country and category',
        });
        return;
      }
      if (!['hotels', 'restaurants', 'attractions'].includes(taCategory)) {
        res.status(400).json({
          success: false,
          error: `category must be one of: hotels, restaurants, attractions`,
        });
        return;
      }
      // Reject if there are no seeded cities for this country — without them
      // the fan-out would produce zero leads. The operator must run
      // tools/scraper/seed_tripadvisor_cities.py --country XX first.
      const { countActiveCitiesForCountry } = await import('../db/tripadvisor-cities.js');
      const cityCount = await countActiveCitiesForCountry(taCountry.toUpperCase());
      if (cityCount === 0) {
        res.status(400).json({
          success: false,
          error: `No seeded cities for country ${taCountry}. Run tools/scraper/seed_tripadvisor_cities.py --country ${taCountry} first.`,
        });
        return;
      }
    }

    // Block duplicate scrape unless forceRescrape is explicitly set.
    // Dedup is scoped by platform so a Trustpilot run and a TripAdvisor
    // run on the same country+category don't collide. Non-Trustpilot
    // platforms don't have a (country, category) tuple in scrape_jobs,
    // so we skip the job-level dedup for them — lead-level dedup at the
    // (platform, profile_url) presence still prevents row duplication on
    // re-scrape.
    if (!forceRescrape && platform === 'trustpilot' && country && category) {
      const existing = await findActiveJobForParams(country, category, platform);
      if (existing) {
        res.status(409).json({
          success: false,
          error: `A scrape for "${category}" in ${country} is already running. Wait for it to finish or cancel it first.`,
          data: { existingJobId: existing.id },
        });
        return;
      }
    }

    // Build the filters envelope per platform. Trustpilot still mirrors
    // country/category/min/max to top-level columns so the legacy schema
    // and the existing UI both keep working. Non-Trustpilot platforms
    // store everything inside `filters` and leave the legacy columns null.
    const platformFilters: Record<string, unknown> = platform === 'trustpilot'
      ? {
          country,
          category,
          min_rating: minRating,
          max_rating: maxRating,
          enrich,
          verify,
        }
      : platform === 'tripadvisor'
      ? {
          country:    String((rawFilters.country  ?? body.country)  ?? '').toUpperCase(),
          category:   String((rawFilters.category ?? body.category) ?? ''),
          min_rating: minRating,
          max_rating: maxRating,
          enrich,
          verify,
        }
      : {
          // Non-review platforms (Facebook, Instagram) submit their filters
          // flat at the top level of the body (lead_type, query, date_from,
          // ...). Earlier versions only read body.filters and silently
          // dropped everything, so the spawned Python received an empty
          // filters object and crashed on missing 'query'.
          //
          // Pick up every non-control field from the body, then layer
          // body.filters on top so the explicit envelope wins ties.
          ...Object.fromEntries(
            Object.entries(body).filter(([k]) =>
              !['platform', 'forceRescrape', 'filters', 'enrich', 'verify'].includes(k),
            ),
          ),
          ...(rawFilters as Record<string, unknown>),
          enrich,
          verify,
        };

    const job = await createJob({
      // For TripAdvisor we mirror country + category to the top-level columns
      // so the Recent Jobs UI shows "US — hotels" the same way Trustpilot does.
      country: platform === 'trustpilot'
        ? (country as string)
        : platform === 'tripadvisor'
          ? String(platformFilters.country)
          : `_${platform}_`,
      category: platform === 'trustpilot'
        ? (category as string)
        : platform === 'tripadvisor'
          ? String(platformFilters.category)
          : (rawFilters.listing_type as string ?? 'all'),
      min_rating: minRating,
      max_rating: maxRating,
      enrich,
      verify,
      source: 'manual',
      platform,
      filters: platformFilters,
    });

    // Resolve races where multiple POSTs all passed the pre-insert dedup check
    // (common when a user clicks Start Scrape several times while the page is
    // still loading). Only applies to Trustpilot today — non-Trustpilot
    // platforms don't have (country, category) dedup; the lead-level
    // (platform, profile_url) presence is the real dedup key.
    if (!forceRescrape && platform === 'trustpilot' && country && category) {
      const winnerId = await resolveDuplicateActiveJob(job.id, country, category, platform);
      if (winnerId !== job.id) {
        res.status(409).json({
          success: false,
          error: `A scrape for "${category}" in ${country} is already running. Redirecting to the existing job.`,
          data: { existingJobId: winnerId },
        });
        return;
      }
    }

    if (config.useRemoteWorker) {
      // Social platforms (Facebook, Instagram) can only run on a host
      // that has (a) Google Chrome installed and (b) the operator's
      // social_account cookies on disk. The Cloud Run container has
      // neither — Playwright Chromium isn't the same binary that
      // undetected-chromedriver needs, and cookies live in the
      // operator's local Supabase session_store. Letting the EC2
      // worker grab the job and crash on a stale-code traceback was
      // the previous failure mode (see jobs with worker_id=ec2-sg-1
      // returning `Script exited with code 1` on FB consumer mode).
      //
      // Fail fast with a clear message instead. The job row is still
      // created (so the operator sees it in the history with a
      // helpful error) but no worker will try to run it.
      const isSocial = platform === 'facebook' || platform === 'instagram';
      if (isSocial) {
        const reason =
          `${platform === 'facebook' ? 'Facebook' : 'Instagram'} scrapes must be ` +
          `run from the operator's local machine (http://localhost:3001). The Cloud Run ` +
          `host doesn't carry the social-account session cookies the scraper needs. ` +
          `Open the local app and re-submit this scrape there.`;
        try {
          await getSupabase()
            .from('scrape_jobs')
            .update({
              status: 'failed',
              worker_id: 'cloudrun-blocked',
              claimed_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              error: reason,
              last_error: reason,
            })
            .eq('id', job.id);
        } catch (e) {
          console.warn('[Scrape] could not mark social job as blocked:', e instanceof Error ? e.message : e);
        }
        res.status(409).json({ success: false, error: reason, data: { jobId: job.id, platform } });
        return;
      }

      // Remote-worker mode: the row stays status='pending' and the EC2 worker
      // claims it within ~30s via claim_next_pending_scrape_job. Nothing else
      // to do here. SSE progress for the manual scrape page will degrade to
      // status polling until the worker can stream events back.
      console.log(`[Scrape] enqueued ${platform} job=${job.id} (remote worker will pick up)`);
    } else {
      // Inline mode: fire scraper asynchronously on THIS server. Pre-claim
      // the row with worker_id='local-inline' BEFORE we fire so the EC2
      // worker's claim RPC (which polls every ~30s) sees the row is taken
      // and skips it. Without this, EC2 can win a 50ms race against us on
      // first POST and run the job remotely — where it has neither the
      // social account cookies nor the latest code.
      try {
        await getSupabase()
          .from('scrape_jobs')
          .update({ worker_id: 'local-inline', claimed_at: new Date().toISOString() })
          .eq('id', job.id)
          .is('worker_id', null);
      } catch (e) {
        console.warn('[Scrape] pre-claim failed, EC2 may race us:', e instanceof Error ? e.message : e);
      }
      runScrapeJob({
        jobId: job.id,
        country: country ?? '',
        category: category ?? '',
        minRating,
        maxRating,
        enrich,
        verify,
        forceRescrape,
        platform,
        filters: platformFilters,
      });
    }

    res.json({ success: true, data: { jobId: job.id, platform } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/scrape — list recent scrape jobs. Supports ?limit, ?offset,
// ?platform for pagination + per-platform filtering in the UI.
// Response shape: { success: true, data: { rows, total } }. Backwards-
// compatible with the old shape (data: ScrapeJob[]) is impossible without
// a route version bump, so the frontend ScrapeContext.fetchJobs reads
// data.rows / data.total directly.
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(param(req.query.limit as string), 10) : undefined;
    const offset = req.query.offset ? parseInt(param(req.query.offset as string), 10) : undefined;
    const platform = req.query.platform ? param(req.query.platform as string) : undefined;
    const result = await getJobs({
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      platform,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/scrape/:id/status — SSE stream of scrape progress
router.get('/:id/status', async (req: Request, res: Response) => {
  const jobId = param(req.params.id);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current job status
  let lastStatus: string | null = null;
  let lastFound = -1;
  let lastScraped = -1;
  try {
    const job = await getJob(jobId);
    lastStatus = job.status;
    lastFound = job.total_found ?? 0;
    lastScraped = job.total_scraped ?? 0;
    res.write(`data: ${JSON.stringify({ stage: 'current', ...job })}\n\n`);

    if (job.status === 'completed' || job.status === 'failed') {
      res.end();
      return;
    }
  } catch {
    res.write(`data: ${JSON.stringify({ stage: 'error', detail: 'Job not found' })}\n\n`);
    res.end();
    return;
  }

  // Listen for progress events
  const handler = (event: { jobId: string; stage: string; detail: string; timestamp?: string }) => {
    if (event.jobId === jobId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.stage === 'completed' || event.stage === 'failed') {
        // Delay res.end() to ensure the final message flushes to the client
        // before the connection closes (prevents race condition with EventSource)
        setTimeout(() => {
          try { res.end(); } catch {}
        }, 1000);
      }
    }
  };

  scrapeEvents.on('progress', handler);

  // DB-poll fallback for jobs running on remote workers (EC2). The
  // in-process EventEmitter only fires for jobs executed on THIS API
  // instance; an EC2-claimed job updates the DB row but never pings the
  // emitter here, so SSE clients would see nothing until they reconnect.
  // Poll the row every 2.5s and synthesize a 'current' event when status
  // or counts change. Cheap (one row by PK) and bounded by req.on('close').
  const dbPoll = setInterval(async () => {
    try {
      const job = await getJob(jobId);
      const changed =
        job.status !== lastStatus ||
        (job.total_found ?? 0) !== lastFound ||
        (job.total_scraped ?? 0) !== lastScraped;
      if (changed) {
        lastStatus = job.status;
        lastFound = job.total_found ?? 0;
        lastScraped = job.total_scraped ?? 0;
        res.write(`data: ${JSON.stringify({ stage: 'current', ...job })}\n\n`);
      }
      if (job.status === 'completed' || job.status === 'failed') {
        // Mirror the terminal-event close timing used by the EventEmitter
        // path so the final 'current' event flushes before res.end().
        setTimeout(() => {
          try { res.end(); } catch {}
        }, 1000);
        clearInterval(dbPoll);
      }
    } catch {
      // transient supabase error — try again next tick
    }
  }, 2500);

  req.on('close', () => {
    scrapeEvents.off('progress', handler);
    clearInterval(dbPoll);
  });
});

// POST /api/scrape/:id/cancel — cancel a running scrape job
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const jobId = param(req.params.id);
    await cancelScrapeJob(jobId);
    res.json({ success: true, data: { message: 'Job cancelled' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/scrape/cleanup-empty — delete non-running jobs whose (country, category) has 0 leads
router.post('/cleanup-empty', async (_req: Request, res: Response) => {
  try {
    const deleted = await deleteEmptyJobs();
    res.json({
      success: true,
      data: {
        deletedCount: deleted.length,
        deleted: deleted.map(d => ({ id: d.id, country: d.country, category: d.category })),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// DELETE /api/scrape/:id — remove a scrape job row from the Recent Jobs list
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const jobId = param(req.params.id);
    const job = await getJob(jobId);
    if (job.status === 'running') {
      res.status(400).json({ success: false, error: 'Cancel the job before deleting it.' });
      return;
    }
    await deleteJob(jobId);
    res.json({ success: true, data: { message: 'Job deleted' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/scrape/:id/failures — list failures for a job
router.get('/:id/failures', async (req: Request, res: Response) => {
  try {
    const jobId = param(req.params.id);
    const failures = await getFailuresByJob(jobId);
    res.json({ success: true, data: failures });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/scrape/:id/retry-failed — retry unresolved failures
router.post('/:id/retry-failed', async (req: Request, res: Response) => {
  try {
    const jobId = param(req.params.id);
    const failures = await getUnresolvedFailures(jobId);

    if (failures.length === 0) {
      res.json({ success: true, data: { message: 'No unresolved failures to retry', retried: 0 } });
      return;
    }

    // Get original job to inherit params
    const job = await getJob(jobId);

    // Create a new retry job
    const retryJob = await createJob({
      country: job.country,
      category: job.category,
      min_rating: job.min_rating,
      max_rating: job.max_rating,
      enrich: job.enrich,
      verify: job.verify,
      source: 'manual',
    });

    // Mark old failures as resolved
    await markResolved(failures.map((f: { id: string }) => f.id));

    // Build retry leads from profile/website failures
    const profileFailures = failures.filter((f: { stage: string }) => f.stage === 'profile');
    const websiteFailures = failures.filter((f: { stage: string }) => f.stage === 'website');

    // Run retry job with force rescrape (skip dedup since these are known failures)
    runScrapeJob({
      jobId: retryJob.id,
      country: job.country,
      category: job.category,
      minRating: job.min_rating,
      maxRating: job.max_rating,
      enrich: websiteFailures.length > 0,
      verify: false,
      forceRescrape: true,
    });

    res.json({
      success: true,
      data: {
        retryJobId: retryJob.id,
        retried: failures.length,
        profileFailures: profileFailures.length,
        websiteFailures: websiteFailures.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
