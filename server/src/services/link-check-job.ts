// Shared SSE-driven job runner for the bulk link-validation feature.
//
// Both the Leads and Affiliates views need the same UX: kick off a background
// job, stream progress events to the JobProgress panel, persist link_status
// + last_validated_at when each row finishes. The two only differ by which
// table they update (`leads` vs `affiliates`) and which column holds the URL.
import { EventEmitter } from 'events';
import { validateTrustpilotUrl, validateTrustpilotUrlViaPlaywright } from './url-validator.js';
import { launchBrowser, TIER_CONFIGS } from './scrapers/browser-launcher.js';
import { getSupabase } from '../lib/supabase.js';
import type { Browser, BrowserContext } from 'playwright';

export interface LinkCheckJob {
  status: 'running' | 'completed' | 'failed';
  total: number;
  checked: number;
  valid: number;
  flagged_dead: number;
  flagged_removed: number;
  unknown: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface LinkCheckRegistry {
  jobs: Map<string, LinkCheckJob>;
  events: EventEmitter;
}

export function createRegistry(): LinkCheckRegistry {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  return { jobs: new Map(), events };
}

export type LinkCheckSource = 'leads' | 'affiliates';

const URL_COLUMN: Record<LinkCheckSource, string> = {
  leads: 'trustpilot_url',
  affiliates: 'tp_url',
};

// Playwright pages share a single browser context — opening more than ~5 in
// parallel slows the whole batch down because Chromium contention overwhelms
// the cost of the page itself. Plain-fetch / ScrapingBee paths can run wider.
const PLAYWRIGHT_CONCURRENCY = 5;
const FALLBACK_CONCURRENCY = 8;

// VALIDATOR_USE_PLAYWRIGHT=false force-disables the browser path (e.g. local
// debugging or environments without Chromium installed). Defaults on — same
// stealth stack the lead scraper uses, so deliverability of the validator
// matches the scraper that originally captured the lead.
function shouldUsePlaywright(): boolean {
  return process.env.VALIDATOR_USE_PLAYWRIGHT !== 'false';
}

export async function runLinkCheckJob(
  jobId: string,
  source: LinkCheckSource,
  ids: string[],
  registry: LinkCheckRegistry,
): Promise<void> {
  const { jobs, events } = registry;
  const emit = (stage: string, detail: string) => {
    events.emit('progress', { jobId, stage, detail, timestamp: new Date().toISOString() });
  };

  const supabase = getSupabase();
  const urlCol = URL_COLUMN[source];

  try {
    // Dynamic column name — Supabase's static select<> typing can't infer
    // columns from a string variable, so cast through unknown.
    const { data: rows, error: fetchErr } = await supabase
      .from(source)
      .select(`id, ${urlCol}`)
      .in('id', ids);
    if (fetchErr) throw new Error(fetchErr.message);

    const rawRows = (rows ?? []) as unknown as Array<Record<string, string>>;
    const targets = rawRows
      .map((r) => ({ id: r.id, url: r[urlCol] }))
      .filter((r): r is { id: string; url: string } => Boolean(r.url));

    const job = jobs.get(jobId)!;
    job.total = targets.length;
    emit('check_start', String(targets.length));

    const now = new Date().toISOString();

    // Launch ONE stealth Chromium for the whole job — same Tier 2 config the
    // website-enricher uses. Boot cost (~2s) amortizes across every URL in
    // the batch; per-URL marginal cost is just a page navigation.
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    if (shouldUsePlaywright()) {
      try {
        const bundle = await launchBrowser(TIER_CONFIGS[2]);
        browser = bundle.browser;
        context = bundle.context;
      } catch (e) {
        // Fall back to ScrapingBee/HTTP path if Chromium can't launch.
        console.error('[link-check-job] Playwright launch failed, falling back', e);
      }
    }
    const usingPlaywright = !!context;
    const concurrency = Math.min(
      usingPlaywright ? PLAYWRIGHT_CONCURRENCY : FALLBACK_CONCURRENCY,
      targets.length,
    );

    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < targets.length) {
        const i = cursor++;
        const target = targets[i];
        emit('check_item', `${i + 1}|${targets.length}|${target.url}`);

        // Playwright path mirrors the lead-scraper exactly (same stealth +
        // popup-handler + UA rotation). ScrapingBee/plain-fetch is the
        // fallback — used when Chromium can't boot or VALIDATOR_USE_PLAYWRIGHT=false.
        const { status, error } = context
          ? await validateTrustpilotUrlViaPlaywright(context, target.url)
          : await validateTrustpilotUrl(target.url);

        if (status === 'VALID') job.valid++;
        else if (status === 'FLAGGED_DEAD') job.flagged_dead++;
        else if (status === 'FLAGGED_REMOVED') job.flagged_removed++;
        else job.unknown++;
        job.checked++;

        await supabase
          .from(source)
          .update({
            link_status: status,
            last_validated_at: now,
            link_validation_error: error,
          })
          .eq('id', target.id);

        emit('check_progress', `${job.checked}/${targets.length}|${target.url}|${status}`);
      }
    });

    try {
      await Promise.all(workers);
    } finally {
      // Always tear down — leaking a Chromium across job boundaries chews
      // memory until Cloud Run kills the instance.
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
        valid: job.valid,
        flagged_dead: job.flagged_dead,
        flagged_removed: job.flagged_removed,
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

export function newJob(): LinkCheckJob {
  return {
    status: 'running',
    total: 0,
    checked: 0,
    valid: 0,
    flagged_dead: 0,
    flagged_removed: 0,
    unknown: 0,
    startedAt: new Date().toISOString(),
  };
}
