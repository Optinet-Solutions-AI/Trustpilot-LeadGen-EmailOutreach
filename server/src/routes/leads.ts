import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { getLeads, getLeadById, updateLead, bulkUpdateLeads, deleteLead, bulkDeleteLeads, getLeadIds } from '../db/leads.js';
import { getCampaignLeadsByLead } from '../db/campaigns.js';
import { createNote } from '../db/notes.js';
import { getSupabase } from '../lib/supabase.js';
import { sanitizeTrustpilotUrl, validateTrustpilotUrl, validateTrustpilotUrlViaPlaywright } from '../services/url-validator.js';
import { createRegistry, newJob, runLinkCheckJob } from '../services/link-check-job.js';
import {
  createRegistry as createClaimedRegistry,
  newJob as newClaimedJob,
  runClaimedCheckJob,
} from '../services/claimed-check-job.js';
import { launchBrowser, TIER_CONFIGS } from '../services/scrapers/browser-launcher.js';
import { enqueueBrowseSession, AccountInUseError } from '../db/social-connect-requests.js';
import { resolveLeadAccount, listActiveAccountsForLead, validateAccountForLead } from '../services/lead-account-resolver.js';
import { config } from '../config.js';

// Shared per-process registry — survives across requests so the SSE stream
// can attach to a job that was kicked off by an earlier POST.
const linkCheckRegistry = createRegistry();
const claimedCheckRegistry = createClaimedRegistry();

