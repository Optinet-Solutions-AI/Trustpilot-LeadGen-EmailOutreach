import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => mockSupabase }));

// Mock the pool resolver so we can assert resolveLeadAccount DELEGATES the
// country fallback to it (the Phase-2 wiring under test).
const mockResolvePool = vi.hoisted(() => vi.fn());
vi.mock('./pool-account-resolver.js', () => ({ resolvePoolAccountForCountry: mockResolvePool }));

import { resolveLeadAccount, listActiveAccountsForLead, validateAccountForLead } from './lead-account-resolver.js';

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

describe('listActiveAccountsForLead', () => {
  test("returns { country: null, accounts: [] } when the lead has no country", async () => {
    mockSupabase.from.mockReturnValueOnce(chain({ data: { country: null }, error: null }));

    const res = await listActiveAccountsForLead('lead-1');

    expect(res).toEqual({ country: null, accounts: [] });
    // Only the leads lookup should fire — no social_accounts query when there's no country.
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });

  test("returns active facebook accounts pinned to the lead's country, least-used first", async () => {
    const accounts = [
      { id: 'a1', display_name: 'Acct 1', handle: 'acct1', country: 'GB', status: 'active', used_today: 1, daily_cap: 50, hourly_cap: 10 },
      { id: 'a2', display_name: 'Acct 2', handle: 'acct2', country: 'GB', status: 'active', used_today: 5, daily_cap: 50, hourly_cap: 10 },
    ];
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }))
      .mockReturnValueOnce(chain({ data: accounts, error: null }));

    const res = await listActiveAccountsForLead('lead-2');

    expect(res).toEqual({ country: 'GB', accounts });
  });

  test('throws when the social_accounts lookup errors', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }))
      .mockReturnValueOnce(chain({ data: null, error: { message: 'boom' } }));

    await expect(listActiveAccountsForLead('lead-3')).rejects.toThrow(/boom/);
  });
});

describe('validateAccountForLead', () => {
  test('rejects an inactive account', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }))
      .mockReturnValueOnce(chain({ data: { id: 'acct-1', country: 'GB', status: 'disabled', platform: 'facebook' }, error: null }));

    const res = await validateAccountForLead('acct-1', 'lead-1');

    expect(res).toEqual({ ok: false, reason: expect.stringContaining('GB') });
  });

  test('rejects a different-country account', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }))
      .mockReturnValueOnce(chain({ data: { id: 'acct-1', country: 'US', status: 'active', platform: 'facebook' }, error: null }));

    const res = await validateAccountForLead('acct-1', 'lead-1');

    expect(res.ok).toBe(false);
  });

  test('rejects a non-facebook account', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }))
      .mockReturnValueOnce(chain({ data: { id: 'acct-1', country: 'GB', status: 'active', platform: 'instagram' }, error: null }));

    const res = await validateAccountForLead('acct-1', 'lead-1');

    expect(res.ok).toBe(false);
  });

  test('accepts an active same-country facebook account', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }))
      .mockReturnValueOnce(chain({ data: { id: 'acct-1', country: 'GB', status: 'active', platform: 'facebook' }, error: null }));

    const res = await validateAccountForLead('acct-1', 'lead-1');

    expect(res).toEqual({ ok: true, account_id: 'acct-1', country: 'GB' });
  });

  test('rejects when the account does not exist', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: 'GB' }, error: null }))
      .mockReturnValueOnce(chain({ data: null, error: null }));

    const res = await validateAccountForLead('missing-acct', 'lead-1');

    expect(res.ok).toBe(false);
  });

  test('rejects when the lead itself has no country', async () => {
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { country: null }, error: null }))
      .mockReturnValueOnce(chain({ data: { id: 'acct-1', country: 'GB', status: 'active', platform: 'facebook' }, error: null }));

    const res = await validateAccountForLead('acct-1', 'lead-1');

    expect(res.ok).toBe(false);
  });
});
