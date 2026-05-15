import { Router, Request, Response } from 'express';
import { countActiveCitiesForCountry } from '../db/tripadvisor-cities.js';

const router = Router();
const param = (v: string | string[] | undefined): string => Array.isArray(v) ? v[0] : (v ?? '');

// GET /api/tripadvisor/cities?country=US — count of seeded, active cities.
// Used by the Scrape form to size the credit-cost advisory.
router.get('/cities', async (req: Request, res: Response) => {
  try {
    const country = param(req.query.country as string | string[] | undefined).toUpperCase();
    if (!country) {
      res.status(400).json({ success: false, error: 'country query parameter required' });
      return;
    }
    const count = await countActiveCitiesForCountry(country);
    res.json({ success: true, data: { country, count } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
