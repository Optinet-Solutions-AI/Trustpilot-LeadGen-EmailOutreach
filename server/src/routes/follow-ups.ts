import { Router, Request, Response } from 'express';
import { getFollowUps, createFollowUp, completeFollowUp } from '../db/follow-ups.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// GET /api/follow-ups — upcoming follow-ups (dashboard)
router.get('/', async (req: Request, res: Response) => {
  try {
    const upcoming = req.query.upcoming === 'true';
    const followUps = await getFollowUps({ upcoming });
    res.json({ success: true, data: followUps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/leads/:leadId/follow-ups
router.get('/:leadId/follow-ups', async (req: Request, res: Response) => {
  try {
    const followUps = await getFollowUps({ leadId: param(req.params.leadId) });
    res.json({ success: true, data: followUps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/leads/:leadId/follow-ups
router.post('/:leadId/follow-ups', async (req: Request, res: Response) => {
  try {
    const { dueDate, note } = req.body;
    if (!dueDate) {
      res.status(400).json({ success: false, error: 'dueDate is required' });
      return;
    }
    const followUp = await createFollowUp({
      lead_id: param(req.params.leadId),
      due_date: dueDate,
      note,
    });
    res.json({ success: true, data: followUp });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/follow-ups/:id/complete
router.patch('/:id/complete', async (req: Request, res: Response) => {
  try {
    const followUp = await completeFollowUp(param(req.params.id));
    res.json({ success: true, data: followUp });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
