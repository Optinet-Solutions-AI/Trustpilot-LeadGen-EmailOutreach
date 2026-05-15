import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => {
  return { from: vi.fn() };
});

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => mockSupabase,
}));

import { listActiveCitiesForCountry, countActiveCitiesForCountry } from './tripadvisor-cities.js';

/**
 * Build a chainable mock for one query that resolves to `result` when awaited
 * (mirrors the pattern used in scrape-jobs.test.ts).
 */
function makeQueryChain(result: { data: unknown; error: unknown; count?: number | null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const linkers = ['select', 'eq', 'order', 'limit'];

  for (const m of linkers) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled);

  return { chain, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listActiveCitiesForCountry', () => {
  test('filters by country_code + active=true and orders by rank ascending', async () => {
    const rows = [
      { geo_id: '60745', country_code: 'US', name: 'Boston',   slug: 'Boston_Massachusetts', rank: 0 },
      { geo_id: '60763', country_code: 'US', name: 'New York', slug: 'New_York_City',         rank: 1 },
    ];
    const { chain, calls } = makeQueryChain({ data: rows, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const out = await listActiveCitiesForCountry('US');

    expect(mockSupabase.from).toHaveBeenCalledWith('tripadvisor_cities');
    const eqCalls = calls.filter((c) => c.method === 'eq');
    expect(eqCalls).toContainEqual({ method: 'eq', args: ['country_code', 'US'] });
    expect(eqCalls).toContainEqual({ method: 'eq', args: ['active', true] });
    expect(calls).toContainEqual({ method: 'order', args: ['rank', { ascending: true }] });
    expect(out).toEqual(rows);
  });

  test('returns [] when supabase returns null data', async () => {
    const { chain } = makeQueryChain({ data: null, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const out = await listActiveCitiesForCountry('XX');
    expect(out).toEqual([]);
  });

  test('throws when supabase returns an error', async () => {
    const { chain } = makeQueryChain({ data: null, error: { message: 'boom' } });
    mockSupabase.from.mockReturnValue(chain);

    await expect(listActiveCitiesForCountry('US')).rejects.toThrow(/boom/);
  });
});

describe('countActiveCitiesForCountry', () => {
  test('returns the supabase count', async () => {
    const { chain } = makeQueryChain({ data: null, error: null, count: 487 });
    mockSupabase.from.mockReturnValue(chain);

    const n = await countActiveCitiesForCountry('US');
    expect(n).toBe(487);
  });

  test('returns 0 when count is null', async () => {
    const { chain } = makeQueryChain({ data: null, error: null, count: null });
    mockSupabase.from.mockReturnValue(chain);

    const n = await countActiveCitiesForCountry('XX');
    expect(n).toBe(0);
  });

  test('throws when supabase returns an error', async () => {
    const { chain } = makeQueryChain({ data: null, error: { message: 'boom' }, count: null });
    mockSupabase.from.mockReturnValue(chain);

    await expect(countActiveCitiesForCountry('US')).rejects.toThrow(/boom/);
  });
});
