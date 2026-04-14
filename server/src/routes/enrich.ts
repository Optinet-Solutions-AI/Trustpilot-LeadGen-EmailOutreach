import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';

const router = Router();

// Sentinel value used in scrape_jobs to identify enrichment-only jobs
const ENRICH_SENTINEL = '_enrich_';

// ── Python runner ─────────────────────────────────────────────────────────────
function runPython(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const pythonPath = path.isAbsolute(config.pythonPath)
      ? config.pythonPath
      : path.resolve(config.projectRoot, config.pythonPath);
    const fullScript = path.resolve(config.projectRoot, scriptPath);

    const proc = spawn(pythonPath, [fullScript, ...args], {
      cwd: config.projectRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
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

// ── GET /api/enrich/status?jobId=xxx ─────────────────────────────────────────
// Reads from Supabase so state survives Cloud Run instance restarts.
router.get('/status', async (req: Request, res: Response) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'jobId query param required' });
    return;
  }

  const supabase = getSupabase();
  const { data: job } = await supabase
    .from('scrape_jobs')
    .select('id, status, total_found, total_enriched, error')
    .eq('id', jobId)
    .eq('country', ENRICH_SENTINEL)
    .single();

  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found or expired' });
    return;
  }

  res.json({
    success: true,
    data: {
      jobId,
      status: job.status === 'completed' ? 'done' : job.status === 'failed' ? 'failed' : 'running',
      total: job.total_found ?? 0,
      found: job.total_enriched ?? 0,
      ...(job.error ? { error: job.error } : {}),
    },
  });
});

// ── POST /api/enrich — start enrichment job ───────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  const tmpDir = path.resolve(config.projectRoot, '.tmp');

  try {
    const { leadIds } = req.body;
    const supabase = getSupabase();

    // Fetch leads that need enrichment
    let query = supabase
      .from('leads')
      .select('id, company_name, trustpilot_url, website_url, trustpilot_email, website_email, primary_email, phone, country, category, star_rating')
      .not('website_url', 'is', null);

    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      // Specific leads selected — enrich them regardless of whether they have website_email
      query = query.in('id', leadIds);
    } else {
      // All un-enriched leads
      query = query.is('website_email', null);
    }

    const { data: leads, error } = await query;
    if (error) throw new Error(error.message);

    if (!leads || leads.length === 0) {
      res.json({ success: true, data: { jobId: null, total: 0, message: 'No leads need enrichment' } });
      return;
    }

    // Persist job in Supabase so status survives Cloud Run instance restarts/restarts
    const { data: jobRow, error: jobError } = await supabase
      .from('scrape_jobs')
      .insert({
        country: ENRICH_SENTINEL,
        category: ENRICH_SENTINEL,
        min_rating: 0,
        max_rating: 5,
        enrich: true,
        verify: false,
        status: 'running',
        total_found: leads.length,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (jobError) throw new Error(jobError.message);

    const jobId = jobRow.id;
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `enrich_${jobId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(leads, null, 2), 'utf-8');

    // Pre-flight: verify Python binary exists before responding
    const pythonPath = path.isAbsolute(config.pythonPath)
      ? config.pythonPath
      : path.resolve(config.projectRoot, config.pythonPath);
    if (!fs.existsSync(pythonPath)) {
      await supabase.from('scrape_jobs').update({
        status: 'failed',
        error: `Python binary not found at: ${pythonPath}`,
        completed_at: new Date().toISOString(),
      }).eq('id', jobId);
      res.status(500).json({ success: false, error: `Python not found at ${pythonPath}` });
      return;
    }

    // Respond immediately — API Gateway has a 30s timeout; Playwright would exceed it
    res.json({
      success: true,
      data: { jobId, total: leads.length, message: `Enrichment started for ${leads.length} leads` },
    });

    // ── Background execution ─────────────────────────────────────────────────
    runPython('tools/scraper/scrape_website.py', [
      '--input', tmpFile,
      '--output', tmpFile,
      '--parallel', '3',
    ])
      .then((stdout) => {
        const match = stdout.match(/PROGRESS:enrich_done:(\d+)/);
        const found = match ? parseInt(match[1], 10) : 0;
        return runPython('tools/db/upsert_leads.py', ['--input', tmpFile])
          .then(() => found);
      })
      .then((found) => {
        supabase.from('scrape_jobs').update({
          status: 'completed',
          total_enriched: found,
          completed_at: new Date().toISOString(),
        }).eq('id', jobId).then(() => {});
        console.log(`[enrich] Job ${jobId} done — found ${found}/${leads.length} emails`);
      })
      .catch((err: Error) => {
        supabase.from('scrape_jobs').update({
          status: 'failed',
          error: err.message.slice(0, 500),
          completed_at: new Date().toISOString(),
        }).eq('id', jobId).then(() => {});
        console.error(`[enrich] Job ${jobId} failed:`, err.message);
      })
      .finally(() => {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
