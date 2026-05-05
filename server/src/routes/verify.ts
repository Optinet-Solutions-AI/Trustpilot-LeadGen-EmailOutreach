import { Router, Request, Response } from 'express';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.js';
import { createNote } from '../db/notes.js';
import { validateEmail, type ValidationResult, type FinalStatus } from '../services/email-validator/index.js';
import { getCachedDomainIntel } from '../services/email-validator/domain-intel.js';
import { resolvePrimaryEmail } from '../services/email/resolve-primary-email.js';

export const verifyEvents = new EventEmitter();
verifyEvents.setMaxListeners(50);

interface VerifyJob {
  status: 'running' | 'completed' | 'failed';
  total: number;
  verified: number;
  invalid: number;
  catchAll: number;
  unknown: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

const jobs = new Map<string, VerifyJob>();

function emit(jobId: string, stage: string, detail: string) {
  verifyEvents.emit('progress', { jobId, stage, detail, timestamp: new Date().toISOString() });
}

const router = Router();

// ── GET /api/verify/status?jobId=xxx — polling fallback ──────────────────────
router.get('/status', (req: Request, res: Response) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'jobId required' });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      status: job.status === 'completed' ? 'done' : job.status,
      total: job.total,
      verified: job.verified,
      invalid: job.invalid,
      catchAll: job.catchAll,
      unknown: job.unknown,
      ...(job.error ? { error: job.error } : {}),
    },
  });
});

const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// ── GET /api/verify/:jobId/stream — SSE progress stream ──────────────────────
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const jobId = param(req.params.jobId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const job = jobs.get(jobId);
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

  verifyEvents.on('progress', handler);
  req.on('close', () => verifyEvents.off('progress', handler));
});

