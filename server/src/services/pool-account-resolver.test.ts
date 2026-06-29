import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the supabase singleton BEFORE importing the module under test
const mockSupabase = vi.hoisted(() => {
  return {
    from: vi.fn(),
    rpc: vi.fn(),
  };
});

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => mockSupabase,
}));

import { resolvePoolAccountForCountry } from './pool-account-resolver.js';

/**
 * Build a chainable supabase mock whose terminal await resolves to `result`.
 * Records the filter calls so tests can assert the query shape.
 */
function makeQueryChain(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const linkers = ['select', 'eq', 'in', 'order', 'limit', 'not'];
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

describe('resolvePoolAccountForCountry', () => {
  test('returns null when no active facebook account exists for the country', async () => {
    const { chain } = makeQueryChain({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await resolvePoolAccountForCountry('PH');

    expect(result).toBeNull();
  });

  test('filters by platform=facebook, status=active, and the given country', async () => {
    const { chain, calls } = makeQueryChain({
      data: [{ id: 'a1', country: 'PH', comment_used_today: 0, connect_status: null }],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    await resolvePoolAccountForCountry('PH');

    const eqArgs = calls.filter((c) => c.method === 'eq').map((c) => c.args);
    expect(eqArgs).toContainEqual(['platform', 'facebook']);
    expect(eqArgs).toContainEqual(['status', 'active']);
    expect(eqArgs).toContainEqual(['country', 'PH']);
  });

  test('returns the lowest comment_used_today account for the country', async () => {
    // Rows arrive ordered by comment_used_today asc (the query orders them);
    // the resolver returns the first eligible one.
    const { chain } = makeQueryChain({
      data: [
        { id: 'low', country: 'PH', comment_used_today: 1, connect_status: null },
        { id: 'high', country: 'PH', comment_used_today: 9, connect_status: null },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await resolvePoolAccountForCountry('PH');

    expect(result).toEqual({ account_id: 'low', country: 'PH' });
  });

  test('skips an account busy in a browse session and returns the next free one', async () => {
    const { chain } = makeQueryChain({
      data: [
        { id: 'busy', country: 'PH', comment_used_today: 0, connect_status: 'active' },
        { id: 'free', country: 'PH', comment_used_today: 5, connect_status: 'ended' },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await resolvePoolAccountForCountry('PH', { excludeBusy: true });

    expect(result).toEqual({ account_id: 'free', country: 'PH' });
  });

  test('returns null when every country account is busy and excludeBusy is set', async () => {
    const { chain } = makeQueryChain({
      data: [
        { id: 'busy1', country: 'PH', comment_used_today: 0, connect_status: 'provisioning' },
        { id: 'busy2', country: 'PH', comment_used_today: 1, connect_status: 'active' },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await resolvePoolAccountForCountry('PH', { excludeBusy: true });

    expect(result).toBeNull();
  });

  test('with excludeBusy=false, returns the busy lowest-usage account', async () => {
    const { chain } = makeQueryChain({
      data: [
        { id: 'busy', country: 'PH', comment_used_today: 0, connect_status: 'active' },
        { id: 'free', country: 'PH', comment_used_today: 5, connect_status: null },
      ],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await resolvePoolAccountForCountry('PH', { excludeBusy: false });

    expect(result).toEqual({ account_id: 'busy', country: 'PH' });
  });

  test('throws when the supabase query errors', async () => {
    const { chain } = makeQueryChain({ data: null, error: { message: 'boom' } });
    mockSupabase.from.mockReturnValue(chain);

    await expect(resolvePoolAccountForCountry('PH')).rejects.toThrow(/boom/);
  });
});
