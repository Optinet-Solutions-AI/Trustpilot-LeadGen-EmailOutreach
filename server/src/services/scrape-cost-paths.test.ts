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
  test('there is at least one completion, so the count is meaningful', () => {
    const completions = SOURCE.match(/status: 'completed'/g) ?? [];
    expect(completions.length).toBeGreaterThan(0);
  });

  test('each completion is matched by a costPatch call', () => {
    const completions = (SOURCE.match(/status: 'completed'/g) ?? []).length;
    const costWrites = (SOURCE.match(/\.\.\.costPatch\(jobId/g) ?? []).length;

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
    const costWrites = (SOURCE.match(/\.\.\.costPatch\(jobId/g) ?? []).length;
    const releases = (SOURCE.match(/jobCostLines\.delete\(jobId\)/g) ?? []).length;
    expect(releases).toBe(costWrites);
  });
});
