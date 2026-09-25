import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  estimateEnrichCost,
  estimateVerifyCost,
  estimateScrapeCost,
  RunCost,
} from './run-cost.js';

/**
 * Anything that spends money should say so — before the run where that is
 * knowable, and after it where it is not.
 *
 * Scraping already reported its spend. Two others did not: enrichment created
 * a scrape_jobs row and never wrote a cost to it, so tier 10 could spend
 * invisibly; verification had no job row at all, so ZeroBounce credits
 * vanished entirely.
 */

let saved: string | undefined;
beforeEach(() => { saved = process.env.ZEROBOUNCE_USD_PER_CREDIT; });
afterEach(() => {
  if (saved === undefined) delete process.env.ZEROBOUNCE_USD_PER_CREDIT;
  else process.env.ZEROBOUNCE_USD_PER_CREDIT = saved;
});

describe('estimateEnrichCost', () => {
  test('is free when the paid tier is off', () => {
    // Every tier before 10 is free or running on a dead account, so the
    // honest answer is zero — not a guess at credits nobody pays for.
    const e = estimateEnrichCost(500, { openAiEnabled: false });
    expect(e.usd).toBe(0);
    expect(e.summary).toContain('free');
  });

  test('prices the paid tier at the measured rate', () => {
    const e = estimateEnrichCost(200, { openAiEnabled: true });
    expect(e.usd).toBeCloseTo(9.4);          // 200 x $0.047
    expect(e.isCeiling).toBe(true);           // not every lead yields an address
  });

  test('respects the per-run ceiling rather than quoting the whole queue', () => {
    // 8,314 leads at $0.047 is ~$390; a 200-call cap means the run cannot
    // spend that, and quoting $390 would be wrong.
    const e = estimateEnrichCost(8314, { openAiEnabled: true, maxCalls: 200 });
    expect(e.usd).toBeCloseTo(9.4);
    expect(e.units).toBe(200);
    expect(e.summary).toContain('capped at 200');
  });

  test('says what the money actually buys', () => {
    expect(estimateEnrichCost(10, { openAiEnabled: true }).summary).toContain('60%');
  });

  test('handles an empty queue', () => {
    expect(estimateEnrichCost(0, { openAiEnabled: true }).usd).toBe(0);
  });
});

describe('estimateVerifyCost', () => {
  test('reports credits and NO dollars when no rate is configured', () => {
    // Inventing a rate is worse than reporting none — the figure gets quoted
    // back as fact. Same rule ScrapingBee credits follow.
    delete process.env.ZEROBOUNCE_USD_PER_CREDIT;
    const e = estimateVerifyCost(250);
    expect(e.usd).toBeNull();
    expect(e.units).toBe(250);
    expect(e.summary).toContain('credits');
  });

  test('prices it once a rate is configured', () => {
    process.env.ZEROBOUNCE_USD_PER_CREDIT = '0.008';
    const e = estimateVerifyCost(250);
    expect(e.usd).toBeCloseTo(2.0);
  });

  test('ignores a nonsense rate rather than pricing from it', () => {
    for (const bad of ['free', '-1', '0']) {
      process.env.ZEROBOUNCE_USD_PER_CREDIT = bad;
      expect(estimateVerifyCost(100).usd, bad).toBeNull();
    }
  });

  test('one credit per address', () => {
    delete process.env.ZEROBOUNCE_USD_PER_CREDIT;
    expect(estimateVerifyCost(37).units).toBe(37);
  });
});

describe('estimateScrapeCost', () => {
  test('is a ceiling, because a scrape discovers what nobody has counted', () => {
    const e = estimateScrapeCost(10, 150, 0.0029);
    expect(e.units).toBe(1500);
    expect(e.usd).toBeCloseTo(4.35);
    expect(e.isCeiling).toBe(true);
  });

  test('warns that most fetched items are discarded', () => {
    // Measured ~1 kept per 7 fetched; without this the ceiling looks like a
    // per-lead price and reads as far worse value than it is.
    expect(estimateScrapeCost(10, 150, 0.0029).summary).toContain('7');
  });

  test('a single city is a much smaller ceiling', () => {
    expect(estimateScrapeCost(1, 150, 0.0029).usd).toBeCloseTo(0.435);
  });
});

describe('RunCost', () => {
  test('records nothing for a run that spent nothing', () => {
    const c = new RunCost();
    expect(c.isEmpty).toBe(true);
    expect(c.toJobPatch()).toEqual({});
  });

  test('accumulates one vendor across many calls', () => {
    const c = new RunCost();
    c.add('openai', 0.047, 1, 'lookups');
    c.add('openai', 0.047, 1, 'lookups');
    expect(c.totalUsd).toBeCloseTo(0.094);
    const patch = c.toJobPatch() as { cost_detail: { byVendor: unknown[] } };
    expect(patch.cost_detail.byVendor).toEqual([
      { vendor: 'openai', usd: 0.094, units: 2, unitLabel: 'lookups' },
    ]);
  });

  test('keeps vendors separate, dearest first', () => {
    const c = new RunCost();
    c.add('zerobounce', 0, 100, 'credits');
    c.add('openai', 0.47, 10, 'lookups');
    const patch = c.toJobPatch() as { cost_detail: { byVendor: Array<{ vendor: string }> } };
    expect(patch.cost_detail.byVendor.map((v) => v.vendor)).toEqual(['openai', 'zerobounce']);
  });

  test('records a vendor that spent units but no dollars', () => {
    // ZeroBounce credits are real spend even with no USD rate configured.
    const c = new RunCost();
    c.add('zerobounce', 0, 250, 'credits');
    expect(c.isEmpty).toBe(false);
    expect(c.totalUsd).toBe(0);
    expect((c.toJobPatch() as { cost_usd: number }).cost_usd).toBe(0);
  });

  test('reports cost per lead when the yield is known', () => {
    const c = new RunCost();
    c.add('openai', 0.47, 10, 'lookups');
    const patch = c.toJobPatch(6) as { cost_detail: { usdPerLead: number } };
    expect(patch.cost_detail.usdPerLead).toBeCloseTo(0.078);  // 6 found of 10 tried
  });

  test('does not divide by a zero yield', () => {
    const c = new RunCost();
    c.add('openai', 0.47, 10, 'lookups');
    expect((c.toJobPatch(0) as { cost_detail: { usdPerLead: null } }).cost_detail.usdPerLead)
      .toBeNull();
  });

  test('ignores a negative or broken charge', () => {
    const c = new RunCost();
    c.add('openai', Number.NaN, 1);
    c.add('openai', -5, 1);
    expect(c.totalUsd).toBe(0);
  });
});
