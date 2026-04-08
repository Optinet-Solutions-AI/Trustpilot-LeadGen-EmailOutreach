import { Router, Request, Response } from 'express';
import { createJob, getJob, getJobs } from '../db/scrape-jobs.js';
import { getFailuresByJob, getUnresolvedFailures, markResolved } from '../db/scrape-failures.js';
import { runScrapeJob, cancelScrapeJob, scrapeEvents } from '../services/scrape-runner.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// POST /api/scrape — start a new scrape job
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      country, category,
      minRating = 1.0, maxRating = 3.5,
      enrich = false, verify = false,
      forceRescrape = false,
    } = req.body;

    if (!country || !category) {
      res.status(400).json({ success: false, error: 'country and category are required' });
      return;
    }

    const job = await createJob({
      country,
      category,
      min_rating: minRating,
      max_rating: maxRating,
      enrich,
      verify,
    });

    // Fire scraper asynchronously (don't await)
    runScrapeJob({
      jobId: job.id,
      country,
      category,
      minRating,
      maxRating,
      enrich,
      verify,
      forceRescrape,
    });

    res.json({ success: true, data: { jobId: job.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/scrape — list recent scrape jobs
router.get('/', async (_req: Request, res: Response) => {
  try {
    const jobs = await getJobs();
    res.json({ success: true, data: jobs });
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
  try {
    const job = await getJob(jobId);
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
  req.on('close', () => scrapeEvents.off('progress', handler));
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
