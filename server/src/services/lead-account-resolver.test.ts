import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => mockSupabase }));

// Mock the pool resolver so we can assert resolveLeadAccount DELEGATES the
// country fallback to it (the Phase-2 wiring under test).
const mockResolvePool = vi.hoisted(() => vi.fn());
vi.mock('./pool-account-resolver.js', () => ({ resolvePoolAccountForCountry: mockResolvePool }));

import { resolveLeadAccount } from './lead-account-resolver.js';

/** Chainable supabase mock; awaiting resolves to `result`, as does maybeSingle(). */
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not']) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve(result);
  c.then = (f: (v: unknown) => unknown) => Promise.resolve(result).then(f);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveLeadAccount', () => {
  test("returns the lead's own bound account when it is active (no pool fallback)", async () => {
    mockSupabase.from
      // 1) presence lookup → has a bound social_account_id
      .mockReturnValueOnce(chain({ data: [{ social_account_id: 'own' }], error: null }))
      // 2) that account is active
      .mockReturnValueOnce(chain({ data: { id: 'own', country: 'GB', status: 'active' }, error: null }));

    const res = await resolveLeadAccount('lead-1');

    expect(res).toEqual({ account_id: 'own', country: 'GB' });
    expect(mockResolvePool).not.toHaveBeenCalled();
  });

  test('delegates the country fallback to resolvePoolAccountForCountry when no bound account', async () => {
    mockSupabase.from
      // 1) presence lookup → no bound account
      .mockReturnValueOnce(chain({ data: [], error: null }))
      // 2) leads.country lookup → GB
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }));
    mockResolvePool.mockResolvedValue({ account_id: 'pooled', country: 'GB' });

    const res = await resolveLeadAccount('lead-2');

    expect(mockResolvePool).toHaveBeenCalledWith('GB');
    expect(res).toEqual({ account_id: 'pooled', country: 'GB' });
  });

  test('returns null when the lead has no bound account and no country', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: { country: null }, error: null }));

    const res = await resolveLeadAccount('lead-3');

    expect(res).toBeNull();
    expect(mockResolvePool).not.toHaveBeenCalled();
  });
});
