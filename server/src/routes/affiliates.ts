import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.js';
import { createRegistry, newJob, runLinkCheckJob } from '../services/link-check-job.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// Per-process registry — separate from leads' so the same jobId can't collide.
const linkCheckRegistry = createRegistry();

// GET /api/affiliates — fetch all, ordered by created_at asc
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await getSupabase()
      .from('affiliates')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/affiliates — insert a new affiliate
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, tp_url, website, warning, reviews, rating, geo } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }

    const { data, error } = await getSupabase()
      .from('affiliates')
      .insert({
        name: name.trim(),
        description: description?.trim() ?? null,
        tp_url: tp_url?.trim() ?? null,
        website: website?.trim() ?? null,
        warning: Boolean(warning),
        reviews: reviews != null ? Number(reviews) : null,
        rating: rating != null ? Number(rating) : null,
        geo: Array.isArray(geo) ? geo : [],
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/affiliates/:id — partial update (editable fields only)
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, tp_url, website, warning, reviews, rating, geo } = req.body;

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = String(name).trim();
    if (description !== undefined) patch.description = description == null ? null : String(description).trim();
    if (tp_url !== undefined) patch.tp_url = tp_url == null ? null : String(tp_url).trim();
    if (website !== undefined) patch.website = website == null ? null : String(website).trim();
    if (warning !== undefined) patch.warning = Boolean(warning);
    if (reviews !== undefined) patch.reviews = reviews == null || reviews === '' ? null : Number(reviews);
    if (rating !== undefined) patch.rating = rating == null || rating === '' ? null : Number(rating);
    if (geo !== undefined) patch.geo = Array.isArray(geo) ? geo : [];

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ success: false, error: 'no editable fields provided' });
      return;
    }

    const { data, error } = await getSupabase()
      .from('affiliates')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/affiliates/bulk-delete — delete multiple affiliates by id array
router.post('/bulk-delete', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
      return;
    }

    const { error } = await getSupabase()
      .from('affiliates')
      .delete()
      .in('id', ids);

    if (error) throw error;
    res.json({ success: true, data: { deleted: ids.length } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/affiliates/reset-link-flags — admin escape hatch to wipe stale
// link_status verdicts. Mirrors the leads route. Useful after a validator
// policy change (the previous strict policy mass-flagged Cloudflare-blocked
// pages as DEAD); resetting to VALID lets the next Validate Links run
// repopulate from the corrected verdict ladder.
router.post('/reset-link-flags', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error, count } = await supabase
      .from('affiliates')
      .update(
        { link_status: 'VALID', last_validated_at: null, link_validation_error: null },
        { count: 'exact' },
      )
      .neq('link_status', 'VALID');
    if (error) throw new Error(error.message);
    res.json({ success: true, data: { reset: count ?? 0 } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/affiliates/check-links/status?jobId=xxx — polling fallback ────
router.get('/check-links/status', (req: Request, res: Response) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'jobId required' });
    return;
  }
  const job = linkCheckRegistry.jobs.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      status: job.status === 'completed' ? 'done' : job.status,
      total: job.total,
      checked: job.checked,
      valid: job.valid,
      flagged_dead: job.flagged_dead,
      flagged_removed: job.flagged_removed,
      unknown: job.unknown,
      ...(job.error ? { error: job.error } : {}),
    },
  });
});

// ── GET /api/affiliates/check-links/:jobId/stream — SSE progress ──────────
router.get('/check-links/:jobId/stream', (req: Request, res: Response) => {
  const jobId = param(req.params.jobId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const job = linkCheckRegistry.jobs.get(jobId);
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

  const handler = (event: { jobId: string; stage: string; detail: string; timestamp?: string }) => {
    if (event.jobId === jobId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.stage === 'completed' || event.stage === 'failed') {
        setTimeout(() => { try { res.end(); } catch { /* already closed */ } }, 1000);
      }
    }
  };

  linkCheckRegistry.events.on('progress', handler);
  req.on('close', () => linkCheckRegistry.events.off('progress', handler));
});

// POST /api/affiliates/check-links — kick off background validation job.
router.post('/check-links', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'ids (non-empty array) is required' });
      return;
    }

    const jobId = randomUUID();
    linkCheckRegistry.jobs.set(jobId, newJob());

    res.json({ success: true, data: { jobId, total: ids.length } });

    runLinkCheckJob(jobId, 'affiliates', ids, linkCheckRegistry).catch((e) => {
      console.error(`[affiliates/check-links] job ${jobId} crashed`, e);
    });
  } catch (err) {
    if (res.headersSent) return;
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
