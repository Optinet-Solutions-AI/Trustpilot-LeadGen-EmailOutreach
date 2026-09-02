import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => {
  return { from: vi.fn() };
});

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => mockSupabase,
}));

import { getLeads, getLeadIds, getVerificationCounts } from './leads.js';

/**
 * Chainable query-builder mock that records every method call, mirroring the
 * pattern in scrape-jobs.test.ts / tripadvisor-cities.test.ts.
 */
function makeQueryChain(result: { data: unknown; error: unknown; count?: number | null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const linkers = ['select', 'eq', 'neq', 'ilike', 'or', 'gte', 'lte', 'not', 'is', 'in', 'order', 'limit', 'range'];

  for (const m of linkers) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);

  return { chain, calls };
}

function argsFor(calls: Array<{ method: string; args: unknown[] }>, method: string): unknown[][] {
  return calls.filter((c) => c.method === method).map((c) => c.args);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getLeads category filter', () => {
  /**
   * The presenting bug: one trade is stored under several labels because each
   * platform writes its own taxonomy string, so a single ILIKE found only
   * some of them. Filtering `plumber` must now reach the rows spelled
   * `plumbers` AND `plumbing` (109 live rows, not 43).
   */
  test('expands a category to its whole family as one or-expression', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ category: 'plumber' });

    expect(argsFor(calls, 'or')).toEqual([['category.ilike.%plumber%,category.ilike.%plumbing%']]);
    // No bare single-column ILIKE on category any more — that was the bug.
    expect(argsFor(calls, 'ilike').filter(([col]) => col === 'category')).toEqual([]);
  });

  test('reaches the same family from any spelling the platforms write', async () => {
    for (const spelling of ['plumbers', 'plumbing', 'PLUMBER', ' Plumbing ']) {
      const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
      mockSupabase.from.mockReturnValue(chain);

      await getLeads({ category: spelling });

      expect(argsFor(calls, 'or'), spelling).toEqual([
        ['category.ilike.%plumber%,category.ilike.%plumbing%'],
      ]);
    }
  });

  test('electricians and electrician resolve to one filter', async () => {
    for (const spelling of ['electrician', 'electricians']) {
      const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
      mockSupabase.from.mockReturnValue(chain);

      await getLeads({ category: spelling });

      expect(argsFor(calls, 'or'), spelling).toEqual([
        ['category.ilike.%electrical%,category.ilike.%electrician%'],
      ]);
    }
  });

  test('an unsafe category filters on itself only', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ category: 'casino' });

    expect(argsFor(calls, 'or')).toEqual([['category.ilike.%casino%']]);
  });

  test('partial typing is preserved as a substring match', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ category: 'plumb' });

    expect(argsFor(calls, 'or')).toEqual([['category.ilike.%plumb%']]);
  });

  test('category and search each add their own or-expression', async () => {
    // PostgREST ANDs repeated or= params (verified against the live table),
    // so the two filters must not be merged into one.
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ category: 'plumber', search: 'acme' });

    const ors = argsFor(calls, 'or');
    expect(ors).toHaveLength(2);
    expect(ors[0]).toEqual(['category.ilike.%plumber%,category.ilike.%plumbing%']);
    expect(String(ors[1][0])).toContain('company_name.ilike.%acme%');
  });

  test('no category filter adds no or-expression', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ country: 'GB' });

    expect(argsFor(calls, 'or')).toEqual([]);
    expect(argsFor(calls, 'ilike')).toEqual([['country', '%GB%']]);
  });

  test('country keeps its plain substring match', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ category: 'plumber', country: 'new york' });

    expect(argsFor(calls, 'ilike')).toEqual([['country', '%new york%']]);
  });
});

describe('getLeadIds category filter', () => {
  test('uses the same family expansion as getLeads', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    await getLeadIds({ category: 'plumbing' });

    expect(argsFor(calls, 'or')).toEqual([['category.ilike.%plumber%,category.ilike.%plumbing%']]);
    expect(argsFor(calls, 'ilike').filter(([col]) => col === 'category')).toEqual([]);
  });
});

