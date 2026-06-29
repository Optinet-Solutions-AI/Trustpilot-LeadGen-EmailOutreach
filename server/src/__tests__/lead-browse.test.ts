/**
 * Tests for resolveLeadAccount (shared module).
 *
 * Mirrors the fake-supabase-client harness style from social-browse-sessions.test.ts.
 * Tests the three paths the brief requires:
 *   1. Resolver returns the lead's own active capturing account when present.
 *   2. Resolver falls back to a country-pinned active account.
 *   3. Resolver returns null when neither exists (→ caller responds 409).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseMod from '../lib/supabase.js';
import { resolveLeadAccount } from '../services/lead-account-resolver.js';

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

// In-memory tables: each key is `${table}/${id}`.
const tables: Record<string, Record<string, any>> = {
  lead_platform_presences: {},
  social_accounts: {},
  leads: {},
};

beforeEach(() => {
  for (const t of Object.keys(tables)) {
    for (const k of Object.keys(tables[t])) delete tables[t][k];
  }
  vi.restoreAllMocks();
});

/**
 * Minimal fake client that supports the exact call shapes used by
 * resolveLeadAccount:
 *   .from(table).select(cols).eq(col, val)[.eq(...).eq(...)].limit(n)    → array
 *   .from(table).select(cols).eq(col, val).eq(col2, val2).maybeSingle()  → row|null
 *   .from(table).select(cols).eq(col, val).not(...).limit(n)             → array
 */
function makeFakeClient() {
  return {
    from: vi.fn((table: string) => {
      const rows = () => Object.values(tables[table] ?? {});

      return {
        select: vi.fn((_cols?: string) => {
          // We collect eq/not filters lazily, then resolve at limit()/maybeSingle()/single().
          const filters: Array<(r: any) => boolean> = [];
          let notFilter: ((r: any) => boolean) | null = null;

          const chain: any = {
            eq: vi.fn((col: string, val: string) => {
              filters.push((r) => r[col] === val);
              return chain;
            }),
            not: vi.fn((col: string, op: string, _val: any) => {
              if (op === 'is') {
                // .not('col', 'is', null) → col is NOT null
                notFilter = (r) => r[col] !== null && r[col] !== undefined;
              }
              return chain;
            }),
            limit: vi.fn((_n: number) => {
              let matched = rows();
              for (const f of filters) matched = matched.filter(f);
              if (notFilter) matched = matched.filter(notFilter);
              return Promise.resolve({ data: matched, error: null });
            }),
            maybeSingle: vi.fn(async () => {
              let matched = rows();
              for (const f of filters) matched = matched.filter(f);
              const row = matched[0] ?? null;
              return { data: row, error: null };
            }),
            single: vi.fn(async () => {
              let matched = rows();
              for (const f of filters) matched = matched.filter(f);
              const row = matched[0] ?? null;
              return {
                data: row,
                error: row ? null : { message: 'not found', code: 'PGRST116' },
              };
            }),
            // resolvePoolAccountForCountry orders then awaits the chain directly
            // (no .limit()/.maybeSingle()), so order() returns the chain and the
            // chain is thenable, resolving to the filtered rows.
            order: vi.fn((_col: string, _opts?: unknown) => chain),
            then: (resolve: (v: { data: any[]; error: null }) => unknown) => {
              let matched = rows();
              for (const f of filters) matched = matched.filter(f);
              if (notFilter) matched = matched.filter(notFilter);
              return Promise.resolve(resolve({ data: matched, error: null }));
            },
          };
          return chain;
        }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedPresence(id: string, leadId: string, socialAccountId: string | null) {
  tables.lead_platform_presences[id] = {
    id,
    lead_id: leadId,
    platform: 'facebook',
    social_account_id: socialAccountId,
  };
}

function seedAccount(id: string, opts: { status: string; country: string | null; platform?: string }) {
  tables.social_accounts[id] = {
    id,
    status: opts.status,
    country: opts.country,
    platform: opts.platform ?? 'facebook',
  };
}

function seedLead(id: string, country: string | null) {
  tables.leads[id] = { id, country };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLeadAccount', () => {
  it('returns the lead\'s own active capturing account when present', async () => {
    seedLead('lead1', 'PH');
    seedAccount('acct-own', { status: 'active', country: 'PH' });
    seedPresence('pres1', 'lead1', 'acct-own');

    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const result = await resolveLeadAccount('lead1');
    expect(result).not.toBeNull();
    expect(result!.account_id).toBe('acct-own');
  });

  it('falls back to a country-pinned active account when the presence account is not active', async () => {
    seedLead('lead2', 'PH');
    // Presence points to a disabled account
    seedAccount('acct-disabled', { status: 'disabled', country: 'PH' });
    seedPresence('pres2', 'lead2', 'acct-disabled');
    // Country-pinned fallback account is active
    seedAccount('acct-country', { status: 'active', country: 'PH', platform: 'facebook' });

    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const result = await resolveLeadAccount('lead2');
    expect(result).not.toBeNull();
    expect(result!.account_id).toBe('acct-country');
  });

  it('falls back to a country-pinned active account when no presence row exists', async () => {
    seedLead('lead3', 'US');
    // No presence rows for lead3
    seedAccount('acct-us', { status: 'active', country: 'US', platform: 'facebook' });

    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const result = await resolveLeadAccount('lead3');
    expect(result).not.toBeNull();
    expect(result!.account_id).toBe('acct-us');
  });

  it('returns null when neither presence account nor country account exists', async () => {
    seedLead('lead4', 'DE');
    // No accounts at all

    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const result = await resolveLeadAccount('lead4');
    expect(result).toBeNull();
  });

  it('returns null when lead has no country and no presence account', async () => {
    seedLead('lead5', null);
    // No presence, no country → cannot resolve

    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const result = await resolveLeadAccount('lead5');
    expect(result).toBeNull();
  });
});
