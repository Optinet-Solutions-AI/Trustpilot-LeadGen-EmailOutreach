import { Router, Request, Response } from 'express';
import { RunCost, estimateEnrichCost } from '../services/run-cost.js';
import { openaiEnrichEnabled, maxCallsPerRun } from '../services/scrapers/tier10-openai.js';
import { getSupabase } from '../lib/supabase.js';
import { enrichLeads, type EnrichableLead } from '../services/scrapers/website-enricher.js';
import { scrapeEvents, translateEnricherEvent } from '../services/scrape-runner.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

/**
 * Build the job-row counters for a finished enrichment chunk.
 *
 * Kept pure and exported so the accounting is testable. The completion block
 * used to write `total_failed: dbFailed` — *database write* failures, which
 * are all but always 0 — on top of the live count of leads that produced no
 * email. Every `completed` chunk therefore reported failed=0, and a finished
 * run could not say how many leads came back empty; recovering that for one
 * day's 73 chunks meant reading the driver's own state file.
 *
 * The three counters are meant to add up to the items processed:
 *   total_enriched + total_failed + total_skipped
 * A `dbFailed` — an email found and then LOST on write — is the one outcome
 * that must never be silent, so it goes in `error`.
 */
export function summariseEnrichmentRun(
  results: Array<{ foundEmail: string | null; redirectsTo?: string }>,
  counts: { successful: number; noEmail: number; dbFailed: number },
): { total_enriched: number; total_failed: number; total_skipped: number; error?: string } {
  const redirectOnly = results.filter((r) => r.redirectsTo && !r.foundEmail).length;
  return {
    total_enriched: counts.successful,
    total_failed: counts.noEmail,
    total_skipped: redirectOnly,
    ...(counts.dbFailed > 0
      ? { error: `${counts.dbFailed} lead row write(s) failed — email found but not saved` }
      : {}),
  };
}

// Sentinel value used in scrape_jobs to identify enrichment-only jobs
const ENRICH_SENTINEL = '_enrich_';

/**
 * GET /api/enrich/estimate?leads=N
 *
 * What this enrichment will cost, BEFORE it runs. Enrichment can be priced up
 * front because the work is known — a list of leads — unlike a scrape, which
 * discovers businesses nobody has counted.
 *
 * Returns 0 when the paid tier is off, which is the honest answer rather than
 * a guess at credits nobody is paying for: every tier before 10 is free or
 * running on a dead account.
 */
router.get('/estimate', (req: Request, res: Response) => {
  const leads = Number(req.query.leads ?? 0);
  if (!Number.isFinite(leads) || leads < 0) {
    return res.status(400).json({ success: false, error: 'leads must be a non-negative number' });
  }
  const estimate = estimateEnrichCost(leads, {
    openAiEnabled: openaiEnrichEnabled(),
    maxCalls: maxCallsPerRun(),
  });
  return res.json({ success: true, data: estimate });
});

// ── GET /api/enrich/status?jobId=xxx ─────────────────────────────────────────
router.get('/status', async (req: Request, res: Response) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'jobId query param required' });
    return;
  }

  const supabase = getSupabase();
  const { data: job } = await supabase
    .from('scrape_jobs')
    .select('id, status, total_found, total_enriched, total_failed, total_skipped, error, last_heartbeat_at')
    .eq('id', jobId)
    .eq('country', ENRICH_SENTINEL)
    .single();

  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found or expired' });
    return;
  }

  res.json({
    success: true,
    data: {
      jobId,
      status: job.status === 'completed' ? 'done' : job.status === 'failed' ? 'failed' : 'running',
      total: job.total_found ?? 0,
      found: job.total_enriched ?? 0,
      failed: job.total_failed ?? 0,
      // Redirect-only outcomes: a redirect target was resolved but no email
      // came from it. Counted separately so found + failed + skipped accounts
      // for every item processed, instead of the remainder vanishing.
      skipped: job.total_skipped ?? 0,
      // Surfaced so the frontend stall detector can use the worker's
      // heartbeat (refreshed every ~20s) instead of relying on counter
      // changes — slow websites can hold the enricher for 60-90s without
      // any counter movement, which was tripping a false "stuck" banner.
      last_heartbeat_at: job.last_heartbeat_at ?? null,
      ...(job.error ? { error: job.error } : {}),
    },
  });
});

