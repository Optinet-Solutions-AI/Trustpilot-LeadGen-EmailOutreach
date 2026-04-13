import { Router, Request, Response } from 'express';
import { checkForReplies } from '../services/reply-tracker.js';
import { checkForBounces } from '../services/bounce-tracker.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { config } from '../config.js';

const router = Router();

// POST /api/gmail/check-replies — manually trigger reply check
router.post('/check-replies', async (_req: Request, res: Response) => {
  try {
    if (config.emailMode !== 'gmail') {
      res.json({ success: true, data: { repliesFound: 0, message: 'Reply tracking only active in gmail mode' } });
      return;
    }
    const result = await checkForReplies();
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/gmail/check-bounces — manually trigger bounce check
// Scans sender account(s) inbox for unread mailer-daemon delivery failure notifications.
router.post('/check-bounces', async (_req: Request, res: Response) => {
  try {
    if (config.emailMode !== 'gmail') {
      res.json({ success: true, data: { bouncesFound: 0, message: 'Bounce tracking only active in gmail mode' } });
      return;
    }
    const result = await checkForBounces();
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/gmail/rate-limit — current rate limit status
router.get('/rate-limit', (_req: Request, res: Response) => {
  res.json({ success: true, data: rateLimiter.getStatus() });
});

export default router;
