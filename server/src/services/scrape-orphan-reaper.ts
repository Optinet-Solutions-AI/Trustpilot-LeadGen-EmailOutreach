/**
 * Orphan reaper for scrape_jobs.
 *
 * A scrape_jobs row is "orphaned" when it claims status='running' but no live
 * Python subprocess is driving it. This happens when:
 *   - A Cloud Run instance is killed mid-scrape (heartbeat goes stale)
 *   - The Python process crashes / OOMs without writing 'failed'
 *   - Someone TRUNCATEs scrape_jobs while a scrape is in progress and the
 *     row gets re-created stale
 *
 * Liveness signal: scrape_jobs.last_heartbeat_at, refreshed every 20s by
 * scrape-runner.ts:startHeartbeat. Anything > 3 min stale is dead.
 *
 * This used to live inline in server.ts and only ran on startup. Now it runs
 * on startup AND every 60s, so a heartbeat that goes stale during the
 * lifetime of a long-running Cloud Run instance gets caught quickly instead
 * of waiting for the next deploy.
 */

import { getSupabase } from '../lib/supabase.js';

// Stale-heartbeat threshold. Default 15 min (was 3 min): the old window was
// too aggressive when Supabase has a transient connectivity blip, since
// every scheduler share the same fetch and they all stop heartbeating
// simultaneously. 15 min still catches genuinely dead jobs (Cloud Run
// instance cycle finishes well under that) but survives a 3-5 min
// network/quota hiccup without killing healthy long-running enrich jobs.
// Override via ORPHAN_REAPER_STALE_MS for testing.
const STALE_HEARTBEAT_MS = +(process.env.ORPHAN_REAPER_STALE_MS ?? 15 * 60 * 1000);
const NEVER_BEAT_GRACE_MS = +(process.env.ORPHAN_REAPER_GRACE_MS ?? 5 * 60 * 1000);

export async function reapOrphanedScrapeJobs(label = 'Reaper'): Promise<number> {
  const supabase = getSupabase();
  const now = Date.now();
  const staleHeartbeat = new Date(now - STALE_HEARTBEAT_MS).toISOString();
  const graceStarted = new Date(now - NEVER_BEAT_GRACE_MS).toISOString();

  const { data: running, error: fetchErr } = await supabase
    .from('scrape_jobs')
    .select('id, started_at, last_heartbeat_at')
    .eq('status', 'running');

  if (fetchErr) {
    console.warn(`[${label}] Failed to query running scrape jobs:`, fetchErr.message);
    return 0;
  }

  const orphanIds = (running ?? [])
    .filter((j) => {
      if (j.last_heartbeat_at) return j.last_heartbeat_at < staleHeartbeat;
      return j.started_at ? j.started_at < graceStarted : true;
    })
    .map((j) => j.id);

  if (orphanIds.length === 0) return 0;

  const { error: updErr } = await supabase
    .from('scrape_jobs')
    .update({
      status: 'failed',
      error: 'Orphaned: no heartbeat (scraper died or Cloud Run instance cycled)',
      completed_at: new Date().toISOString(),
    })
    .in('id', orphanIds);

  if (updErr) {
    console.warn(`[${label}] Failed to mark orphans failed:`, updErr.message);
    return 0;
  }

  console.log(`[${label}] Marked ${orphanIds.length} orphaned scrape job(s) as failed`);
  return orphanIds.length;
}

const REAPER_INTERVAL_MS = 60_000;
let reaperTimer: NodeJS.Timeout | null = null;

export function startOrphanReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    void reapOrphanedScrapeJobs('PeriodicReaper').catch((e) => {
      console.error('[PeriodicReaper] Tick error:', e instanceof Error ? e.message : e);
    });
  }, REAPER_INTERVAL_MS);
}

export function stopOrphanReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
