import { Router, Request, Response } from 'express';
import { getLeads, getLeadById, updateLead, bulkUpdateLeads, deleteLead } from '../db/leads.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';

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
