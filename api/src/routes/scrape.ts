import { Router, Request, Response } from 'express';
import { createJob, getJob, getJobs } from '../db/scrape-jobs.js';
import { runScrapeJob, scrapeEvents } from '../services/scrape-runner.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// POST /api/scrape — start a new scrape job
router.post('/', async (req: Request, res: Response) => {
  try {
    const { country, category, minRating = 1.0, maxRating = 3.5, enrich = false, verify = false } = req.body;

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
  const handler = (event: { jobId: string; stage: string; detail: string }) => {
    if (event.jobId === jobId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.stage === 'completed' || event.stage === 'failed') {
        res.end();
      }
    }
  };

  scrapeEvents.on('progress', handler);
  req.on('close', () => scrapeEvents.off('progress', handler));
});

export default router;
