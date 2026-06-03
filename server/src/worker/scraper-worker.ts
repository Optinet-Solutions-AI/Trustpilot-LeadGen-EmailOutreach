/**
 * Scraper Worker — polls Supabase for pending scrape jobs and runs them.
 *
 * Designed to run on a persistent EC2 box (no auto-scaling), separate from
 * the Cloud Run API. The API enqueues jobs; this worker dequeues and runs.
 *
 * Concurrency cap is enforced in two places (defense in depth):
 *   1. In-process semaphore (inFlight map vs MAX_CONCURRENT) — fast path
 *   2. RPC `claim_next_pending_scrape_job` rejects claims past p_max_concurrent
 *
 * Heartbeats, status writes, and Python subprocess management all live
 * inside runScrapeJob — the worker just orchestrates the queue interaction.
 */

import os from 'os';
import {
  claimNextPendingJob,
  markJobFailed,
  releaseStaleClaims,
  type ScrapeJob,
} from '../db/scrape-jobs.js';
import { runScrapeJob, getActiveProcesses } from '../services/scrape-runner.js';

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS ?? 3));
const POLL_INTERVAL_MS = Math.max(5_000, Number(process.env.POLL_INTERVAL_MS ?? 30_000));
const WORKER_ID = process.env.WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
// Platform routing (added 2026-06-02 for the Windows EC2 worker).
// PLATFORM_FILTER  — when set, this worker only claims jobs whose
//                    scrape_jobs.platform matches (e.g. 'facebook' on
//                    the Windows EC2 box).
// PLATFORM_EXCLUDE — when set, this worker claims jobs whose platform
//                    does NOT match (e.g. 'facebook' on the Linux EC2
//                    box, which can't run FB scrapes).
// Both default to undefined → null on the wire → no filtering applied
// (preserves the pre-migration-043 behavior).
const PLATFORM_FILTER = process.env.PLATFORM_FILTER || null;
const PLATFORM_EXCLUDE = process.env.PLATFORM_EXCLUDE || null;
const STALE_SWEEP_INTERVAL_MS = 5 * 60_000;
const STALE_MAX_AGE_MIN = 10;
const DRAIN_TIMEOUT_MS = 60_000;

const inFlight = new Map<string, ScrapeJob>();
let shuttingDown = false;

function log(msg: string, ...rest: unknown[]): void {
  console.log(`[Worker ${WORKER_ID}] ${msg}`, ...rest);
}

async function processJob(job: ScrapeJob): Promise<void> {
  inFlight.set(job.id, job);
  log(
    `claimed job=${job.id} ${job.country}/${job.category} attempt=${job.attempts}/${job.max_attempts} ` +
    `inflight=${inFlight.size}/${MAX_CONCURRENT}`,
  );

  try {
    // runScrapeJob owns the heartbeat, progress events, and final status write.
    // It only throws on uncaught programming errors; expected failures are
    // captured into status='failed' inside the function.
    //
    // platform + filters are CRITICAL — without them, runScrapeJob defaults
    // to platform='trustpilot' and routes the legacy Trustpilot pipeline at
    // any non-Trustpilot job (e.g. a TripAdvisor scrape claimed by the EC2
    // worker would run the legacy /review/<slug> scraper against TA URLs and
    // save zero leads). Bug discovered 2026-05-19 when BR/TR TripAdvisor
    // scrapes claimed by the worker showed total_scraped=0 / total_skipped=1.
    await runScrapeJob({
      jobId: job.id,
      country: job.country,
      category: job.category,
      minRating: job.min_rating,
      maxRating: job.max_rating,
      enrich: job.enrich,
      verify: job.verify,
      source: job.source,
      platform: job.platform,
      filters: job.filters ?? undefined,
      socialAccountId: job.social_account_id,
    });
    log(`finished job=${job.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`job=${job.id} unhandled error: ${msg}`);
    // Backstop: if runScrapeJob threw before writing terminal status,
    // markJobFailed decides between re-queue (retry budget) and permanent failure.
    await markJobFailed(job.id, msg).catch((e) => {
      log(`markJobFailed(${job.id}) errored: ${e instanceof Error ? e.message : e}`);
    });
  } finally {
    inFlight.delete(job.id);
  }
}

async function pollOnce(): Promise<void> {
  if (shuttingDown) return;
  // Try to fill open slots — claim until we hit the cap or the queue is empty.
  while (!shuttingDown && inFlight.size < MAX_CONCURRENT) {
    let job: ScrapeJob | null;
    try {
      job = await claimNextPendingJob(WORKER_ID, MAX_CONCURRENT, PLATFORM_FILTER, PLATFORM_EXCLUDE);
    } catch (err) {
      log(`claim error: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!job) return;
    // Fire-and-forget; the loop continues and may claim another job in the same tick.
    void processJob(job);
  }
}

async function sweepStale(): Promise<void> {
  try {
    const n = await releaseStaleClaims(STALE_MAX_AGE_MIN);
    if (n > 0) log(`released ${n} stale claim(s)`);
  } catch (err) {
    log(`stale sweep error: ${err instanceof Error ? err.message : err}`);
  }
}

async function drainOrAbandon(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal} — stopping claims, draining ${inFlight.size} in-flight job(s)`);

  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (inFlight.size > 0) {
    // Time's up. Kill the Python subprocesses so systemd's restart cycle
    // doesn't leak Chromium. release_stale_scrape_claims will pick up the
    // orphaned rows within ~10 min and re-queue them (attempts permitting).
    log(`drain timeout — killing ${inFlight.size} in-flight Python subprocess(es)`);
    const procs = getActiveProcesses();
    for (const [jobId, proc] of procs) {
      try {
        if (process.platform === 'win32') {
          // Windows kill is best-effort here; the next stale sweep recovers it
          proc.kill();
        } else if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch {}
      log(`killed subprocess for job=${jobId}`);
    }
  }

  process.exit(0);
}

async function main(): Promise<void> {
  log(
    `starting max_concurrent=${MAX_CONCURRENT} poll=${POLL_INTERVAL_MS}ms ` +
    `platform_filter=${PLATFORM_FILTER ?? '<none>'} platform_exclude=${PLATFORM_EXCLUDE ?? '<none>'}`,
  );

  // Initial sweep so a fresh worker reclaims jobs orphaned by a previous one.
  await sweepStale();

  const pollTimer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  const sweepTimer = setInterval(() => { void sweepStale(); }, STALE_SWEEP_INTERVAL_MS);

  process.on('SIGTERM', () => {
    clearInterval(pollTimer);
    clearInterval(sweepTimer);
    void drainOrAbandon('SIGTERM');
  });
  process.on('SIGINT', () => {
    clearInterval(pollTimer);
    clearInterval(sweepTimer);
    void drainOrAbandon('SIGINT');
  });

  // Don't wait for the first interval tick — start polling right away.
  await pollOnce();
}

main().catch((err) => {
  console.error('[Worker] fatal:', err);
  process.exit(1);
});
