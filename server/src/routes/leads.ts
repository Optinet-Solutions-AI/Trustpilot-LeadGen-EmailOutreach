import { Router, Request, Response } from 'express';
import { getLeads, getLeadById, updateLead, bulkUpdateLeads, deleteLead, bulkDeleteLeads } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';
import { sanitizeTrustpilotUrl, validateTrustpilotUrl } from '../services/url-validator.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// GET /api/leads/filters — distinct countries and categories for wizard dropdowns
router.get('/filters', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const [{ data: countryRows }, { data: categoryRows }] = await Promise.all([
      supabase.from('leads').select('country').not('primary_email', 'is', null).not('country', 'is', null),
      supabase.from('leads').select('category').not('primary_email', 'is', null).not('category', 'is', null),
    ]);
    const countries = [...new Set((countryRows || []).map((r: { country: string }) => r.country).filter(Boolean))].sort();
    const categories = [...new Set((categoryRows || []).map((r: { category: string }) => r.category).filter(Boolean))].sort();
    res.json({ success: true, data: { countries, categories } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/leads — paginated + filterable
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await getLeads({
      status: req.query.status as string,
      country: req.query.country as string,
      category: req.query.category as string,
      search: req.query.search as string,
      minRating: req.query.minRating ? parseFloat(req.query.minRating as string) : undefined,
      maxRating: req.query.maxRating ? parseFloat(req.query.maxRating as string) : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 25,
      sortBy: req.query.sortBy as string | undefined,
      sortDir: req.query.sortDir === 'asc' ? 'asc' : 'desc',
      hasEmail: req.query.hasEmail === 'true',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/leads/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const lead = await getLeadById(param(req.params.id));
    res.json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/:id
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    // If status is changing, auto-log activity
    if (req.body.outreach_status) {
      const current = await getLeadById(param(req.params.id));
      if (current.outreach_status !== req.body.outreach_status) {
        await createNote(param(req.params.id), {
          type: 'status_change',
          content: `Status changed from ${current.outreach_status} to ${req.body.outreach_status}`,
          metadata: {
            old_status: current.outreach_status,
            new_status: req.body.outreach_status,
          },
        });
      }
    }

    const lead = await updateLead(param(req.params.id), req.body);
    res.json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/:id/dismiss-flag — user reviewed a flagged URL and confirmed
// it's actually fine. Resets link_status to VALID and stamps last_validated_at.
router.patch('/:id/dismiss-flag', async (req: Request, res: Response) => {
  try {
    const lead = await updateLead(param(req.params.id), {
      link_status: 'VALID',
      last_validated_at: new Date().toISOString(),
      link_validation_error: null,
    });
    res.json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/:id/url — manual URL correction. Sanitizes the input,
// triggers an immediate background re-validation, and writes the resulting
// link_status atomically with the URL change.
router.patch('/:id/url', async (req: Request, res: Response) => {
  try {
    const raw = typeof req.body?.trustpilot_url === 'string' ? req.body.trustpilot_url : '';
    const cleaned = sanitizeTrustpilotUrl(raw);
    if (!cleaned) {
      res.status(400).json({ success: false, error: 'trustpilot_url is missing or unsalvageable' });
      return;
    }

    // Optimistically write the cleaned URL with status=UNKNOWN so the UI
    // unblocks immediately, then revalidate without blocking the response.
    const optimistic = await updateLead(param(req.params.id), {
      trustpilot_url: cleaned,
      link_status: 'UNKNOWN',
      last_validated_at: null,
      link_validation_error: null,
    });
    res.json({ success: true, data: optimistic });

    // Fire-and-forget revalidation. Errors here are non-fatal — the row
    // will simply stay UNKNOWN until the next ingestion pass.
    validateTrustpilotUrl(cleaned)
      .then(({ status, error }) =>
        updateLead(param(req.params.id), {
          link_status: status,
          last_validated_at: new Date().toISOString(),
          link_validation_error: error,
        }),
      )
      .catch((e) => console.error('[leads] background revalidate failed', e));
  } catch (err) {
    if (res.headersSent) return;
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/leads/check-links — bulk re-validate Trustpilot URLs for the
// given lead IDs. Runs validateTrustpilotUrl with bounded concurrency so a
// 200-lead batch doesn't blow past Cloud Run's 300s request timeout, then
// writes link_status / last_validated_at / link_validation_error per row.
router.post('/check-links', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'ids (non-empty array) is required' });
      return;
    }

    const supabase = getSupabase();
    const { data: rows, error: fetchErr } = await supabase
      .from('leads')
      .select('id, trustpilot_url')
      .in('id', ids);
    if (fetchErr) throw new Error(fetchErr.message);

    const targets = (rows || []).filter((r): r is { id: string; trustpilot_url: string } =>
      Boolean(r.trustpilot_url),
    );

    // Concurrency cap — Trustpilot rate-limits aggressive crawlers and we
    // don't want to burn the whole request budget on one batch.
    const CONCURRENCY = 8;
    const counts = { valid: 0, flagged_dead: 0, flagged_removed: 0, unknown: 0 };
    const now = new Date().toISOString();

    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const i = cursor++;
        const target = targets[i];
        const { status, error } = await validateTrustpilotUrl(target.trustpilot_url);
        if (status === 'VALID') counts.valid++;
        else if (status === 'FLAGGED_DEAD') counts.flagged_dead++;
        else if (status === 'FLAGGED_REMOVED') counts.flagged_removed++;
        else counts.unknown++;

        await supabase
          .from('leads')
          .update({
            link_status: status,
            last_validated_at: now,
            link_validation_error: error,
          })
          .eq('id', target.id);
      }
    });
    await Promise.all(workers);

    res.json({
      success: true,
      data: { checked: targets.length, skipped: ids.length - targets.length, ...counts },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// DELETE /api/leads/bulk — bulk delete (must come before /:id).
// Used by the "Delete Selected Flagged Leads" UI; deletion is ALWAYS user-
// triggered, never automatic, even for FLAGGED_DEAD / FLAGGED_REMOVED rows.
router.delete('/bulk', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'ids (non-empty array) is required' });
      return;
    }
    const deleted = await bulkDeleteLeads(ids);
    res.json({ success: true, data: { deleted } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await deleteLead(param(req.params.id));
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/bulk — bulk update
router.patch('/bulk', async (req: Request, res: Response) => {
  try {
    const { ids, patch } = req.body;
    if (!ids || !Array.isArray(ids) || !patch) {
      res.status(400).json({ success: false, error: 'ids (array) and patch (object) are required' });
      return;
    }
    const data = await bulkUpdateLeads(ids, patch);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
