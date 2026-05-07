/**
 * REST routes for the discovered_contacts review queue.
 *
 *   GET  /api/discovered-contacts                 — review queue (Prospects view)
 *   GET  /api/discovered-contacts/count           — pending count (sidebar badge)
 *   GET  /api/leads/:leadId/discovered-contacts   — per-lead pending list (LeadDetail banner)
 *   POST /api/discovered-contacts/:id/accept      — accept candidate; promotes email to leads.discovered_email
 *   POST /api/discovered-contacts/:id/dismiss     — dismiss candidate
 *   POST /api/discovered-contacts/:id/spawn-lead  — for kind='url': create a new lead from scrape_result
 */

import { Router, Request, Response } from 'express';
import {
  listForReview,
  listPendingByLead,
  acceptContact,
  dismissContact,
  spawnLeadFromUrl,
  overrideVerificationStatus,
  countPending,
  type DiscoveredKind,
  type DiscoveredStatus,
  type DiscoveredVerification,
} from '../db/discovered-contacts.js';

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

function pickReviewer(req: Request): string | undefined {
  // Auth middleware sets req.user when an API key resolves to one. Falls back
  // to the API-key header so the audit row at least records a stable token.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (req as any).user as { email?: string; sub?: string } | undefined;
  if (user?.email) return user.email;
  if (user?.sub) return user.sub;
  const headerKey = req.header('x-api-key');
  return headerKey ? `apikey:${headerKey.slice(0, 6)}` : undefined;
}

// GET /api/discovered-contacts?status=pending|accepted|all&kind=email|url&limit=&offset=
// Pass status=all to fetch every lifecycle state — used by the Prospects
// page which shows pending + accepted + spawned together as one list.
router.get('/', async (req: Request, res: Response) => {
  try {
    const statusRaw = (req.query.status as string | undefined) ?? 'pending_review';
    const status = (statusRaw === 'all' ? 'all' : statusRaw) as DiscoveredStatus | 'all';
    const kind = req.query.kind as DiscoveredKind | undefined;
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);

    const result = await listForReview({
      status,
      kind,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/discovered-contacts/count — sidebar badge count
router.get('/count', async (_req: Request, res: Response) => {
  try {
    const count = await countPending();
    res.json({ success: true, data: { pending: count } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/discovered-contacts/:id/accept
router.post('/:id/accept', async (req: Request, res: Response) => {
  try {
    const id = param(req.params.id);
    const result = await acceptContact(id, { reviewedBy: pickReviewer(req) });
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/discovered-contacts/:id/dismiss
router.post('/:id/dismiss', async (req: Request, res: Response) => {
  try {
    const id = param(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = await dismissContact(id, { reviewedBy: pickReviewer(req), reason });
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/discovered-contacts/:id/spawn-lead — kind='url' only
router.post('/:id/spawn-lead', async (req: Request, res: Response) => {
  try {
    const id = param(req.params.id);
    const result = await spawnLeadFromUrl(id, { reviewedBy: pickReviewer(req) });
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

// POST /api/discovered-contacts/:id/override-status
// Body: { verification_status: 'valid' | 'invalid' | 'catch-all' | 'unknown' }
// User-initiated override of the layered validator's verdict, useful when
// Hunter.io (last-resort fallback) returns a wrong `invalid`. If the contact
// is already accepted, propagates the new status to leads.discovered_email_status
// and rebuilds primary_email.
router.post('/:id/override-status', async (req: Request, res: Response) => {
  try {
    const id = param(req.params.id);
    const status = req.body?.verification_status as DiscoveredVerification;
    const allowed = ['valid', 'invalid', 'catch-all', 'unknown', null];
    if (!allowed.includes(status as never)) {
      res.status(400).json({ success: false, error: 'verification_status must be one of valid|invalid|catch-all|unknown|null' });
      return;
    }
    const result = await overrideVerificationStatus(id, status, { reviewedBy: pickReviewer(req) });
    res.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

// GET /api/leads/:leadId/discovered-contacts — pending list for LeadDetail banner
// (Mounted under /api/leads in server.ts so the path matches the existing
//  per-lead nested-resource pattern alongside notes / follow-ups.)
const leadRouter = Router();
leadRouter.get('/:leadId/discovered-contacts', async (req: Request, res: Response) => {
  try {
    const rows = await listPendingByLead(param(req.params.leadId));
    res.json({ success: true, data: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export { leadRouter as leadDiscoveredContactsRouter };
export default router;