const router = Router();
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// GET /api/leads/filters — distinct countries and categories for wizard dropdowns
router.get('/filters', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const [{ data: countryRows }, { data: categoryRows }] = await Promise.all([
      supabase.from('leads').select('country').not('primary_email', 'is', null).not('country', 'is', null),
      supabase.from('leads').select('category').not('primary_email', 'is', null).not('category', 'is', null),
    ]);
    const countries = [...new Set((countryRows || []).map((r: { country: string }) => r.country).filter(Boolean))].sort();
    const categories = [...new Set((categoryRows || []).map((r: { category: string }) => r.category).filter(Boolean))].sort();
    res.json({ success: true, data: { countries, categories } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/leads — paginated + filterable
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await getLeads({
      status: req.query.status as string,
      country: req.query.country as string,
      category: req.query.category as string,
      search: req.query.search as string,
      minRating: req.query.minRating ? parseFloat(req.query.minRating as string) : undefined,
      maxRating: req.query.maxRating ? parseFloat(req.query.maxRating as string) : undefined,
      // Per-platform Leads pages pass ?platform=trustpilot|tripadvisor.
      // Empty / omitted = no platform filter (returns leads across all platforms).
      platform: typeof req.query.platform === 'string' && req.query.platform.trim()
        ? (req.query.platform as string).toLowerCase()
        : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 25,
      sortBy: req.query.sortBy as string | undefined,
      sortDir: req.query.sortDir === 'asc' ? 'asc' : 'desc',
      hasEmail: req.query.hasEmail === 'true',
      verificationStatus: ['valid', 'invalid', 'catch-all', 'unknown'].includes(req.query.verificationStatus as string)
        ? (req.query.verificationStatus as 'valid' | 'invalid' | 'catch-all' | 'unknown')
        : undefined,
      redirected: req.query.redirected === 'only' || req.query.redirected === 'exclude' ? req.query.redirected : 'all',
      blocked: req.query.blocked === 'only' || req.query.blocked === 'exclude' ? req.query.blocked : 'all',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/leads/ids — return ID array for all leads matching filters.
// Used by the campaign wizard's "Select all valid" button to grab every
// matching lead across all pages in one round-trip.
router.get('/ids', async (req: Request, res: Response) => {
  try {
    const ids = await getLeadIds({
      status: req.query.status as string,
      country: req.query.country as string,
      category: req.query.category as string,
      search: req.query.search as string,
      minRating: req.query.minRating ? parseFloat(req.query.minRating as string) : undefined,
      maxRating: req.query.maxRating ? parseFloat(req.query.maxRating as string) : undefined,
      platform: typeof req.query.platform === 'string' && req.query.platform.trim()
        ? (req.query.platform as string).toLowerCase()
        : undefined,
      hasEmail: req.query.hasEmail === 'true',
      verificationStatus: ['valid', 'invalid', 'catch-all', 'unknown'].includes(req.query.verificationStatus as string)
        ? (req.query.verificationStatus as 'valid' | 'invalid' | 'catch-all' | 'unknown')
        : undefined,
      redirected: req.query.redirected === 'only' || req.query.redirected === 'exclude' ? req.query.redirected : 'all',
    });
    res.json({ success: true, data: ids, total: ids.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/leads/:id/campaign-leads — this lead's campaign memberships, so the
// Activity timeline can deep-link notes (campaign_id) to the right inbox thread
// (campaign_lead_id). Declared before /:id; the extra path segment means Express
// never matches this under the single-segment /:id route anyway.
router.get('/:id/campaign-leads', async (req: Request, res: Response) => {
  try {
    const data = await getCampaignLeadsByLead(param(req.params.id));
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /api/leads/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const lead = await getLeadById(param(req.params.id));
    res.json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/:id
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    // If status is changing, auto-log activity
    if (req.body.outreach_status) {
      const current = await getLeadById(param(req.params.id));
      if (current.outreach_status !== req.body.outreach_status) {
        await createNote(param(req.params.id), {
          type: 'status_change',
          content: `Status changed from ${current.outreach_status} to ${req.body.outreach_status}`,
          metadata: {
            old_status: current.outreach_status,
            new_status: req.body.outreach_status,
          },
        });
      }
    }

    const lead = await updateLead(param(req.params.id), req.body);
    res.json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/:id/dismiss-flag — user reviewed a flagged URL and confirmed
// it's actually fine. Resets link_status to VALID and stamps last_validated_at.
router.patch('/:id/dismiss-flag', async (req: Request, res: Response) => {
  try {
    const lead = await updateLead(param(req.params.id), {
      link_status: 'VALID',
      last_validated_at: new Date().toISOString(),
      link_validation_error: null,
    });
    res.json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/:id/url — manual URL correction. Sanitizes the input,
// triggers an immediate background re-validation, and writes the resulting
// link_status atomically with the URL change.
router.patch('/:id/url', async (req: Request, res: Response) => {
  try {
    const raw = typeof req.body?.trustpilot_url === 'string' ? req.body.trustpilot_url : '';
    const cleaned = sanitizeTrustpilotUrl(raw);
    if (!cleaned) {
      res.status(400).json({ success: false, error: 'trustpilot_url is missing or unsalvageable' });
      return;
    }

    // Optimistically write the cleaned URL with status=UNKNOWN so the UI
    // unblocks immediately, then revalidate without blocking the response.
    const optimistic = await updateLead(param(req.params.id), {
      trustpilot_url: cleaned,
      link_status: 'UNKNOWN',
      last_validated_at: null,
      link_validation_error: null,
    });
    res.json({ success: true, data: optimistic });

    // Fire-and-forget revalidation. Errors here are non-fatal — the row
    // will simply stay UNKNOWN until the next ingestion pass.
    validateTrustpilotUrl(cleaned)
      .then(({ status, error }) =>
        updateLead(param(req.params.id), {
          link_status: status,
          last_validated_at: new Date().toISOString(),
          link_validation_error: error,
        }),
      )
      .catch((e) => console.error('[leads] background revalidate failed', e));
  } catch (err) {
    if (res.headersSent) return;
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/leads/test-validate — debug helper. Runs the full validator
// pipeline (Playwright → ScrapingBee fallback → plain HTTPS) on a single URL
// and returns the verdict + which path produced it. No DB writes. Used to
// iterate on validator logic without burning a full check-links job.
router.post('/test-validate', async (req: Request, res: Response) => {
  try {
    const { url, mode } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ success: false, error: 'url (string) is required' });
      return;
    }
    const t0 = Date.now();

    if (mode === 'plain') {
      // Force plain-fetch / ScrapingBee path, skip Playwright.
      const result = await validateTrustpilotUrl(url);
      res.json({ success: true, data: { ...result, ms: Date.now() - t0, path: 'no_playwright' } });
      return;
    }

    // Default: Playwright path with internal SB fallback. Spin up a single-use
    // browser since this endpoint doesn't have access to the link-check-job pool.
    const bundle = await launchBrowser(TIER_CONFIGS[2]);
    try {
      const result = await validateTrustpilotUrlViaPlaywright(bundle.context, url);
      res.json({ success: true, data: { ...result, ms: Date.now() - t0, path: 'playwright' } });
    } finally {
      await bundle.context.close().catch(() => undefined);
      await bundle.browser.close().catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/leads/reset-link-flags — admin escape hatch to wipe stale
// link_status verdicts. Useful after a validator policy change (e.g. when
// previous false positives need to be re-checked instead of dismissed
// one-by-one). Resets all flagged leads to VALID; the next Validate Links
// run overwrites with the new validator's verdict.
router.post('/reset-link-flags', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error, count } = await supabase
      .from('leads')
      .update({ link_status: 'VALID', last_validated_at: null, link_validation_error: null }, { count: 'exact' })
      .neq('link_status', 'VALID');
    if (error) throw new Error(error.message);
    res.json({ success: true, data: { reset: count ?? 0 } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── GET /api/leads/check-links/status?jobId=xxx — polling fallback ──────────
router.get('/check-links/status', (req: Request, res: Response) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'jobId required' });
    return;
  }
  const job = linkCheckRegistry.jobs.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      status: job.status === 'completed' ? 'done' : job.status,
      total: job.total,
      checked: job.checked,
      valid: job.valid,
      flagged_dead: job.flagged_dead,
      flagged_removed: job.flagged_removed,
      unknown: job.unknown,
      ...(job.error ? { error: job.error } : {}),
    },
  });
});

// ── GET /api/leads/check-links/:jobId/stream — SSE progress ────────────────
router.get('/check-links/:jobId/stream', (req: Request, res: Response) => {
  const jobId = param(req.params.jobId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const job = linkCheckRegistry.jobs.get(jobId);
  if (!job) {
    res.write(`data: ${JSON.stringify({ stage: 'error', detail: 'Job not found' })}\n\n`);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify({ stage: 'current', ...job })}\n\n`);
  if (job.status === 'completed' || job.status === 'failed') {
    res.end();
    return;
  }

  const handler = (event: { jobId: string; stage: string; detail: string; timestamp?: string }) => {
    if (event.jobId === jobId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.stage === 'completed' || event.stage === 'failed') {
        setTimeout(() => { try { res.end(); } catch { /* already closed */ } }, 1000);
      }
    }
  };

  linkCheckRegistry.events.on('progress', handler);
  req.on('close', () => linkCheckRegistry.events.off('progress', handler));
});

// POST /api/leads/check-links — kick off a background link-validation job.
// Returns the jobId immediately; progress streams over the SSE endpoint.
router.post('/check-links', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'ids (non-empty array) is required' });
      return;
    }

    const jobId = randomUUID();
    linkCheckRegistry.jobs.set(jobId, newJob());

    res.json({ success: true, data: { jobId, total: ids.length } });

    // Background — must not block the response. Errors are caught inside
    // runLinkCheckJob and surfaced through the SSE 'failed' event.
    runLinkCheckJob(jobId, 'leads', ids, linkCheckRegistry).catch((e) => {
      console.error(`[leads/check-links] job ${jobId} crashed`, e);
    });
  } catch (err) {
    if (res.headersSent) return;
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── /api/leads/check-claimed — same shape as /check-links, but the job ─────
// rechecks the Trustpilot "Profile claimed" badge and writes profile_claimed.
// Accepts ids of any length, so per-lead and bulk surfaces share the route.

// GET /api/leads/check-claimed/status?jobId=xxx — polling fallback
router.get('/check-claimed/status', (req: Request, res: Response) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'jobId required' });
    return;
  }
  const job = claimedCheckRegistry.jobs.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      status: job.status === 'completed' ? 'done' : job.status,
      total: job.total,
      checked: job.checked,
      claimed: job.claimed,
      unclaimed: job.unclaimed,
      unknown: job.unknown,
      ...(job.error ? { error: job.error } : {}),
    },
  });
});

// GET /api/leads/check-claimed/:jobId/stream — SSE progress
router.get('/check-claimed/:jobId/stream', (req: Request, res: Response) => {
  const jobId = param(req.params.jobId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const job = claimedCheckRegistry.jobs.get(jobId);
  if (!job) {
    res.write(`data: ${JSON.stringify({ stage: 'error', detail: 'Job not found' })}\n\n`);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify({ stage: 'current', ...job })}\n\n`);
  if (job.status === 'completed' || job.status === 'failed') {
    res.end();
    return;
  }

  const handler = (event: { jobId: string; stage: string; detail: string; timestamp?: string }) => {
    if (event.jobId === jobId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.stage === 'completed' || event.stage === 'failed') {
        setTimeout(() => { try { res.end(); } catch { /* already closed */ } }, 1000);
      }
    }
  };

  claimedCheckRegistry.events.on('progress', handler);
  req.on('close', () => claimedCheckRegistry.events.off('progress', handler));
});

// POST /api/leads/check-claimed — kick off a background claimed-check job.
router.post('/check-claimed', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'ids (non-empty array) is required' });
      return;
    }

    const jobId = randomUUID();
    claimedCheckRegistry.jobs.set(jobId, newClaimedJob());

    res.json({ success: true, data: { jobId, total: ids.length } });

    runClaimedCheckJob(jobId, ids, claimedCheckRegistry).catch((e) => {
      console.error(`[leads/check-claimed] job ${jobId} crashed`, e);
    });
  } catch (err) {
    if (res.headersSent) return;
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// DELETE /api/leads/bulk — bulk delete (must come before /:id).
// Used by the "Delete Selected Flagged Leads" UI; deletion is ALWAYS user-
// triggered, never automatic, even for FLAGGED_DEAD / FLAGGED_REMOVED rows.
router.delete('/bulk', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'ids (non-empty array) is required' });
      return;
    }
    const deleted = await bulkDeleteLeads(ids);
    res.json({ success: true, data: { deleted } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// DELETE /api/leads/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await deleteLead(param(req.params.id));
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// PATCH /api/leads/bulk — bulk update
router.patch('/bulk', async (req: Request, res: Response) => {
  try {
    const { ids, patch } = req.body;
    if (!ids || !Array.isArray(ids) || !patch) {
      res.status(400).json({ success: false, error: 'ids (array) and patch (object) are required' });
      return;
    }
    const data = await bulkUpdateLeads(ids, patch);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/leads/:id/open-local — spawn the local open-lead tool DETACHED so
// Chrome opens on the operator's machine with the lead's country-account
// credentials pre-loaded. Fire-and-forget: responds 202 immediately and the
// browser keeps running after the request closes.
//
// LOCAL-ONLY by design — this spawns a GUI process on the host that serves
// localhost:3001. No gateway entry is needed; it must never be called on the
// deployed Cloud Run instance.
router.post('/:id/open-local', (req: Request, res: Response) => {
  const leadId = param(req.params.id);

  const PYTHON_RAW = config.pythonPath || 'python';
  const PYTHON = path.isAbsolute(PYTHON_RAW)
    ? PYTHON_RAW
    : path.resolve(config.projectRoot, PYTHON_RAW);

  const child = spawn(PYTHON, ['-m', 'tools.social.open_lead_browser', '--lead-id', leadId], {
    cwd: config.projectRoot,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    windowsHide: false, // this is a GUI — keep the Chrome window visible
    detached: true,
    stdio: 'ignore',
  });

  child.on('error', (err) => {
    console.error(`[leads/open-local] spawn error for lead ${leadId}: ${err.message}`);
  });

  // Unref so the parent process doesn't wait for the browser to close.
  child.unref();

  res.status(202).json({ success: true, data: { launching: true } });
});

// GET /api/leads/:id/accounts — active Facebook accounts pinned to the
// lead's country, for the manual account-picker in the browse UI. No FB
// credential fields (encrypted_cookies etc.) are ever selected/returned.
router.get('/:id/accounts', async (req: Request, res: Response) => {
  try {
    // Platform of the lead's social presence (facebook default for back-compat).
    // Instagram leads resolve IG accounts; the country gate is relaxed for them
    // inside listActiveAccountsForLead.
    const platform = typeof req.query.platform === 'string' && req.query.platform.trim()
      ? (req.query.platform as string).toLowerCase()
      : 'facebook';
    const data = await listActiveAccountsForLead(param(req.params.id), platform);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /api/leads/:id/browse — resolve the lead's Facebook account server-side
// (or use the caller's chosen accountId, geo-validated against the lead's
// country) and enqueue a browse session pointed at the lead's post URL.
router.post('/:id/browse', async (req: Request, res: Response) => {
  try {
    const { targetUrl, requestedBy, accountId, platform: platformRaw } = req.body as {
      targetUrl?: string | null;
      requestedBy?: string;
      accountId?: string;
      platform?: string;
    };
    if (!requestedBy) {
      res.status(400).json({ success: false, error: 'requestedBy is required' });
      return;
    }
    // Platform of the lead's social presence (facebook default for back-compat).
    const platform = typeof platformRaw === 'string' && platformRaw.trim()
      ? platformRaw.toLowerCase()
      : 'facebook';

    const leadId = param(req.params.id);
    let resolved: { account_id: string; country: string | null } | null;
    let wasChosen = false;

    if (accountId) {
      const validated = await validateAccountForLead(accountId, leadId, platform);
      if (!validated.ok) {
        res.status(400).json({ success: false, error: validated.reason });
        return;
      }
      resolved = { account_id: validated.account_id, country: validated.country };
      wasChosen = true;
    } else {
      resolved = await resolveLeadAccount(leadId, platform);
    }

    if (!resolved) {
      // Fetch the lead's country for the error message (same pattern as comment-drafts).
      const { data: leadRow } = await getSupabase()
        .from('leads')
        .select('country')
        .eq('id', leadId)
        .maybeSingle();
      const country = (leadRow as { country?: string | null } | null)?.country ?? 'unknown';
      res.status(409).json({
        success: false,
        error: `No active ${platform} account available for this lead${platform === 'facebook' ? ` (country ${country})` : ''}`,
      });
      return;
    }

    const row = await enqueueBrowseSession(resolved.account_id, {
      targetUrl: targetUrl ?? null,
      requestedBy,
    });

    // Smoke-log so a live hosted-comment test is traceable in Cloud Run logs:
    // shows the lead → resolved account/country (chosen or auto-resolved) →
    // enqueued browse session.
    console.log(
      `[leads/browse] lead=${leadId} account=${resolved.account_id} ` +
      `country=${resolved.country ?? 'n/a'} source=${wasChosen ? 'chosen' : 'auto'} ` +
      `requestedBy=${requestedBy} session=${row.connect_session_id} status=${row.connect_status}`,
    );

    res.json({ success: true, data: { account_id: resolved.account_id, ...row } });
  } catch (err) {
    if (err instanceof AccountInUseError) {
      res.status(409).json({
        success: false,
        error: `In use by ${err.heldBy ?? 'another user'}${err.expiresAt ? ` until ${err.expiresAt}` : ''}`,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
