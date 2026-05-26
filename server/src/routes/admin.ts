/**
 * Admin routes — cron-triggered maintenance endpoints. Auth happens at
 * the global authMiddleware (x-api-key header == config.apiSecretKey),
 * so Cloud Scheduler is configured to send that header at job creation
 * time. Mounted under /api/admin so it's clearly off the user-facing
 * surface even though the auth model is identical.
 */

import { Router, Request, Response } from 'express';
import { runScreenshotCleanup } from '../services/screenshot-cleanup.js';
import { postAlert } from '../services/duplicate-send-monitor.js';

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

// POST /api/admin/test-duplicate-monitor — fires a synthetic alert through
// every configured channel (DUPLICATE_SEND_MONITOR_EMAIL,
// DUPLICATE_SEND_MONITOR_WEBHOOK_URL). Used to verify the alert path is
// wired up end-to-end without inserting fake lead_notes (which would
// violate the unique partial indexes from migration 040 anyway). Safe to
// run as often as needed — no DB writes, no side effects beyond the alert.
router.post('/test-duplicate-monitor', async (_req: Request, res: Response) => {
  const syntheticDuplicates = [{
    key: 'synthetic-test|synthetic-test|2',
    lead_id: '00000000-0000-0000-0000-000000000000',
    campaign_id: '00000000-0000-0000-0000-000000000000',
    step_number: '2',
    sends: 3,
    first_send: new Date(Date.now() - 8000).toISOString(),
    last_send: new Date().toISOString(),
  }];
  try {
    const result = await postAlert(syntheticDuplicates);
    res.json({
      success: true,
      data: {
        message: 'Synthetic alert fired. Check your configured channels.',
        delivered: result,
        configured: {
          email: !!process.env.DUPLICATE_SEND_MONITOR_EMAIL,
          webhook: !!process.env.DUPLICATE_SEND_MONITOR_WEBHOOK_URL,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
