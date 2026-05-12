/**
 * Nightly Scrape Scheduler — DB-driven background daemon that runs
 * scrape jobs across the full country x category matrix inside a
 * configurable daily window (default 00:00-14:00 Asia/Manila).
 *
 * Each tick (every 60s):
 *   1. Write heartbeat to app_settings.nightly_scheduler_last_tick_at
 *   2. Cancel any source='nightly' jobs running > 30 min (wall-clock cap)
 *   3. Auto-pause check: if last 3 nightly completions are all failed+0 leads, disable
 *   4. If enabled + inside window + not paused: dequeue and spawn up to (parallelism - inflight)
 *
 * Every tick is wrapped in try/catch — the daemon never dies from one bad iteration.
 * Heartbeat is written FIRST so a stalled tick still shows as alive up to the last
 * successful tick (use the gap to detect dead daemons in the UI).
 */

import { getSettings, writeSchedulerTick, setPausedReason, updateSettings } from '../db/app-settings.js';
import { getSupabase } from '../lib/supabase.js';
import { COUNTRIES, CATEGORIES } from './scrape-targets.js';
import { createJob } from '../db/scrape-jobs.js';
import { runScrapeJob, cancelScrapeJob } from './scrape-runner.js';

const POLL_INTERVAL_MS = 60_000;
const LOG_PREFIX = '[NightlyScheduler]';

// In-memory "run now" override: epoch ms until which the time-window
// check is bypassed. Process-local — lost on Cloud Run instance restart.
let runNowUntil: number | null = null;

export function setRunNowOverride(ttlMs = 4 * 60 * 60 * 1000): number {
  runNowUntil = Date.now() + ttlMs;
  return runNowUntil;
}

export function isRunNowActive(): boolean {
  return runNowUntil !== null && runNowUntil > Date.now();
}

export function startNightlyScrapeScheduler(): void {
  console.log(`${LOG_PREFIX} Started — polling every ${POLL_INTERVAL_MS / 1000}s`);

  setInterval(async () => {
    try {
      await tick();
    } catch (err) {
      console.error(`${LOG_PREFIX} tick error:`, err instanceof Error ? err.message : err);
    }
  }, POLL_INTERVAL_MS);
}

async function tick(): Promise<void> {
  // Always heartbeat first so even no-op ticks update liveness.
  await writeSchedulerTick();
  await cancelStuckNightlyJobs();

  if (await autoPauseIfFailing()) return;

  const settings = await getSettings();
  const enabled = settings.nightly_scrape_enabled;
  const runNow = isRunNowActive();
  console.log(`${LOG_PREFIX} tick enabled=${enabled} runNow=${runNow} pausedReason=${settings.nightly_scheduler_paused_reason}`);

  if (!enabled && !runNow) return;
  if (settings.nightly_scheduler_paused_reason && !runNow) return;

  // Window check (skipped during run-now override)
  if (!runNow) {
    const hour = currentHourInTz(settings.nightly_scrape_timezone);
    const { nightly_scrape_start_hour: s, nightly_scrape_end_hour: e } = settings;
    const inWindow = s === e ? false : (s < e ? hour >= s && hour < e : hour >= s || hour < e);
    console.log(`${LOG_PREFIX} window hour=${hour} start=${s} end=${e} inWindow=${inWindow}`);
    if (!inWindow) return;
  }

  await dequeueAndSpawn(
    settings.nightly_scrape_parallelism,
    settings.nightly_scrape_rescrape_days,
    settings.nightly_scrape_min_rating,
    settings.nightly_scrape_max_rating,
    settings.nightly_scrape_verify,
  );
}

function currentHourInTz(timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    return Number(fmt.format(new Date()));
  } catch {
    // Bad timezone string — fall back to UTC rather than crash the tick.
    return new Date().getUTCHours();
  }
}

interface Combo {
  country: string;
  category: string;
}

/**
 * Walks CATEGORIES then COUNTRIES (category-major) and returns the first
 * combo that is neither (a) currently running nor (b) successfully scraped
 * within `rescrape_days`. Returns null when nothing is eligible.
 *
 * `excludeKeys` lets the caller skip combos already chosen earlier in
 * the same tick (when filling multiple parallelism slots in one tick).
 */
export async function findNextEligibleCombo(
  rescrapeDays: number,
  excludeKeys: Set<string> = new Set(),
): Promise<Combo | null> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - rescrapeDays * 86400_000).toISOString();

  // One query: every running job + every recent successful job. Cheap.
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('country, category, status, completed_at')
    .or(`status.eq.running,and(status.eq.completed,completed_at.gte.${cutoff})`);
  if (error) {
    console.error(`${LOG_PREFIX} eligibility query error:`, error.message);
    return null;
  }

  const ineligible = new Set<string>();
  for (const row of data ?? []) {
    ineligible.add(`${row.country}::${row.category}`);
  }

  for (const category of CATEGORIES) {
    for (const country of COUNTRIES) {
      const key = `${country}::${category}`;
      if (ineligible.has(key)) continue;
      if (excludeKeys.has(key)) continue;
      return { country, category };
    }
  }
  return null;
}

