import { Router, Request, Response } from 'express';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.js';
import { verifyEmails as verifyEmailsMock } from '../services/email-verifier.mock.js';
import { verifyEmails as verifyEmailsZB } from '../services/email-verifier.zerobounce.js';
import { createNote } from '../db/notes.js';

const verifyEmails = process.env.ZEROBOUNCE_API_KEY ? verifyEmailsZB : verifyEmailsMock;

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

    const emailToLeadIds = new Map<string, string[]>();
    for (const lead of leads) {
      for (const email of pickEmails(lead, emailField)) {
        const existing = emailToLeadIds.get(email) || [];
        existing.push(lead.id);
        emailToLeadIds.set(email, existing);
      }
    }

    const emails = [...emailToLeadIds.keys()];

    console.log(`[verify] emailField=${emailField} leadsFetched=${leads.length} emailsCollected=${emails.length}`);
    if (emails.length === 0) {
      console.log(`[verify] No emails found for field "${emailField}". Per-lead snapshot:`);
      for (const l of leads.slice(0, 10)) {
        console.log(`  lead=${l.id} tp=${JSON.stringify(l.trustpilot_email)} web=${JSON.stringify(l.website_email)} primary=${JSON.stringify(l.primary_email)}`);
      }
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
        const BATCH_SIZE = 100;
        const totalBatches = Math.ceil(emails.length / BATCH_SIZE);
        const allResults: Array<{ email: string; status: 'valid' | 'invalid' | 'catch-all' | 'unknown' }> = [];

        emit(jobId, 'verify_start', String(emails.length));

        for (let i = 0; i < emails.length; i += BATCH_SIZE) {
          const chunk = emails.slice(i, i + BATCH_SIZE);
          const batchNum = Math.floor(i / BATCH_SIZE) + 1;

          emit(jobId, 'verify_batch_start', `${batchNum}|${totalBatches}|${i}|${emails.length}`);

          const batchResults = await verifyEmails(chunk);
          allResults.push(...batchResults);

          for (const r of batchResults) {
            if (r.status === 'valid') job.verified++;
            else if (r.status === 'invalid') job.invalid++;
            else if (r.status === 'catch-all') job.catchAll++;
            else job.unknown++;
          }

          const done = Math.min(i + chunk.length, emails.length);
          emit(jobId, 'verify_batch_done', `${batchNum}|${totalBatches}|${done}|${emails.length}`);
        }

        emit(jobId, 'verify_saving', String(allResults.length));

        for (const result of allResults) {
          const leadIdsForEmail = emailToLeadIds.get(result.email) || [];
          const isVerified = result.status === 'valid';
          for (const leadId of leadIdsForEmail) {
            await supabase.from('leads').update({
              email_verified: isVerified,
              verification_status: result.status,
            }).eq('id', leadId);

            await createNote(leadId, {
              type: 'verification',
              content: `Email ${result.email} verified: ${result.status}`,
              metadata: { email: result.email, status: result.status },
            });
          }
        }

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

export default router;
