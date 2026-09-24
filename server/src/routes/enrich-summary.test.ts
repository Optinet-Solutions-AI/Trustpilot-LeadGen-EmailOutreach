/**
 * The completion block used to write `total_failed: dbFailed` — *database
 * write* failures, which are essentially always 0 — over the live count of
 * leads that yielded no email. So every `completed` chunk reported failed=0
 * and the run became unauditable: on 2026-09-04 a day's 73 chunks could not
 * say how many of ~1,575 leads came back empty (the real answer, 920, had to
 * be recovered from the driver's own state file).
 */
import { describe, it, expect } from 'vitest';
import { summariseEnrichmentRun } from './enrich.js';

const email = (e: string | null, redirectsTo?: string) => ({ foundEmail: e, redirectsTo });

describe('summariseEnrichmentRun', () => {
  it('reports leads that yielded no email, not database write failures', () => {
    const s = summariseEnrichmentRun(
      [email('a@x.com'), email(null), email(null)],
      { successful: 1, noEmail: 2, dbFailed: 0 },
    );
    expect(s.total_enriched).toBe(1);
    expect(s.total_failed).toBe(2);
  });

  it('counts a redirect-only outcome as skipped, never as found or failed', () => {
    const s = summariseEnrichmentRun(
      [email('a@x.com'), email(null, 'https://operator.com'), email(null)],
      { successful: 1, noEmail: 1, dbFailed: 0 },
    );
    expect(s.total_skipped).toBe(1);
    expect(s.total_enriched).toBe(1);
    expect(s.total_failed).toBe(1);
  });

  it('does not count a redirect that also produced an email as skipped', () => {
    const s = summariseEnrichmentRun(
      [email('a@x.com', 'https://operator.com')],
      { successful: 1, noEmail: 0, dbFailed: 0 },
    );
    expect(s.total_skipped).toBe(0);
  });

  it('makes the three counters add up to the items processed', () => {
    const results = [email('a@x.com'), email('b@x.com'), email(null), email(null, 'https://o.com')];
    const s = summariseEnrichmentRun(results, { successful: 2, noEmail: 1, dbFailed: 0 });
    expect(s.total_enriched + s.total_failed + s.total_skipped).toBe(results.length);
  });

  it('surfaces a lost email instead of swallowing it', () => {
    // dbFailed means an email WAS found and then failed to save — the one
    // outcome that must never be silent.
    const s = summariseEnrichmentRun([email('a@x.com')], { successful: 0, noEmail: 0, dbFailed: 1 });
    expect(s.error).toMatch(/1 .*write/i);
  });

  it('leaves error unset on a clean run', () => {
    const s = summariseEnrichmentRun([email('a@x.com')], { successful: 1, noEmail: 0, dbFailed: 0 });
    expect(s.error).toBeUndefined();
  });
});
