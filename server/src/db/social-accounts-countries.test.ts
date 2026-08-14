import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => {
  return { from: vi.fn() };
});

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => mockSupabase,
}));

import { listActiveCountries } from './social-accounts-countries.js';

/**
 * Build a chainable mock for one query that resolves to `result` when awaited
 * (mirrors the pattern used in tripadvisor-cities.test.ts / scrape-jobs.test.ts).
 */
function makeQueryChain(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const linkers = ['select', 'eq', 'not'];

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

describe('listActiveCountries', () => {
  test('returns de-duplicated country codes', async () => {
    const { chain } = makeQueryChain({
      data: [{ country: 'GB' }, { country: 'GB' }, { country: 'US' }],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const out = await listActiveCountries();

    expect(out.sort()).toEqual(['GB', 'US']);
  });

  test('filters by platform=facebook, status=active, and country not null', async () => {
    const { chain, calls } = makeQueryChain({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    await listActiveCountries();

    expect(mockSupabase.from).toHaveBeenCalledWith('social_accounts');
    const eqCalls = calls.filter((c) => c.method === 'eq');
    const eqMap = Object.fromEntries(eqCalls.map((c) => [c.args[0] as string, c.args[1]]));
    expect(eqMap).toMatchObject({ platform: 'facebook', status: 'active' });
    const notCall = calls.find((c) => c.method === 'not')!;
    expect(notCall.args).toEqual(['country', 'is', null]);
  });

  test('throws when the query errors', async () => {
    const { chain } = makeQueryChain({ data: null, error: { message: 'db down' } });
    mockSupabase.from.mockReturnValue(chain);

    await expect(listActiveCountries()).rejects.toThrow('db down');
  });
});