// ── Verification filtering (2026-09-02) ────────────────────────────────────
// "Has Email" was being read as "sendable", campaigns were sized off it, and
// the launches then died at the invalid-email send gate. These cover the
// filters and counts that make the real sendable audience visible.
describe('getLeads verification filter', () => {
  test("'unverified' means the column IS NULL, not the string 'unverified'", async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ verificationStatus: 'unverified' });

    expect(argsFor(calls, 'is')).toContainEqual(['verification_status', null]);
    // Must never reach the column as an equality — 'unverified' is not a
    // stored value and would silently match nothing.
    expect(argsFor(calls, 'eq').filter(([col]) => col === 'verification_status')).toEqual([]);
  });

  test('a real verdict still filters by equality', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ verificationStatus: 'catch-all' });

    expect(argsFor(calls, 'eq')).toContainEqual(['verification_status', 'catch-all']);
    expect(argsFor(calls, 'is').filter(([col]) => col === 'verification_status')).toEqual([]);
  });
});

describe('getLeads ids filter', () => {
  test('restricts to the given id set', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ ids: ['a', 'b'] });

    expect(argsFor(calls, 'in')).toContainEqual(['id', ['a', 'b']]);
  });

  test('an empty id list is ignored rather than matching nothing', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ ids: [] });

    expect(argsFor(calls, 'in').filter(([col]) => col === 'id')).toEqual([]);
  });
});

describe('getVerificationCounts', () => {
  test('every bucket runs through the same filters as the list query', async () => {
    // One chain reused across all the head-count queries — we only care that
    // each carries the caller's filters plus its own verdict.
    const { chain, calls } = makeQueryChain({ data: null, error: null, count: 7 });
    mockSupabase.from.mockReturnValue(chain);

    const counts = await getVerificationCounts({ country: 'SE', hasEmail: true });

    // Same country predicate on every bucket, so a chip can never describe a
    // different population than the rows on screen.
    const countryFilters = argsFor(calls, 'ilike').filter(([col]) => col === 'country');
    expect(countryFilters.length).toBeGreaterThanOrEqual(7);
    expect(countryFilters.every(([, pattern]) => pattern === '%SE%')).toBe(true);

    // The verdict buckets, including NULL for 'unverified'.
    const verdicts = argsFor(calls, 'eq')
      .filter(([col]) => col === 'verification_status')
      .map(([, v]) => v);
    expect(verdicts).toEqual(expect.arrayContaining(['valid', 'invalid', 'catch-all', 'unknown']));
    expect(argsFor(calls, 'is')).toContainEqual(['verification_status', null]);

    expect(counts.total).toBe(7);
    expect(counts.sendable).toBe(7);
  });

  test('"sendable" requires an address even when hasEmail was off', async () => {
    const { chain, calls } = makeQueryChain({ data: null, error: null, count: 3 });
    mockSupabase.from.mockReturnValue(chain);

    await getVerificationCounts({});

    // The sendable bucket is the only one that adds the not-null email
    // predicate — that is what makes it answer "can I send today?".
    expect(argsFor(calls, 'not')).toContainEqual(['primary_email', 'is', null]);
    expect(
      argsFor(calls, 'eq').filter(([col, v]) => col === 'verification_status' && v === 'valid').length,
    ).toBe(2); // once for the 'valid' chip, once for 'sendable'
  });
});

describe('getLeads prospect-type filter', () => {
  test('narrows to the requested types', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getLeads({ prospectType: ['operator', 'unclassified'] });

    expect(argsFor(calls, 'in')).toContainEqual(['prospect_type', ['operator', 'unclassified']]);
  });
});

describe('getVerificationCounts excludeContacted', () => {
  test('applies the anti-join, not just the embed', async () => {
    const { chain, calls } = makeQueryChain({ data: null, error: null, count: 0 });
    mockSupabase.from.mockReturnValue(chain);

    await getVerificationCounts({ excludeContacted: true });

    // Requesting the embed without filtering on it would over-report the
    // sendable audience by counting already-emailed leads.
    const selects = argsFor(calls, 'select').map(([sel]) => String(sel));
    expect(selects.every((sel) => sel.includes('campaign_leads!left(id)'))).toBe(true);
    expect(argsFor(calls, 'in')).toContainEqual([
      'campaign_leads.status',
      ['sent', 'opened', 'replied', 'auto_replied', 'bounced'],
    ]);
    expect(argsFor(calls, 'is')).toContainEqual(['campaign_leads', null]);
  });
});
