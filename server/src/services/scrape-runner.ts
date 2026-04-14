/**
 * Scrape orchestrator — spawns Python scraper scripts as child processes.
 * Reads stdout for PROGRESS: and FAILED: lines to update job status via SSE.
 *
 * Features:
 *   - Per-URL failure tracking (FAILED: lines → scrape_failures table)
 *   - Pre-scrape deduplication (skips already-scraped profiles)
 *   - Checkpoint saves (upserts after profile scrape, again after enrich)
 *   - PID tracking for job cancellation
 *   - Granular progress events with timestamps
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { updateJob } from '../db/scrape-jobs.js';
import { insertFailure } from '../db/scrape-failures.js';
import { getSupabase } from '../lib/supabase.js';

export const scrapeEvents = new EventEmitter();

// Track active Python processes for cancellation
const activeProcesses = new Map<string, ChildProcess>();

// Watchdog: max seconds of silence before killing a hung Python process
const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface ScrapeParams {
  jobId: string;
  country: string;
  category: string;
  minRating: number;
  maxRating: number;
  enrich: boolean;
  verify: boolean;
  forceRescrape?: boolean;
}

function emitProgress(jobId: string, stage: string, detail: string) {
  scrapeEvents.emit('progress', {
    jobId,
    stage,
    detail,
    timestamp: new Date().toISOString(),
  });
}

function runPython(
  jobId: string,
  scriptPath: string,
  args: string[],
): { promise: Promise<string>; proc: ChildProcess } {
  const pythonPath = path.isAbsolute(config.pythonPath)
    ? config.pythonPath
    : path.resolve(config.projectRoot, config.pythonPath);
  const fullScript = path.resolve(config.projectRoot, scriptPath);

  console.log(`Running: ${pythonPath} ${fullScript} ${args.join(' ')}`);
  const proc = spawn(pythonPath, [fullScript, ...args], {
    cwd: config.projectRoot,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    // detached=true on Linux puts the child in its own process group so we can
    // kill the whole group (Python + Chromium) with process.kill(-pid, SIGKILL).
    // On Windows this has no meaningful effect since we use taskkill /T instead.
    detached: process.platform !== 'win32',
  });

  // Track process for cancellation
  activeProcesses.set(jobId, proc);

  const promise = new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let lastActivityTime = Date.now();

    // Watchdog timer — kills the process if no stdout for WATCHDOG_TIMEOUT_MS
    const watchdog = setInterval(() => {
      const silenceMs = Date.now() - lastActivityTime;
      if (silenceMs > WATCHDOG_TIMEOUT_MS) {
        console.error(`[Watchdog] Killing hung Python process for job ${jobId} (no output for ${Math.round(silenceMs / 1000)}s)`);
        clearInterval(watchdog);
        try { proc.kill('SIGKILL'); } catch {}
        activeProcesses.delete(jobId);
        reject(new Error(`Watchdog: Python process hung (no output for ${Math.round(silenceMs / 1000)}s) — likely OOM or Playwright freeze`));
      }
    }, 30_000); // Check every 30s

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      lastActivityTime = Date.now(); // Reset watchdog

      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('PROGRESS:')) {
          const parts = trimmed.split(':');
          emitProgress(jobId, parts[1], parts.slice(2).join(':'));
        } else if (trimmed.startsWith('FAILED:')) {
          const parts = trimmed.split(':');
          const stage = parts[1] || 'unknown';
          const url = parts[2] || '';
          const errorMsg = parts.slice(3).join(':') || 'Unknown error';
          // Insert failure record asynchronously (don't block)
          insertFailure({ job_id: jobId, url, stage, error_message: errorMsg });
          emitProgress(jobId, 'item_failed', `${stage}:${url}`);
        }

        if (trimmed) console.log(`  [PY] ${trimmed}`);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      lastActivityTime = Date.now(); // stderr counts as activity too
    });

    proc.on('close', (code) => {
      clearInterval(watchdog);
      activeProcesses.delete(jobId);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Script exited with code ${code}: ${stderr.slice(0, 500)}`));
    });

    proc.on('error', (err) => {
      clearInterval(watchdog);
      activeProcesses.delete(jobId);
      reject(err);
    });
  });

  return { promise, proc };
}

/**
 * Upload screenshots from local .tmp/screenshots/ to Supabase Storage,
 * then update each lead's screenshot_path to the public URL.
 * This ensures screenshots persist across Cloud Run deployments.
 */