// ── GET /api/verify/domain-intel?domain=xxx — read cached domain intel ──────
router.get('/domain-intel', async (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain.toLowerCase() : '';
  if (!domain) {
    res.status(400).json({ success: false, error: 'domain query param required' });
    return;
  }
  try {
    const intel = await getCachedDomainIntel(domain);
    res.json({ success: true, data: intel });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

type EmailField = 'trustpilot' | 'website' | 'both';

function pickEmails(
  lead: { id: string; primary_email: string | null; trustpilot_email: string | null; website_email: string | null },
  field: EmailField,
): string[] {
  if (field === 'trustpilot') {
    return lead.trustpilot_email ? [lead.trustpilot_email] : [];
  }
  if (field === 'website') {
    return lead.website_email ? [lead.website_email] : [];
  }
  // both — verify each distinct email separately
  const emails: string[] = [];
  if (lead.trustpilot_email) emails.push(lead.trustpilot_email);
  if (lead.website_email && lead.website_email !== lead.trustpilot_email) emails.push(lead.website_email);
  return emails;
}

// Map orchestrator's per-stage breakdown into the columns the UI tooltip reads.
function patchFromResult(r: ValidationResult, source: 'trustpilot' | 'website') {
  const patch: Record<string, unknown> = {
    email_verified: r.status === 'valid',
    verification_status: r.status,
    verify_syntax_ok: r.syntax_ok,
    verify_mx_ok: r.mx_ok,
    verify_smtp_result: r.smtp_result,
    verify_zerobounce_result: r.zerobounce_result,
    verified_at: new Date().toISOString(),
  };
  if (source === 'trustpilot') patch.trustpilot_email_status = r.status;
  if (source === 'website')    patch.website_email_status = r.status;
  return patch;
}

// ── POST /api/verify/sync — inline re-verify for the wizard ─────────────────
// Used by StepRecipients when the user clicks an `invalid` lead. Re-runs
// validation on BOTH email sources (TP + website), updates per-source statuses
// + verification_status (worst of the two), recomputes primary_email under the
// "TP first, fall back to website" policy, and returns the freshened rows.
// Capped to 5 leads per call to keep response fast and ZeroBounce credits sane.
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const { leadIds } = req.body as { leadIds?: string[] };
    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      res.status(400).json({ success: false, error: 'leadIds (non-empty array) is required' });
      return;
    }
    if (leadIds.length > 5) {
      res.status(400).json({ success: false, error: 'sync re-verify is capped at 5 leads per call' });
      return;
    }

    const supabase = getSupabase();
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, trustpilot_email, website_email, trustpilot_email_status, website_email_status')
      .in('id', leadIds);
    if (error) throw new Error(error.message);
    if (!leads || leads.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    // Worst-of ladder: invalid > catch-all > unknown > valid. The lead-level
    // verification_status is the weakest verdict across the lead's emails so
    // the send-gate stays conservative.
    const rank: Record<string, number> = { invalid: 4, 'catch-all': 3, unknown: 2, valid: 1 };
    const worstOf = (statuses: (string | null | undefined)[]): FinalStatus => {
      const valid = statuses.filter(Boolean) as string[];
      if (valid.length === 0) return 'unknown';
      let worst = valid[0];
      for (const s of valid) if ((rank[s] ?? 0) > (rank[worst] ?? 0)) worst = s;
      return worst as FinalStatus;
    };

    const updated: Array<Record<string, unknown>> = [];
    for (const lead of leads) {
      const sources: Array<{ source: 'trustpilot' | 'website'; email: string }> = [];
      if (lead.trustpilot_email) sources.push({ source: 'trustpilot', email: lead.trustpilot_email });
      if (lead.website_email && lead.website_email !== lead.trustpilot_email) {
        sources.push({ source: 'website', email: lead.website_email });
      }

      if (sources.length === 0) {
        updated.push({ id: lead.id, message: 'no emails to verify' });
        continue;
      }

      const results = await Promise.all(
        sources.map(async (s) => ({ ...s, result: await validateEmail(s.email) }))
      );

      const patch: Record<string, unknown> = {
        verified_at: new Date().toISOString(),
      };
      const perSource: Record<string, string | null> = {
        trustpilot_email_status: lead.trustpilot_email_status ?? null,
        website_email_status: lead.website_email_status ?? null,
      };

      // Apply per-source verdicts and capture the latest stage diagnostics
      // from whichever source we verified last (UI tooltips read these).
      for (const { source, result } of results) {
        Object.assign(patch, patchFromResult(result, source));
        perSource[`${source}_email_status`] = result.status;
      }

      const newPrimary = resolvePrimaryEmail({
        trustpilot_email: lead.trustpilot_email,
        website_email: lead.website_email,
        trustpilot_email_status: perSource.trustpilot_email_status,
        website_email_status: perSource.website_email_status,
      });
      patch.primary_email = newPrimary;

      // Lead-level status: worst of the two source verdicts. Drives the
      // send-gate and the StepRecipients UI badge.
      const finalStatus = worstOf([perSource.trustpilot_email_status, perSource.website_email_status]);
      patch.verification_status = finalStatus;
      patch.email_verified = finalStatus === 'valid';

      const { error: updErr } = await supabase.from('leads').update(patch).eq('id', lead.id);
      if (updErr) {
        console.error(`[verify/sync] update failed for ${lead.id}: ${updErr.message}`);
        continue;
      }

      updated.push({
        id: lead.id,
        primary_email: newPrimary,
        verification_status: finalStatus,
        trustpilot_email_status: perSource.trustpilot_email_status,
        website_email_status: perSource.website_email_status,
      });

      // Best-effort note per lead summarising the freshened verdicts.
      try {
        const summary = results.map((r) => `${r.source}=${r.result.status}`).join(', ');
        await createNote(lead.id, {
          type: 'verification',
          content: `Re-verified from wizard: ${summary} (final: ${finalStatus})`,
          metadata: { source: 'wizard-sync', final_status: finalStatus, per_source: perSource },
        });
      } catch (noteErr) {
        const m = noteErr instanceof Error ? noteErr.message : String(noteErr);
        console.error(`[verify/sync] createNote failed for ${lead.id}: ${m}`);
      }
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/verify — start verification job ────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const { leadIds, emailField = 'trustpilot' } = req.body as { leadIds?: string[]; emailField?: EmailField };
    const supabase = getSupabase();

    let query = supabase.from('leads').select('id, primary_email, trustpilot_email, website_email');
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      query = query.in('id', leadIds);
    } else {
      query = query.eq('email_verified', false);
    }

    const { data: leads, error } = await query;
    if (error) throw new Error(error.message);

    if (!leads || leads.length === 0) {
      res.json({ success: true, data: { jobId: null, total: 0, message: 'No leads to verify' } });
      return;
    }

    // Map each unique email -> the leads that own it, plus which source
    // field on those leads (trustpilot vs website) matched. Carrying the
    // source forward lets us update the per-source status column later.
    type LeadTarget = { id: string; source: 'trustpilot' | 'website' };
    const emailToTargets = new Map<string, LeadTarget[]>();
    const norm = (e: string) => e.toLowerCase().trim();
    for (const lead of leads) {
      for (const email of pickEmails(lead, emailField)) {
        const key = norm(email);
        const targets = emailToTargets.get(key) || [];
        if (lead.trustpilot_email && norm(lead.trustpilot_email) === key) {
          targets.push({ id: lead.id, source: 'trustpilot' });
        }
        if (lead.website_email && norm(lead.website_email) === key
            && norm(lead.website_email) !== norm(lead.trustpilot_email || '')) {
          targets.push({ id: lead.id, source: 'website' });
        }
        emailToTargets.set(key, targets);
      }
    }

    const emails = [...emailToTargets.keys()];

    console.log(`[verify] emailField=${emailField} leadsFetched=${leads.length} emailsCollected=${emails.length}`);
    if (emails.length === 0) {
      const fieldLabel = emailField === 'trustpilot'
        ? 'Trustpilot email'
        : emailField === 'website'
          ? 'website email'
          : 'Trustpilot or website email';
      res.json({
        success: true,
        data: {
          jobId: null,
          total: 0,
          message: `None of the ${leads.length} selected lead${leads.length === 1 ? '' : 's'} have a ${fieldLabel} to verify.`,
        },
      });
      return;
    }

    const jobId = randomUUID();
    const job: VerifyJob = {
      status: 'running',
      total: emails.length,
      verified: 0,
      invalid: 0,
      catchAll: 0,
      unknown: 0,
      startedAt: new Date().toISOString(),
    };
    jobs.set(jobId, job);
    setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000);

    res.json({ success: true, data: { jobId, total: emails.length } });

    (async () => {
      try {
        emit(jobId, 'verify_start', String(emails.length));

        // Group by domain so we run domain-level intel (DNS, catch-all) once
        // and keep per-MX SMTP probes serialized.
        const byDomain = new Map<string, string[]>();
        for (const e of emails) {
          const d = (e.split('@')[1] || '').toLowerCase();
          const list = byDomain.get(d) || [];
          list.push(e);
          byDomain.set(d, list);
        }

        const allResults: ValidationResult[] = [];
        let processed = 0;
        const total = emails.length;

        // Run distinct domains in parallel; addresses within a domain serial.
        await Promise.all([...byDomain.entries()].map(async ([domain, group]) => {
          emit(jobId, 'mx_check', domain);
          for (const email of group) {
            emit(jobId, 'verify_address', email);
            const result = await validateEmail(email, {
              onStage: (stage, detail) => emit(jobId, stage, detail),
            });
            allResults.push(result);

            if (result.status === 'valid')         job.verified++;
            else if (result.status === 'invalid')  job.invalid++;
            else if (result.status === 'catch-all') job.catchAll++;
            else                                   job.unknown++;

            processed++;
            emit(jobId, 'verify_address_done', `${processed}|${total}|${email}|${result.status}`);
          }
        }));

        emit(jobId, 'verify_saving', String(allResults.length));

        let updatedCount = 0;
        let noteCount = 0;
        let skippedCount = 0;
        for (const result of allResults) {
          const targets = emailToTargets.get(result.email) || [];
          if (targets.length === 0) {
            console.warn(`[verify] ${jobId} NO lead found for email=${JSON.stringify(result.email)} — map lookup miss`);
            skippedCount++;
            continue;
          }
          for (const target of targets) {
            const patch = patchFromResult(result, target.source);
            const { error: updErr } = await supabase.from('leads').update(patch).eq('id', target.id);
            if (updErr) console.error(`[verify] ${jobId} leads UPDATE failed for ${target.id}: ${updErr.message}`);
            else updatedCount++;

            try {
              await createNote(target.id, {
                type: 'verification',
                content: `${result.email} → ${result.status} (via ${result.sourceStage}): ${result.reason}`,
                metadata: {
                  email: result.email,
                  status: result.status,
                  source: target.source,
                  source_stage: result.sourceStage,
                  smtp_result: result.smtp_result,
                  zerobounce_result: result.zerobounce_result,
                  mx_top: result.mx_top,
                  provider_type: result.provider_type,
                  is_catch_all_domain: result.is_catch_all_domain,
                  raw_smtp_response: result.raw_smtp_response,
                },
              });
              noteCount++;
            } catch (noteErr) {
              const m = noteErr instanceof Error ? noteErr.message : String(noteErr);
              console.error(`[verify] ${jobId} createNote failed for ${target.id}: ${m}`);
            }
          }
        }

        console.log(`[verify] ${jobId} done. updated=${updatedCount} notes=${noteCount} skipped=${skippedCount}`);

        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        emit(jobId, 'completed', JSON.stringify({
          total: emails.length,
          verified: job.verified,
          invalid: job.invalid,
          catchAll: job.catchAll,
          unknown: job.unknown,
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = message.slice(0, 500);
        emit(jobId, 'failed', message.slice(0, 200));
      }
    })();

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// Re-export for any external consumers; not used by the app itself.
export type { FinalStatus };

export default router;
