import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { enrichLeads, type EnrichableLead } from '../services/scrapers/website-enricher.js';
import { scrapeEvents, translateEnricherEvent } from '../services/scrape-runner.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// Sentinel value used in scrape_jobs to identify enrichment-only jobs
const ENRICH_SENTINEL = '_enrich_';

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
    .select('id, status, total_found, total_enriched, total_failed, error')
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
    const { leadIds } = req.body;
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
        const results = await enrichLeads(leads as EnrichableLead[], {
          concurrency: 3,
          onProgress: (done, totalItems) => {
            scrapeEvents.emit('progress', {
              jobId,
              stage: 'enrich_progress',
              detail: `${done}/${totalItems}`,
              timestamp: new Date().toISOString(),
            });
          },
          onEvent: (event) => translateEnricherEvent(jobId, event),
        });

        // Filter to only leads that got a new email
        const enriched = results.filter((r) => r.foundEmail !== null);
        console.log(`[enrich] Job ${jobId} — enrichment complete, ${enriched.length}/${leads.length} emails found`);

        // Strict per-lead DB update with error tracking
        let successful = 0;
        let dbFailed = 0;

        for (const r of enriched) {
          const leadId = (r.lead as { id?: string }).id;
          if (!leadId) {
            console.error(`[enrich] Job ${jobId} — skipping lead with no id: ${r.lead.trustpilot_url}`);
            dbFailed++;
            continue;
          }

          try {
            const { error: updateErr } = await supabase
              .from('leads')
              .update({
                website_email: r.foundEmail,
                // Promote to primary_email if no better primary exists
                primary_email: (r.lead as { primary_email?: string | null }).primary_email ?? r.foundEmail,
              })
              .eq('id', leadId);

            if (updateErr) {
              console.error(`[enrich] Job ${jobId} — DB UPDATE FAILED for ${leadId}: ${updateErr.message}`);
              dbFailed++;
            } else {
              successful++;
            }
          } catch (err) {
            console.error(`[enrich] Job ${jobId} — DB UPDATE THREW for ${leadId}:`, (err as Error).message);
            dbFailed++;
          }
        }

        const { error: jobUpdateErr } = await supabase.from('scrape_jobs').update({
          status: 'completed',
          total_enriched: successful,
          total_failed: dbFailed,
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
            enriched: successful,
            failed: dbFailed,
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
      }
    })();

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
