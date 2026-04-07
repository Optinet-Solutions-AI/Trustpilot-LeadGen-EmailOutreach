import { Router, Request, Response } from 'express';
import { getNotes, createNote } from '../db/notes.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// GET /api/leads/:leadId/notes
router.get('/:leadId/notes', async (req: Request, res: Response) => {
  try {
    const notes = await getNotes(param(req.params.leadId));
    res.json({ success: true, data: notes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/leads/:leadId/notes
router.post('/:leadId/notes', async (req: Request, res: Response) => {
  try {
    const { type = 'note', content, metadata } = req.body;
    if (!content) {
      res.status(400).json({ success: false, error: 'content is required' });
      return;
    }
    const note = await createNote(param(req.params.leadId), { type, content, metadata });
    res.json({ success: true, data: note });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
