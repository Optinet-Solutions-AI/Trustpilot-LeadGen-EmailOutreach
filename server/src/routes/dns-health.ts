import { Router, Request, Response } from 'express';
import { checkDomainHealth } from '../services/dns-checker.js';

const router = Router();

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// GET /api/dns-health/:domain — MX + SPF + DMARC for an arbitrary domain
router.get('/:domain', async (req: Request, res: Response) => {
  const raw = String(req.params.domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  if (!raw || !DOMAIN_RE.test(raw)) {
    res.status(400).json({ success: false, error: `"${req.params.domain}" is not a valid domain.` });
    return;
  }

  try {
    const result = await checkDomainHealth(raw);
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
