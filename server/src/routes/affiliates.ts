import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

const router = Router();

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

export default router;