async function uploadScreenshotsToStorage(screenshotsDir: string, enrichedOutput: string): Promise<void> {
  try {
    if (!fs.existsSync(screenshotsDir)) return;

    const supabase = getSupabase();
    const BUCKET = 'screenshots';

    // Ensure bucket exists (idempotent — ignores "already exists" errors)
    await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

    // Read enriched leads to map filenames → lead trustpilot_urls
    let leads: Array<{ trustpilot_url?: string; screenshot_path?: string }> = [];
    try {
      leads = JSON.parse(fs.readFileSync(enrichedOutput, 'utf-8'));
    } catch { return; }

    const files = fs.readdirSync(screenshotsDir).filter((f) => f.endsWith('.png'));
    if (files.length === 0) return;

    console.log(`[Screenshots] Uploading ${files.length} screenshots to Supabase Storage...`);

    for (const filename of files) {
      const filePath = path.join(screenshotsDir, filename);
      const fileBuffer = fs.readFileSync(filePath);

      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(filename, fileBuffer, { contentType: 'image/png', upsert: true });

      if (error) {
        console.warn(`[Screenshots] Failed to upload ${filename}: ${error.message}`);
        continue;
      }

      // Get public URL
      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filename);
      const publicUrl = urlData?.publicUrl;
      if (!publicUrl) continue;

      // Find matching lead and update screenshot_path in DB
      const matchingLead = leads.find((l) =>
        l.screenshot_path && path.basename(l.screenshot_path) === filename
      );
      if (matchingLead?.trustpilot_url) {
        await supabase
          .from('leads')
          .update({ screenshot_path: publicUrl })
          .eq('trustpilot_url', matchingLead.trustpilot_url);
      }
    }

    console.log(`[Screenshots] Upload complete — ${files.length} files`);
  } catch (err) {
    // Non-fatal — screenshots are nice-to-have, don't fail the scrape job
    console.error('[Screenshots] Upload error (non-fatal):', err);
  }
}

/**
 * Cancel a running scrape job by killing its Python process.
 */
export async function cancelScrapeJob(jobId: string): Promise<void> {
  const proc = activeProcesses.get(jobId);
  if (proc) {
    // Kill the entire process tree (including Playwright/Chromium children)
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
      } catch {}
    } else {
      // Use SIGKILL on the process group to kill Python + all Chromium children.
      // proc.pid is the Python process; negating the PID targets the whole group.
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        // Fallback if process group kill fails (e.g. proc already exited)
        try { proc.kill('SIGKILL'); } catch {}
      }
    }
    activeProcesses.delete(jobId);
  }

  await updateJob(jobId, {
    status: 'failed',
    error: 'Cancelled by user',
    completed_at: new Date().toISOString(),
  });
  emitProgress(jobId, 'failed', 'Cancelled by user');
}

/**
 * Get all active process entries (for SIGTERM cleanup).
 */
export function getActiveProcesses(): Map<string, ChildProcess> {
  return activeProcesses;
}

/**
 * Fetch existing leads that have a website_url but no website_email yet.
 * Used to enrich leads that were previously scraped but not enriched.
 * Excludes URLs in the excludeUrls set (e.g. newly scraped leads already being enriched).
 */
async function fetchUnenrichedLeads(
  country: string,
  category: string,
  excludeUrls: Set<string> = new Set(),
): Promise<Array<Record<string, unknown>>> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('leads')
    .select('company_name, trustpilot_url, website_url, trustpilot_email, website_email, country, category, star_rating')
    .eq('country', country)
    .eq('category', category)
    .not('website_url', 'is', null)
    .is('website_email', null);

  return ((data || []) as Array<Record<string, unknown>>).filter(
    (l) => !excludeUrls.has(l['trustpilot_url'] as string),
  );
}

/**
 * Deduplicate leads against existing DB records.
 * Returns filtered list with already-scraped profiles removed.
 */
async function deduplicateLeads(
  leads: Array<{ trustpilot_url?: string; [key: string]: unknown }>,
): Promise<{ filtered: typeof leads; skippedCount: number }> {
  const urls = leads
    .map((l) => l.trustpilot_url)
    .filter((u): u is string => !!u);

  if (urls.length === 0) return { filtered: leads, skippedCount: 0 };

  const existing = new Set<string>();
  const supabase = getSupabase();

  // Query in chunks of 100 to avoid payload limits
  for (let i = 0; i < urls.length; i += 100) {
    const chunk = urls.slice(i, i + 100);
    const { data } = await supabase
      .from('leads')
      .select('trustpilot_url')
      .in('trustpilot_url', chunk);
    if (data) {
      for (const row of data) {
        existing.add(row.trustpilot_url);
      }
    }
  }

  const filtered = leads.filter((l) => !l.trustpilot_url || !existing.has(l.trustpilot_url));
  return { filtered, skippedCount: leads.length - filtered.length };
}

