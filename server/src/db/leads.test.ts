import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => {
  return { from: vi.fn() };
});

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => mockSupabase,
}));

import { getLeads, getLeadIds } from './leads.js';

/**
 * Chainable query-builder mock that records every method call, mirroring the
 * pattern in scrape-jobs.test.ts / tripadvisor-cities.test.ts.
 */
function makeQueryChain(result: { data: unknown; error: unknown; count?: number | null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const linkers = ['select', 'eq', 'neq', 'ilike', 'or', 'gte', 'lte', 'not', 'is', 'order', 'limit', 'range'];

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
