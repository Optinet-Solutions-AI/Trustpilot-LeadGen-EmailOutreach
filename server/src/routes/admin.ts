/**
 * Admin routes — cron-triggered maintenance endpoints. Auth happens at
 * the global authMiddleware (x-api-key header == config.apiSecretKey),
 * so Cloud Scheduler is configured to send that header at job creation
 * time. Mounted under /api/admin so it's clearly off the user-facing
 * surface even though the auth model is identical.
 */

import { Router, Request, Response } from 'express';
import { runScreenshotCleanup } from '../services/screenshot-cleanup.js';

const router = Router();

// POST /api/admin/cleanup-screenshots — orphan + age sweep over the
// Supabase Storage `screenshots` bucket. Idempotent; safe to retry.
router.post('/cleanup-screenshots', async (_req: Request, res: Response) => {
  try {
    const summary = await runScreenshotCleanup();
    res.json({ success: true, data: summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
