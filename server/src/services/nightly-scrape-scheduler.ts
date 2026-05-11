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

  const settings = await getSettings();
  const enabled = settings.nightly_scrape_enabled;
  const runNow = isRunNowActive();

  if (!enabled && !runNow) return;
  if (settings.nightly_scheduler_paused_reason && !runNow) return;

  // Window check (skipped during run-now override)
  if (!runNow) {
    const hour = currentHourInTz(settings.nightly_scrape_timezone);
    const { nightly_scrape_start_hour: s, nightly_scrape_end_hour: e } = settings;
    const inWindow = s === e ? false : (s < e ? hour >= s && hour < e : hour >= s || hour < e);
    if (!inWindow) return;
  }

  // Logic for cap-cancel, auto-pause, and dequeue is added in later tasks.
  console.log(`${LOG_PREFIX} tick OK (enabled=${enabled} runNow=${runNow})`);
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
