import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';

const router = Router();

// ── In-memory job tracker ──────────────────────────────────────────────────
type EnrichJob = {
  status: 'running' | 'done' | 'failed';
  total: number;
  found: number;
  error?: string;
  createdAt: number;
};
const enrichJobs = new Map<string, EnrichJob>();

// Clean up jobs older than 1 hour so we don't leak memory
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, job] of enrichJobs) {
    if (job.createdAt < cutoff) enrichJobs.delete(id);
  }
}, 300_000).unref();

// ── Python runner (collects stdout for parsing) ────────────────────────────
function runPython(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const pythonPath = path.isAbsolute(config.pythonPath)
      ? config.pythonPath
      : path.resolve(config.projectRoot, config.pythonPath);
    const fullScript = path.resolve(config.projectRoot, scriptPath);

    const proc = spawn(pythonPath, [fullScript, ...args], { cwd: config.projectRoot });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(`[enrich] ${text}`);
    });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Script exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

// ── GET /api/enrich/status?jobId=xxx ──────────────────────────────────────
router.get('/status', (req: Request, res: Response) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'jobId query param required' });
    return;
  }
  const job = enrichJobs.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found or expired' });
    return;
  }
  res.json({
    success: true,
    data: {
      jobId,
      status: job.status,
      total: job.total,
      found: job.found,
      ...(job.error ? { error: job.error } : {}),
    },
  });
});

// ── POST /api/enrich — fire-and-forget with job tracking ──────────────────
router.post('/', async (req: Request, res: Response) => {
  const tmpDir = path.resolve(config.projectRoot, '.tmp');
  const jobId = randomUUID();
  const tmpFile = path.join(tmpDir, `enrich_${jobId}.json`);

  try {
    const { leadIds } = req.body;
    const supabase = getSupabase();

    let query = supabase
      .from('leads')
      .select('id, company_name, trustpilot_url, website_url, trustpilot_email, website_email, primary_email, phone, country, category, star_rating')
      .not('website_url', 'is', null);

    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      query = query.in('id', leadIds);
    } else {
      query = query.is('website_email', null);
    }

    const { data: leads, error } = await query;
    if (error) throw new Error(error.message);

    if (!leads || leads.length === 0) {
      res.json({ success: true, data: { jobId: null, total: 0, message: 'No leads need enrichment' } });
      return;
    }

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(leads, null, 2), 'utf-8');

    // Register job before responding so polling can start immediately
    enrichJobs.set(jobId, { status: 'running', total: leads.length, found: 0, createdAt: Date.now() });

    // Respond immediately (API Gateway has 30s timeout; Playwright would exceed it)
    res.json({
      success: true,
      data: { jobId, total: leads.length, message: `Enrichment started for ${leads.length} leads` },
    });

    // ── Background execution ───────────────────────────────────────────────
    runPython('tools/scraper/scrape_website.py', [
      '--input', tmpFile,
      '--output', tmpFile,
      '--parallel', '3',
    ])
      .then((stdout) => {
        // Parse "PROGRESS:enrich_done:N" from scrape_website.py output
        const match = stdout.match(/PROGRESS:enrich_done:(\d+)/);
        const found = match ? parseInt(match[1], 10) : 0;
        return runPython('tools/db/upsert_leads.py', ['--input', tmpFile])
          .then(() => found);
      })
      .then((found) => {
        const existing = enrichJobs.get(jobId);
        enrichJobs.set(jobId, {
          status: 'done',
          total: leads.length,
          found,
          createdAt: existing?.createdAt ?? Date.now(),
        });
        console.log(`[enrich] Job ${jobId} done — found ${found}/${leads.length} emails`);
      })
      .catch((err: Error) => {
        const existing = enrichJobs.get(jobId);
        enrichJobs.set(jobId, {
          status: 'failed',
          total: leads.length,
          found: 0,
          error: err.message.slice(0, 300),
          createdAt: existing?.createdAt ?? Date.now(),
        });
        console.error(`[enrich] Job ${jobId} failed: ${err.message}`);
      })
      .finally(() => {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
