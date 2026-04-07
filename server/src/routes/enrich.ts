import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase.js';
import { config } from '../config.js';

const router = Router();

function runPython(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const pythonPath = path.isAbsolute(config.pythonPath)
      ? config.pythonPath
      : path.resolve(config.projectRoot, config.pythonPath);
    const fullScript = path.resolve(config.projectRoot, scriptPath);

    const proc = spawn(pythonPath, [fullScript, ...args], { cwd: config.projectRoot });
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => process.stdout.write(`[enrich] ${data}`));
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script exited with code ${code}: ${stderr}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

// POST /api/enrich — run website email enrichment on selected (or all unenriched) leads
router.post('/', async (req: Request, res: Response) => {
  const tmpDir = path.resolve(config.projectRoot, '.tmp');
  const jobId = randomUUID();
  const tmpFile = path.join(tmpDir, `enrich_${jobId}.json`);

  try {
    const { leadIds } = req.body;
    const supabase = getSupabase();

    // Fetch leads that need enrichment (have website_url, no website_email yet)
    let query = supabase
      .from('leads')
      .select('id, company_name, trustpilot_url, website_url, trustpilot_email, website_email, primary_email, phone, country, category, star_rating')
      .not('website_url', 'is', null);

    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      query = query.in('id', leadIds);
    } else {
      // Only unenriched leads if no IDs specified
      query = query.is('website_email', null);
    }

    const { data: leads, error } = await query;
    if (error) throw new Error(error.message);
    if (!leads || leads.length === 0) {
      res.json({ success: true, data: { enriched: 0, message: 'No leads need enrichment' } });
      return;
    }

    // Write leads to temp file in format scrape_website.py expects
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(leads, null, 2), 'utf-8');

    // Run website enrichment
    await runPython('tools/scraper/scrape_website.py', [
      '--input', tmpFile,
      '--output', tmpFile,
      '--parallel', '3',
    ]);

    // Upsert enriched leads back to Supabase
    await runPython('tools/db/upsert_leads.py', ['--input', tmpFile]);

    // Count how many got a website_email
    let enriched = 0;
    try {
      const enrichedLeads: Array<Record<string, unknown>> = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
      enriched = enrichedLeads.filter((l) => l.website_email).length;
    } catch { /* ignore read error */ }

    res.json({ success: true, data: { enriched, total: leads.length } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});

export default router;
