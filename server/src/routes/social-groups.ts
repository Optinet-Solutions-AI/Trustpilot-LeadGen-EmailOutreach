/**
 * Social Groups route — read + status-update for the fb_group_candidates
 * assisted-join queue. The scraper populates the table; this serves the
 * ranked queue to the CRM and lets the operator mark joined/ignored.
 */
import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

const router = Router();

const STATUSES = ['candidate', 'joined', 'ignored'] as const;
type GroupStatus = (typeof STATUSES)[number];

// ── GET /api/social-groups/queue?status=candidate ────────────────────
router.get('/queue', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'candidate';
    if (!STATUSES.includes(status as GroupStatus)) {
      res.status(400).json({ success: false, error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('fb_group_candidates')
      .select('id,platform,group_id,name,member_count_text,is_private,relevance_tier,niche,location,status,first_seen_at,last_seen_at,joined_detected_at')
      .eq('platform', 'facebook')
      .eq('status', status)
      .order('relevance_tier', { ascending: false })
      .order('last_seen_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ success: true, data: data ?? [] });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── PATCH /api/social-groups/queue/:id  body { status } ──────────────
router.patch('/queue/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };
    if (!status || !STATUSES.includes(status as GroupStatus)) {
      res.status(400).json({ success: false, error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const supabase = getSupabase();
    const patch: Record<string, unknown> = { status };
    if (status === 'joined') patch.joined_detected_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('fb_group_candidates')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
