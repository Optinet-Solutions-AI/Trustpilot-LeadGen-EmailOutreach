// Bulk + per-lead Trustpilot "Profile Claimed" recheck job.
//
// Mirrors link-check-job.ts: same registry shape, same SSE event names, same
// Playwright launch + stealth pool. Different write target — only writes
// `profile_claimed` (true/false), and skips the write entirely on null so a
// transient detection miss doesn't clobber a previously-known true/false.
import { EventEmitter } from 'events';
import type { Browser, BrowserContext } from 'playwright';
import { launchBrowser, TIER_CONFIGS } from './scrapers/browser-launcher.js';
import { handleCloudflareChallenge } from './scrapers/popup-handler.js';
import { sanitizeTrustpilotUrl } from './url-validator.js';
import { detectProfileClaimed } from './claimed-detector.js';
import { getSupabase } from '../lib/supabase.js';

export interface ClaimedCheckJob {
  status: 'running' | 'completed' | 'failed';
  total: number;
  checked: number;
  claimed: number;
  unclaimed: number;
  unknown: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ClaimedCheckRegistry {
  jobs: Map<string, ClaimedCheckJob>;
  events: EventEmitter;
}

export function createRegistry(): ClaimedCheckRegistry {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  return { jobs: new Map(), events };
}

export function newJob(): ClaimedCheckJob {
  return {
    status: 'running',
    total: 0,
    checked: 0,
    claimed: 0,
    unclaimed: 0,
    unknown: 0,
    startedAt: new Date().toISOString(),
  };
}

const PLAYWRIGHT_CONCURRENCY = 5;
const NAV_TIMEOUT_MS = 25_000;

export async function runClaimedCheckJob(
  jobId: string,
  ids: string[],
  registry: ClaimedCheckRegistry,
): Promise<void> {
  const { jobs, events } = registry;
  const emit = (stage: string, detail: string) => {
    events.emit('progress', { jobId, stage, detail, timestamp: new Date().toISOString() });
  };

  const supabase = getSupabase();

  try {
    const { data: rows, error: fetchErr } = await supabase
      .from('leads')
      .select('id, trustpilot_url')
      .in('id', ids);
    if (fetchErr) throw new Error(fetchErr.message);

    const targets = (rows ?? [])
      .map((r: { id: string; trustpilot_url: string | null }) => ({
        id: r.id,
        url: sanitizeTrustpilotUrl(r.trustpilot_url),
      }))
      .filter((r): r is { id: string; url: string } => Boolean(r.url));

    const job = jobs.get(jobId)!;
    job.total = targets.length;
    emit('check_start', String(targets.length));

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      const bundle = await launchBrowser(TIER_CONFIGS[2]);
      browser = bundle.browser;
      context = bundle.context;
    } catch (e) {
      throw new Error(
        `Playwright launch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const concurrency = Math.min(PLAYWRIGHT_CONCURRENCY, targets.length);

    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async (_, workerIdx) => {
      while (cursor < targets.length) {
        const i = cursor++;
        const target = targets[i];
        emit('check_item', `${i + 1}|${targets.length}|${target.url}`);

        let result: boolean | null = null;
        let workerError: string | null = null;

        const page = await context!.newPage();
        try {
          try {
            await page.goto(target.url, {
              waitUntil: 'domcontentloaded',
              timeout: NAV_TIMEOUT_MS,
            });
          } catch (e) {
            workerError = e instanceof Error ? e.message : String(e);
          }

          if (!workerError) {
            await handleCloudflareChallenge(page).catch(() => false);
            try {
              await page.waitForSelector('h1', { timeout: 5_000 });
            } catch {
              // h1 may not be present on every layout; proceed anyway
            }
            result = await detectProfileClaimed(page);
          }
        } catch (e) {
          workerError = e instanceof Error ? e.message : String(e);
          console.error(`[claimed-check-job] worker ${workerIdx} threw on ${target.url}:`, workerError);
        } finally {
          await page.close().catch(() => undefined);
        }

        if (result === true) job.claimed++;
        else if (result === false) job.unclaimed++;
        else job.unknown++;
        job.checked++;

        // Skip the upsert when result is null so we don't clobber a previous
        // true/false on a transient nav failure or detection miss.
        if (result !== null) {
          try {
            await supabase
              .from('leads')
              .update({ profile_claimed: result })
              .eq('id', target.id);
          } catch (e) {
            console.error(`[claimed-check-job] DB update failed for ${target.id}:`, e);
          }
        }

        const verdict = result === true ? 'claimed' : result === false ? 'unclaimed' : 'unknown';
        emit('check_progress', `${job.checked}/${targets.length}|${target.url}|${verdict}`);
      }
    });

    try {
      await Promise.all(workers);
    } finally {
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    emit(
      'completed',
      JSON.stringify({
        total: job.total,
        checked: job.checked,
        claimed: job.claimed,
        unclaimed: job.unclaimed,
        unknown: job.unknown,
      }),
    );
  } catch (err) {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date().toISOString();
    }
    emit('failed', err instanceof Error ? err.message : String(err));
  }
}