// ── GET /api/enrich/:id/stream — SSE stream of enrichment progress ───────────
// Mirrors /api/scrape/:id/status: subscribes to the shared scrapeEvents emitter
// filtered by jobId, so the frontend log panel works identically for enrich
// jobs and scrape jobs.
router.get('/:id/stream', async (req: Request, res: Response) => {
  const jobId = param(req.params.id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Initial snapshot
  try {
    const supabase = getSupabase();
    const { data: job } = await supabase
      .from('scrape_jobs')
      .select('id, status, total_found, total_enriched, total_failed, error, started_at, completed_at')
      .eq('id', jobId)
      .eq('country', ENRICH_SENTINEL)
      .single();

    if (!job) {
      res.write(`data: ${JSON.stringify({ stage: 'error', detail: 'Job not found' })}\n\n`);
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({ stage: 'current', ...job })}\n\n`);

    if (job.status === 'completed' || job.status === 'failed') {
      res.end();
      return;
    }
  } catch {
    res.write(`data: ${JSON.stringify({ stage: 'error', detail: 'Job lookup failed' })}\n\n`);
    res.end();
    return;
  }

  const handler = (event: { jobId: string; stage: string; detail: string; timestamp?: string }) => {
    if (event.jobId === jobId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.stage === 'completed' || event.stage === 'failed') {
        setTimeout(() => { try { res.end(); } catch {} }, 1000);
      }
    }
  };

  scrapeEvents.on('progress', handler);
  req.on('close', () => scrapeEvents.off('progress', handler));
});

// ── POST /api/enrich — start enrichment job using in-process TS enricher ─────
router.post('/', async (req: Request, res: Response) => {
  try {
    const { leadIds, concurrency: rawConcurrency } = req.body;
    // Clamp to [1, 5] so the laptop doesn't get overwhelmed when called
    // from a local owner-run enrich. Default stays 3 to preserve the
    // existing cloud behavior for callers that don't pass it.
    const concurrency = Math.max(1, Math.min(Number(rawConcurrency) || 3, 5));
    const supabase = getSupabase();

    // Fetch leads that need enrichment
    let query = supabase
      .from('leads')
      .select('id, company_name, trustpilot_url, website_url, trustpilot_email, website_email, primary_email, phone, country, category, star_rating')
      .not('website_url', 'is', null);

    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      query = query.in('id', leadIds);
    } else {
      query = query.is('website_email', null);
    }

    const { data: leads, error } = await query;
    if (error) throw new Error(error.message);

    if (!leads || leads.length === 0) {
      res.json({ success: true, data: { jobId: null, total: 0, message: 'No leads need enrichment' } });
      return;
    }

    // Persist job in Supabase so status survives Cloud Run restarts
    const { data: jobRow, error: jobError } = await supabase
      .from('scrape_jobs')
      .insert({
        country: ENRICH_SENTINEL,
        category: ENRICH_SENTINEL,
        min_rating: 0,
        max_rating: 5,
        enrich: true,
        verify: false,
        status: 'running',
        total_found: leads.length,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (jobError) throw new Error(jobError.message);

    const jobId = jobRow.id;

    // Respond immediately — enrichment runs in background
    res.json({
      success: true,
      data: { jobId, total: leads.length, message: `Enrichment started for ${leads.length} leads` },
    });

    // ── Background execution: in-process, no subprocess, no stdout parsing ──
    // Heartbeat keeps the orphan reaper from false-flagging long-but-healthy
    // enrich runs. Without it, jobs get marked failed at started_at + 2 min
    // even when the enricher is happily chewing through ScrapingBee fallbacks.
    const HEARTBEAT_INTERVAL_MS = 20_000;
    const heartbeatTimer = setInterval(() => {
      void supabase
        .from('scrape_jobs')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('id', jobId)
        .then(({ error }) => {
          if (error) console.warn(`[enrich] heartbeat failed: ${error.message}`);
        });
    }, HEARTBEAT_INTERVAL_MS);
    // Beat once immediately so a job that dies in the first 20s still has a stamp
    void supabase
      .from('scrape_jobs')
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq('id', jobId);

    (async () => {
      try {
        console.log(`[enrich] Job ${jobId} — starting TS enrichment for ${leads.length} leads`);
        // Announce the phase so the live-log panel on the Leads page lights up
        scrapeEvents.emit('progress', {
          jobId,
          stage: 'enrich_start',
          detail: String(leads.length),
          timestamp: new Date().toISOString(),
        });
        // Live counters so the polling status endpoint reflects real-time
        // progress instead of staying at 0 until the job completes.
        let liveEnriched = 0;
        let liveFailed = 0;

        // Index leads by id so the inline event handler can look up
        // primary_email when deciding what to write to the row.
        const leadsById = new Map<string, typeof leads[number]>();
        for (const l of leads) {
          if (l.id) leadsById.set(l.id, l);
        }

        // Per-lead DB writes happen INLINE inside onEvent below. That way
        // partial progress survives if Cloud Run rotates the instance
        // mid-job (deploy, scale-down, OOM): every email already found is
        // already saved, instead of being lost in the worker's in-memory
        // results array waiting for a post-loop batch flush.
        let successful = 0;
        let dbFailed = 0;

        const results = await enrichLeads(leads as EnrichableLead[], {
          concurrency,
          onProgress: (done, totalItems) => {
            scrapeEvents.emit('progress', {
              jobId,
              stage: 'enrich_progress',
              detail: `${done}/${totalItems}`,
              timestamp: new Date().toISOString(),
            });
          },
          onEvent: async (event) => {
            translateEnricherEvent(jobId, event);

            // Inline lead-row write for the two outcomes that produce DB
            // changes (email found, redirect-only detected). Done here so
            // each result is durable as soon as it's known.
            const evLeadId = (event as { leadId?: string }).leadId;
            if (event.type === 'enrich_email' && evLeadId) {
              const lead = leadsById.get(evLeadId);
              const currentPrimary = (lead as { primary_email?: string | null } | undefined)?.primary_email ?? null;
              const update: Record<string, unknown> = {
                primary_email: currentPrimary ?? event.email,
              };
              if (event.source === 'lateral') update.affiliate_email = event.email;
              else                            update.website_email   = event.email;
              if (event.redirectsTo)          update.redirects_to    = event.redirectsTo;

              const { error: updateErr } = await supabase
                .from('leads')
                .update(update)
                .eq('id', evLeadId);
              if (updateErr) {
                console.error(`[enrich] Job ${jobId} — DB write failed for ${evLeadId}: ${updateErr.message}`);
                dbFailed++;
              } else {
                successful++;
              }
            } else if (event.type === 'enrich_redirected' && evLeadId) {
              // Redirect detected but no email surfaced from the
              // destination. Save the redirect target so the lead appears
              // on the Redirected Leads page; user can flag/approve later.
              const { error: redirErr } = await supabase
                .from('leads')
                .update({ redirects_to: event.redirectsTo })
                .eq('id', evLeadId);
              if (redirErr) {
                console.warn(`[enrich] Job ${jobId} — redirects_to write failed for ${evLeadId}: ${redirErr.message}`);
              }
            }

            let dirty = false;
            if (event.type === 'enrich_email') { liveEnriched++; dirty = true; }
            else if (event.type === 'enrich_no_email' || event.type === 'enrich_failed') { liveFailed++; dirty = true; }
            // enrich_redirected is no longer a failure: even when no email is
            // scraped from the destination, the redirect target itself is
            // useful intel and goes on the Redirected Leads page.
            if (dirty) {
              // Awaited so the latest write reflects the latest counter and
              // we don't get out-of-order overwrites under concurrency.
              const { error } = await supabase
                .from('scrape_jobs')
                .update({ total_enriched: liveEnriched, total_failed: liveFailed })
                .eq('id', jobId);
              if (error) console.warn(`[enrich] live counter update failed: ${error.message}`);
            }
          },
        });

        // Stats only — the actual lead rows were already written inline above.
        const enriched = results.filter((r) => r.foundEmail !== null);
        const redirected = results.filter((r) => r.redirectsTo);
        console.log(`[enrich] Job ${jobId} — enrichment complete, ${enriched.length}/${leads.length} emails found, ${redirected.length} redirected`);

        const summary = summariseEnrichmentRun(results, {
          successful,
          noEmail: liveFailed,
          dbFailed,
        });

        // Vendor spend for this enrichment run. Tier 10 charges per lead
        // ATTEMPTED, so misses are counted too — billing only for hits would
        // understate it by the ~40% that find nothing. Written in the same
        // shape scrapes use, so the Scrape page totals both together.
        const runCost = new RunCost();
        for (const r of results) {
          const spent = (r as { usd?: number }).usd ?? 0;
          if (spent > 0) runCost.add('openai', spent, 1, 'lookups');
        }

        const { error: jobUpdateErr } = await supabase.from('scrape_jobs').update({
          status: 'completed',
          ...summary,
          ...runCost.toJobPatch(successful),
          completed_at: new Date().toISOString(),
        }).eq('id', jobId);

        if (jobUpdateErr) {
          console.error(`[enrich] Job ${jobId} — failed to update job status:`, jobUpdateErr.message);
        }

        // Closing event for any connected SSE streams
        scrapeEvents.emit('progress', {
          jobId,
          stage: 'completed',
          detail: JSON.stringify({
            totalFound: leads.length,
            saved: successful,
            enriched: summary.total_enriched,
            failed: summary.total_failed,
            skipped: summary.total_skipped,
          }),
          timestamp: new Date().toISOString(),
        });

        console.log(`[enrich] Job ${jobId} DONE — attempted: ${leads.length}, scraped: ${enriched.length}, saved: ${successful}, dbFailed: ${dbFailed}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[enrich] Job ${jobId} FAILED:`, message);
        await supabase.from('scrape_jobs').update({
          status: 'failed',
          error: message.slice(0, 500),
          completed_at: new Date().toISOString(),
        }).eq('id', jobId);
        scrapeEvents.emit('progress', {
          jobId,
          stage: 'failed',
          detail: message.slice(0, 200),
          timestamp: new Date().toISOString(),
        });
      } finally {
        clearInterval(heartbeatTimer);
      }
    })();

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