export async function runScrapeJob(params: ScrapeParams): Promise<void> {
  const { jobId, country, category, minRating, maxRating, enrich, verify, forceRescrape } = params;
  const tmpDir = path.resolve(config.projectRoot, '.tmp');
  let failedCount = 0;

  try {
    await updateJob(jobId, { status: 'running', started_at: new Date().toISOString() });
    emitProgress(jobId, 'started', '');

    // Step 1: Category scrape
    const rawOutput = path.join(tmpDir, `${jobId}_raw.json`);
    const { promise: categoryPromise } = runPython(jobId, 'tools/scraper/scrape_category.py', [
      '--country', country,
      '--category', category,
      '--min-rating', String(minRating),
      '--max-rating', String(maxRating),
      '--output', rawOutput,
    ]);
    await categoryPromise;

    // Read raw results and update found count
    let rawData: Array<Record<string, unknown>> = [];
    try {
      rawData = JSON.parse(fs.readFileSync(rawOutput, 'utf-8'));
      await updateJob(jobId, { total_found: rawData.length });
      emitProgress(jobId, 'category_done', String(rawData.length));
    } catch (err) {
      console.error(`Failed to read raw output for job ${jobId}:`, err);
      emitProgress(jobId, 'category_done', '0');
    }

    // Step 2: Deduplication (unless forceRescrape)
    let leadsToScrape = rawData;
    let skippedCount = 0;

    if (!forceRescrape && rawData.length > 0) {
      emitProgress(jobId, 'dedup_start', String(rawData.length));
      const dedup = await deduplicateLeads(rawData);
      leadsToScrape = dedup.filtered;
      skippedCount = dedup.skippedCount;
      await updateJob(jobId, { total_skipped: skippedCount });
      emitProgress(jobId, 'dedup_done', `${skippedCount}/${rawData.length}`);

      if (leadsToScrape.length === 0) {
        if (!enrich) {
          // Nothing new and enrichment disabled — done
          await updateJob(jobId, {
            status: 'completed',
            total_scraped: 0,
            completed_at: new Date().toISOString(),
          });
          emitProgress(jobId, 'completed', `All ${rawData.length} profiles already in database`);
          return;
        }

        // All new leads already in DB, but enrichment is ON — check for existing leads
        // that have a website_url but never got a website_email yet.
        emitProgress(jobId, 'enrich_start', '');
        const unEnriched = await fetchUnenrichedLeads(country, category);
        if (unEnriched.length === 0) {
          await updateJob(jobId, {
            status: 'completed',
            total_scraped: 0,
            completed_at: new Date().toISOString(),
          });
          emitProgress(jobId, 'completed', `All ${rawData.length} profiles already in database with emails found`);
          return;
        }

        // Enrich only the existing un-enriched leads then save
        emitProgress(jobId, 'enrich_start', `${unEnriched.length} existing leads need enrichment`);
        const enrichOnlyFile = path.join(tmpDir, `${jobId}_enriched.json`);
        fs.writeFileSync(enrichOnlyFile, JSON.stringify(unEnriched, null, 2));

        const { promise: enrichOnlyPromise } = runPython(jobId, 'tools/scraper/scrape_website.py', [
          '--input', enrichOnlyFile,
          '--output', enrichOnlyFile,
          '--parallel', '3',
        ]);
        await enrichOnlyPromise;

        emitProgress(jobId, 'final_save', 'Saving enriched data...');
        const { promise: saveOnlyPromise } = runPython(jobId, 'tools/db/upsert_leads.py', [
          '--input', enrichOnlyFile,
        ]);
        await saveOnlyPromise;

        let enrichedCount = 0;
        try {
          const enrichedData = JSON.parse(fs.readFileSync(enrichOnlyFile, 'utf-8'));
          enrichedCount = enrichedData.length;
        } catch {}

        await updateJob(jobId, {
          status: 'completed',
          total_scraped: enrichedCount,
          completed_at: new Date().toISOString(),
        });
        emitProgress(jobId, 'completed', '');
        return;
      }

      // Write deduped list for profile scraper
      const dedupedOutput = path.join(tmpDir, `${jobId}_deduped.json`);
      fs.writeFileSync(dedupedOutput, JSON.stringify(leadsToScrape, null, 2));
    }

    // Step 3: Profile scrape
    const profileInput = !forceRescrape && skippedCount > 0
      ? path.join(tmpDir, `${jobId}_deduped.json`)
      : rawOutput;
    const enrichedOutput = path.join(tmpDir, `${jobId}_enriched.json`);
    const screenshotsDir = path.join(tmpDir, 'screenshots');

    const { promise: profilePromise } = runPython(jobId, 'tools/scraper/scrape_profile.py', [
      '--input', profileInput,
      '--output', enrichedOutput,
      '--screenshots-dir', screenshotsDir,
      '--parallel', '2',
    ]);
    await profilePromise;

    // Step 4: Checkpoint — upsert profile results immediately
    emitProgress(jobId, 'checkpoint_save', 'Saving profile data...');
    const { promise: checkpointPromise } = runPython(jobId, 'tools/db/upsert_leads.py', [
      '--input', enrichedOutput,
    ]);
    await checkpointPromise;
    emitProgress(jobId, 'checkpoint_done', 'Profile data saved');

    // Step 4b: Upload screenshots to Supabase Storage (persists across deploys)
    await uploadScreenshotsToStorage(screenshotsDir, enrichedOutput);

    // Step 5: Website enrichment (optional)
    if (enrich) {
      // Also pull in existing leads (same country+category) that have website_url
      // but never got a website_email — happens when enrichment was off on the original scrape,
      // or when a previous enrichment failed (e.g. encoding crash).
      try {
        const newlyScrapedUrls = new Set(
          (JSON.parse(fs.readFileSync(enrichedOutput, 'utf-8')) as Array<Record<string, unknown>>)
            .map((l) => l['trustpilot_url'] as string)
            .filter(Boolean),
        );
        const existingUnEnriched = await fetchUnenrichedLeads(country, category, newlyScrapedUrls);
        if (existingUnEnriched.length > 0) {
          const newlyScraped = JSON.parse(fs.readFileSync(enrichedOutput, 'utf-8')) as Array<Record<string, unknown>>;
          const merged = [...newlyScraped, ...existingUnEnriched];
          fs.writeFileSync(enrichedOutput, JSON.stringify(merged, null, 2));
          console.log(`[Enrich] Merged ${existingUnEnriched.length} existing un-enriched leads into enrichment batch`);
          emitProgress(jobId, 'enrich_start', `${merged.length} leads (${existingUnEnriched.length} existing + ${newlyScraped.length} new)`);
        } else {
          emitProgress(jobId, 'enrich_start', '');
        }
      } catch {
        emitProgress(jobId, 'enrich_start', '');
      }

      const { promise: enrichPromise } = runPython(jobId, 'tools/scraper/scrape_website.py', [
        '--input', enrichedOutput,
        '--output', enrichedOutput,
        '--parallel', '3',
      ]);
      await enrichPromise;

      // Step 6: Final upsert with enriched emails
      emitProgress(jobId, 'final_save', 'Saving enriched data...');
      const { promise: finalUpsertPromise } = runPython(jobId, 'tools/db/upsert_leads.py', [
        '--input', enrichedOutput,
      ]);
      await finalUpsertPromise;
    }

    // Count final results
    let totalScraped = 0;
    try {
      const enrichedData = JSON.parse(fs.readFileSync(enrichedOutput, 'utf-8'));
      totalScraped = enrichedData.length;
    } catch (err) {
      console.error(`Failed to read enriched output for job ${jobId}:`, err);
    }

    // Count failures from DB
    try {
      const supabase = getSupabase();
      const { count } = await supabase
        .from('scrape_failures')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .eq('resolved', false);
      failedCount = count || 0;
    } catch (err) {
      console.error(`Failed to count failures for job ${jobId}:`, err);
    }

    await updateJob(jobId, {
      status: 'completed',
      total_scraped: totalScraped,
      total_failed: failedCount,
      completed_at: new Date().toISOString(),
    });
    emitProgress(jobId, 'completed', '');

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Scrape job ${jobId} failed:`, message);
    await updateJob(jobId, {
      status: 'failed',
      error: message.slice(0, 500),
      total_failed: failedCount,
      completed_at: new Date().toISOString(),
    });
    emitProgress(jobId, 'failed', message.slice(0, 200));
  }
}
