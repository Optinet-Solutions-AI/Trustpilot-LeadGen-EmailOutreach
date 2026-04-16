import { Router, Request, Response } from 'express';
import { verifyDomainDNS } from '../services/dns-checker.js';

const router = Router();

// GET /api/settings/dns-check?domain=example.com
router.get('/dns-check', async (req: Request, res: Response) => {
  const domain = String(req.query.domain ?? '').trim().toLowerCase();
  if (!domain) {
    res.status(400).json({ success: false, error: 'domain query parameter is required' });
    return;
  }
  try {
    const result = await verifyDomainDNS(domain);
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
