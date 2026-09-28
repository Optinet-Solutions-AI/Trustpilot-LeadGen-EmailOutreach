import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every place a scrape job is marked finished must record what it spent.
 *
 * Cost lines are collected off the scraper's stdout into a per-job bucket and
 * written when the job completes. That only works if the completion the job
 * ACTUALLY reaches writes them.
 *
 * Measured 2026-09-24: the first successful OpenAI TripAdvisor run found 41
 * leads and recorded `cost_usd = NULL`. The collection worked; the write did
 * not. `runScrapeJobViaRunPy` — the function every plugin scrape goes through
 * — has its own completion, and the two that had been patched belonged to the
 * legacy Trustpilot path and a no-cities early return. The spend was gathered
 * and dropped on the floor.
 *
 * This counts the completions and the cost writes and requires them to match,
 * so adding a new exit without recording spend fails here rather than showing
 * the operator a blank cost after a paid run.
 */

const SOURCE = readFileSync(
  join(import.meta.dirname, 'scrape-runner.ts'),
  'utf8',
);

describe('every job completion records its cost', () => {
  // The cancel path is excluded from these counts and guarded on its own
  // below: it cannot use the `...costPatch(jobId)` spread, because a job that
  // ran on a worker leaves no COST: lines in THIS process and it has to fall
  // back to the row's progress events.
  const EXITS = SOURCE.slice(0, SOURCE.indexOf('export async function cancelScrapeJob'))
    + SOURCE.slice(SOURCE.indexOf('export function getActiveProcesses'));

  test('there is at least one completion, so the count is meaningful', () => {
    const completions = EXITS.match(/status: 'completed'/g) ?? [];
    expect(completions.length).toBeGreaterThan(0);
  });

  test('each completion is matched by a costPatch call', () => {
    const completions = (EXITS.match(/status: 'completed'/g) ?? []).length;
    const costWrites = (EXITS.match(/\.\.\.costPatch\(jobId/g) ?? []).length;

    expect(costWrites, [
      `${completions} places mark a job completed but only ${costWrites} record`,
      'what it spent. A scrape that finishes without writing its cost shows the',
      'operator a blank figure after a paid run — which is indistinguishable',
      'from a free one. Add `...costPatch(jobId, <leads>)` to the new completion.',
    ].join(' ')).toBe(completions);
  });

  test('the bucket is released wherever cost is written, so jobs do not leak', () => {
    // jobCostLines is a module-level Map keyed by job id. A completion that
    // writes cost but never deletes its entry grows the map for the life of
    // the process.
    const costWrites = (EXITS.match(/\.\.\.costPatch\(jobId/g) ?? []).length;
    const releases = (EXITS.match(/jobCostLines\.delete\(jobId\)/g) ?? []).length;
    expect(releases).toBe(costWrites);
  });
});

/**
 * Enrichment that runs INSIDE a scrape must book its spend too.
 *
 * The Python scrapers report spend by printing `COST:` lines, collected off
 * the child's stdout. The website enricher prints the same line — but it runs
 * in-process, so its output goes to the service log and reaches no child
 * handler. A scrape with "find emails" ticked could therefore run tier 10, at
 * $0.047 a lead, and report a cost of zero.
 *
 * The fix routes it through `recordJobSpend`, and these guard the two ways it
 * silently reverts: the call site disappearing, and the enricher no longer
 * telling anyone what a lead cost.
 */
describe('in-scrape enrichment books its spend', () => {
  test('the enricher event stream is what records it', () => {
    // Per event, not totalled after the await: the enrichment watchdog
    // abandons its results at 45 minutes and money already spent must survive.
    const onEvent = /onEvent:\s*\(event\)\s*=>\s*\{[\s\S]{0,400}?recordJobSpend\(jobId/;
    expect(SOURCE).toMatch(onEvent);
  });

  test('the enricher hands every outcome its cost, not just the hits', () => {
    // A tier-10 miss costs the same as a hit. Counting only hits would
    // understate the bill by the ~40% that find nothing.
    const enricher = readFileSync(join(import.meta.dirname, 'scrapers/website-enricher.ts'), 'utf8');
    const events = enricher.slice(enricher.indexOf('export type EnricherEvent'));
    for (const outcome of ['enrich_email', 'enrich_no_email', 'enrich_redirected', 'enrich_failed']) {
      const decl = new RegExp(`type: '${outcome}'[^}]*usd[?]: number`);
      expect(events, outcome).toMatch(decl);
    }
  });

  test('nothing is spent at enrich_start, so it carries no cost', () => {
    const enricher = readFileSync(join(import.meta.dirname, 'scrapers/website-enricher.ts'), 'utf8');
    const decl = /type: 'enrich_start'[^}]*\}/.exec(enricher)?.[0] ?? '';
    expect(decl).not.toContain('usd');
  });
});

/**
 * Cancelling a run does not un-spend its money.
 *
 * A Trustpilot job cancelled after 6 proxied pages had spent $0.081 and was
 * written to the row as no cost at all. The guard above counts only
 * `status: 'completed'` exits, so the cancel path — which writes
 * `status: 'failed'` — was never covered by it.
 *
 * The spend is recoverable even when the job ran on a WORKER rather than in
 * this process: the runner emits a `cost` progress event per charge, and those
 * land on the row. So cancel has a source of truth either way.
 */
describe('cancelling a job still records what it spent', () => {
  const CANCEL = SOURCE.slice(
    SOURCE.indexOf('export async function cancelScrapeJob'),
    SOURCE.indexOf('export function getActiveProcesses'),
  );

  test('the cancel path exists and marks the job failed', () => {
    expect(CANCEL).toContain("status: 'failed'");
  });

  test('it writes a cost alongside that status', () => {
    expect(CANCEL).toMatch(/costPatch\(|cost_usd/);
  });
});