async function countInflightNightlyJobs(): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('scrape_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'nightly')
    .eq('status', 'running');
  if (error) {
    console.error(`${LOG_PREFIX} inflight count error:`, error.message);
    return Number.POSITIVE_INFINITY;  // Fail closed: skip dequeue this tick
  }
  return count ?? 0;
}

async function dequeueAndSpawn(parallelism: number, rescrapeDays: number,
  minRating: number, maxRating: number, verify: boolean,
): Promise<void> {
  console.log(`${LOG_PREFIX} dequeue start (parallelism=${parallelism}, rescrapeDays=${rescrapeDays})`);
  const inflight = await countInflightNightlyJobs();
  const slots = Math.max(0, parallelism - inflight);
  console.log(`${LOG_PREFIX} dequeue inflight=${inflight} slots=${slots}`);
  if (slots === 0) return;

  const chosenThisTick = new Set<string>();
  for (let i = 0; i < slots; i++) {
    const combo = await findNextEligibleCombo(rescrapeDays, chosenThisTick);
    console.log(`${LOG_PREFIX} dequeue slot=${i} combo=${combo ? `${combo.country}/${combo.category}` : 'null'}`);
    if (!combo) break;

    chosenThisTick.add(`${combo.country}::${combo.category}`);

    try {
      const job = await createJob({
        country: combo.country,
        category: combo.category,
        min_rating: minRating,
        max_rating: maxRating,
        enrich: false,
        verify,
        source: 'nightly',
      });

      console.log(`${LOG_PREFIX} spawn ${combo.country}/${combo.category} job=${job.id}`);

      // Fire-and-forget — runScrapeJob writes status updates itself.
      runScrapeJob({
        jobId: job.id,
        country: combo.country,
        category: combo.category,
        minRating,
        maxRating,
        enrich: false,
        verify,
        forceRescrape: false,
        source: 'nightly',
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} spawn error for ${combo.country}/${combo.category}:`,
        err instanceof Error ? err.message : err);
    }
  }
}

const MAX_JOB_DURATION_MS = 30 * 60 * 1000;

/**
 * Cancel any source='nightly' job that has been in status='running' for
 * over 30 minutes. The per-subprocess heartbeat already catches dead
 * processes within ~60s; this is the wall-clock ceiling for live-but-stuck
 * jobs (e.g., Playwright wedged on a captcha challenge that takes forever
 * to time out). Frees parallelism slots so the night keeps moving.
 */
async function cancelStuckNightlyJobs(): Promise<void> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - MAX_JOB_DURATION_MS).toISOString();

  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('id, country, category, started_at')
    .eq('source', 'nightly')
    .eq('status', 'running')
    .lt('started_at', cutoff);

  if (error) {
    console.error(`${LOG_PREFIX} stuck-job query error:`, error.message);
    return;
  }

  for (const job of data ?? []) {
    console.warn(`${LOG_PREFIX} wall-clock cap: cancelling stuck job ${job.id} ` +
      `(${job.country}/${job.category}, started ${job.started_at})`);
    try {
      await cancelScrapeJob(job.id);
    } catch (err) {
      console.error(`${LOG_PREFIX} cancel error for ${job.id}:`,
        err instanceof Error ? err.message : err);
    }
  }
}

/**
 * If the 3 most recent COMPLETED (success or failed) nightly jobs are all
 * status='failed', auto-pause the scheduler. Trips when Trustpilot blocks
 * the Cloud Run IP, a category-wide outage occurs, or a deploy regression
 * breaks the scrape pipeline. Manual re-enable is required so the operator
 * must intentionally clear the pause.
 */
async function autoPauseIfFailing(): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('status, error')
    .eq('source', 'nightly')
    .in('status', ['completed', 'failed'])
    .order('completed_at', { ascending: false })
    .limit(3);

  if (error) {
    console.error(`${LOG_PREFIX} auto-pause query error:`, error.message);
    return false;
  }

  if ((data?.length ?? 0) < 3) return false;
  // Only count "real" scrape failures. Orphan failures from Cloud Run
  // instance cycling are an infrastructure signal, not a scraper signal —
  // ignoring them keeps the scheduler resilient when one runtime (Cloud
  // Run) churns while another (e.g. local dev or a different replica)
  // is producing leads successfully.
  const realFailures = data!.filter((j) =>
    j.status === 'failed' && !String(j.error ?? '').startsWith('Orphaned:'),
  );
  if (realFailures.length < 3) return false;

  const reason = `auto: 3 consecutive failed nightly jobs (last at ${new Date().toISOString()})`;
  console.error(`${LOG_PREFIX} AUTO-PAUSE: ${reason}`);
  await setPausedReason(reason);
  await updateSettings({ nightly_scrape_enabled: false });
  return true;
}
