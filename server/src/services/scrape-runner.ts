/**
 * Scrape orchestrator — spawns Python scraper scripts as child processes.
 * Reads stdout for PROGRESS: lines to update job status via SSE.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { config } from '../config.js';
import { updateJob } from '../db/scrape-jobs.js';

export const scrapeEvents = new EventEmitter();

interface ScrapeParams {
  jobId: string;
  country: string;
  category: string;
  minRating: number;
  maxRating: number;
  enrich: boolean;
  verify: boolean;
}

function runPython(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // If pythonPath is absolute (Linux: /usr/bin/python3) use as-is; if relative (Windows venv) resolve against project root
    const pythonPath = path.isAbsolute(config.pythonPath)
      ? config.pythonPath
      : path.resolve(config.projectRoot, config.pythonPath);
    const fullScript = path.resolve(config.projectRoot, scriptPath);

    console.log(`Running: ${pythonPath} ${fullScript} ${args.join(' ')}`);
    const proc = spawn(pythonPath, [fullScript, ...args], {
      cwd: config.projectRoot,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;

      // Parse PROGRESS: lines for SSE streaming
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('PROGRESS:')) {
          const parts = line.trim().split(':');
          scrapeEvents.emit('progress', {
            jobId: args[0], // not ideal, but we pass it through
            stage: parts[1],
            detail: parts.slice(2).join(':'),
          });
        }
        if (line.trim()) console.log(`  [PY] ${line.trim()}`);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Script exited with code ${code}: ${stderr}`));
    });

    proc.on('error', (err) => reject(err));
  });
}

export async function runScrapeJob(params: ScrapeParams): Promise<void> {
  const { jobId, country, category, minRating, maxRating, enrich, verify } = params;
  const tmpDir = path.resolve(config.projectRoot, '.tmp');

  try {
    await updateJob(jobId, { status: 'running', started_at: new Date().toISOString() });
    scrapeEvents.emit('progress', { jobId, stage: 'started', detail: '' });

    // Step 1: Category scrape
    const rawOutput = path.join(tmpDir, `${jobId}_raw.json`);
    await runPython('tools/scraper/scrape_category.py', [
      '--country', country,
      '--category', category,
      '--min-rating', String(minRating),
      '--max-rating', String(maxRating),
      '--output', rawOutput,
    ]);

    // Update found count from raw results
    try {
      const fs = await import('fs');
      const rawData = JSON.parse(fs.readFileSync(rawOutput, 'utf-8'));
      await updateJob(jobId, { total_found: rawData.length });
      scrapeEvents.emit('progress', { jobId, stage: 'category_done', detail: String(rawData.length) });
    } catch {}

    // Step 2: Profile scrape (always captures screenshots)
    const enrichedOutput = path.join(tmpDir, `${jobId}_enriched.json`);
    const screenshotsDir = path.join(tmpDir, 'screenshots');
    await runPython('tools/scraper/scrape_profile.py', [
      '--input', rawOutput,
      '--output', enrichedOutput,
      '--screenshots-dir', screenshotsDir,
    ]);

    // Step 3: Website enrichment (optional) — only runs on leads missing an email
    if (enrich) {
      scrapeEvents.emit('progress', { jobId, stage: 'enrich_start', detail: '' });
      await runPython('tools/scraper/scrape_website.py', [
        '--input', enrichedOutput,
        '--output', enrichedOutput,
        '--parallel', '3',
      ]);
    }

    // Step 4: Save to Supabase
    await runPython('tools/db/upsert_leads.py', [
      '--input', enrichedOutput,
    ]);

    // Count enriched results
    let totalScraped = 0;
    try {
      const fs = await import('fs');
      const enrichedData = JSON.parse(fs.readFileSync(enrichedOutput, 'utf-8'));
      totalScraped = enrichedData.length;
    } catch {}

    await updateJob(jobId, {
      status: 'completed',
      total_scraped: totalScraped,
      completed_at: new Date().toISOString(),
    });
    scrapeEvents.emit('progress', { jobId, stage: 'completed', detail: '' });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJob(jobId, { status: 'failed', error: message });
    scrapeEvents.emit('progress', { jobId, stage: 'failed', detail: message });
  }
}
