import { describe, test, expect } from 'vitest';
import { parseCostLine, summariseScrapeCost, formatCost } from './scrape-cost.js';

/**
 * What a scrape actually cost, shown on the job rather than guessed at.
 *
 * TripAdvisor and Yelp are the two platforms that cannot be scraped for free —
 * every run spends ScrapingBee credits, Apify items or OpenAI calls, and until
 * now none of it surfaced anywhere. The operator could only find out by
 * reading a vendor dashboard afterwards, which is how the 2026-09-24 incident
 * went unnoticed: a Spanish TripAdvisor run burned 101,595 ScrapingBee credits
 * against a 1,000 allowance and reported "completed, 0 found".
 *
 * Each paid path prints one line per unit of spend:
 *   COST:{platform}|{vendor}|{usd}|{units}|{unitLabel}
 *
 * USD is authoritative where we meter it exactly (OpenAI reports token usage
 * per call). Where we only know the native unit — ScrapingBee credits, Apify
 * items — the USD figure is an ESTIMATE from a configured rate, and is marked
 * as such rather than presented as fact.
 */

describe('parseCostLine', () => {
  test('reads a metered line', () => {
    expect(parseCostLine('COST:tripadvisor|openai|0.3412|4|leads')).toEqual({
      platform: 'tripadvisor', vendor: 'openai', usd: 0.3412, units: 4, unitLabel: 'leads',
    });
  });

  test('reads a line whose USD is an estimate from native units', () => {
    expect(parseCostLine('COST:yelp|apify|0.0550|20|items')).toEqual({
      platform: 'yelp', vendor: 'apify', usd: 0.055, units: 20, unitLabel: 'items',
    });
  });

  test('accepts a line with no USD figure, because the units still matter', () => {
    // ScrapingBee credits are real spend even when the dollar rate is unknown.
    expect(parseCostLine('COST:tripadvisor|scrapingbee||75|credits')).toEqual({
      platform: 'tripadvisor', vendor: 'scrapingbee', usd: 0, units: 75, unitLabel: 'credits',
    });
  });

  test('ignores every other line the scraper prints', () => {
    for (const line of [
      'PROGRESS:listing:5',
      'FAILED:listing|yelp|apify_empty|nothing',
      'Wrote 4 listing rows',
      '',
      'COST:',
      'COST:onlyplatform',
    ]) {
      expect(parseCostLine(line), line).toBeNull();
    }
  });

  test('refuses a line whose numbers are not numbers', () => {
    expect(parseCostLine('COST:yelp|apify|lots|many|items')).toBeNull();
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseCostLine('  COST:yelp|apify|0.01|2|items  ')).not.toBeNull();
  });
});

describe('summariseScrapeCost', () => {
  test('adds up one vendor across many lines', () => {
    // A city-by-city run reports as it goes; the job total is the sum.
    const s = summariseScrapeCost([
      'COST:tripadvisor|openai|0.10|2|leads',
      'COST:tripadvisor|openai|0.20|3|leads',
    ]);
    expect(s.totalUsd).toBeCloseTo(0.30);
    expect(s.byVendor).toEqual([
      { vendor: 'openai', usd: 0.30, units: 5, unitLabel: 'leads' },
    ]);
  });

  test('keeps vendors separate, busiest first', () => {
    const s = summariseScrapeCost([
      'COST:yelp|apify|0.05|20|items',
      'COST:yelp|scrapingbee||150|credits',
      'COST:yelp|apify|0.05|20|items',
    ]);
    expect(s.byVendor.map((v) => v.vendor)).toEqual(['apify', 'scrapingbee']);
    expect(s.byVendor[0]).toEqual({ vendor: 'apify', usd: 0.10, units: 40, unitLabel: 'items' });
    expect(s.byVendor[1]).toEqual({ vendor: 'scrapingbee', usd: 0, units: 150, unitLabel: 'credits' });
  });

  test('reports cost per lead when leads are known', () => {
    const s = summariseScrapeCost(['COST:tripadvisor|openai|0.34|4|leads'], 4);
    expect(s.usdPerLead).toBeCloseTo(0.085);
  });

  test('does not divide by zero on a run that found nothing', () => {
    const s = summariseScrapeCost(['COST:tripadvisor|openai|0.30|0|leads'], 0);
    expect(s.usdPerLead).toBeNull();
    expect(s.totalUsd).toBeCloseTo(0.30);
  });

  test('a free run costs nothing and says so', () => {
    const s = summariseScrapeCost([], 12);
    expect(s.totalUsd).toBe(0);
    expect(s.byVendor).toEqual([]);
    expect(s.usdPerLead).toBeNull();
  });
});

describe('formatCost', () => {
  test('shows small amounts without rounding them to nothing', () => {
    // $0.0032 a lead is the whole argument for batching; "$0.00" hides it.
    expect(formatCost(0.0032)).toBe('$0.0032');
    expect(formatCost(0.085)).toBe('$0.085');
  });

  test('shows larger amounts in plain money', () => {
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(12)).toBe('$12.00');
  });

  test('says free rather than $0.00', () => {
    expect(formatCost(0)).toBe('free');
  });
});
