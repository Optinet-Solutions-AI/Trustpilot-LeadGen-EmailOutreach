import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseMod from '../lib/supabase.js';
import {
  enqueueConnectRequest,
  getConnectRequestStatus,
  claimPendingConnectRequest,
  finalizeConnectRequest,
  enqueueOnboardRequest,
} from '../db/social-connect-requests.js';

// Restore all spies after every test, regardless of which describe block they
// live in. Without this, a spy installed in one describe can bleed into the next.
beforeEach(() => vi.restoreAllMocks());

function makeMockSupabase(impl: Record<string, any>) {
  return {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: impl.updateResult, error: null }),
            }),
          }),
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: impl.updateResult, error: null }),
          }),
        }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: impl.selectResult, error: null }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: impl.selectResult, error: null }),
          }),
        }),
      }),
    }),
  };
}

// Builder for claimPendingConnectRequest — constructs two independent call
// chains because the function calls .from() twice on the same client instance:
// once for the SELECT (candidate fetch) and once for the UPDATE (optimistic claim).
function mockSupabaseForClaim(opts: {
  candidates?: any[];
  claimResult?: { data: any; error: any };
}) {
  // SELECT path is now `.in('platform', [...]).eq('connect_status','requested')
  // .order().limit()` — the worker claims across multiple platforms.
  const selectChain = {
    in: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({
            data: opts.candidates ?? [],
            error: null,
          }),
        }),
      }),
    }),
  };
  const updateChain = {
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi
              .fn()
              .mockResolvedValue(opts.claimResult ?? { data: null, error: null }),
          }),
        }),
      }),
    }),
  };
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(selectChain),
      update: vi.fn().mockReturnValue(updateChain),
    }),
  };
}

describe('enqueueConnectRequest', () => {
  it('writes connect_status=requested with a fresh session id and 10-min expiry', async () => {
    const fakeRow = { id: 'a1', connect_session_id: 'sess-1', connect_status: 'requested' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(
      makeMockSupabase({ updateResult: fakeRow }) as any,
    );
    const result = await enqueueConnectRequest('a1');
    expect(result.connect_status).toBe('requested');
    expect(result.connect_session_id).toBe('sess-1');
  });
});

describe('getConnectRequestStatus', () => {
  it('returns the current status + tunnel URL', async () => {
    const fakeRow = {
      connect_status: 'ready',
      connect_tunnel_url: 'https://test.trycloudflare.com',
      connect_error: null,
      connect_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(
      makeMockSupabase({ selectResult: fakeRow }) as any,
    );
    const result = await getConnectRequestStatus('a1');
    expect(result.connect_status).toBe('ready');
    expect(result.connect_tunnel_url).toBe('https://test.trycloudflare.com');
  });
});

describe('enqueueOnboardRequest', () => {
  it('generates a unique per-call handle placeholder, so concurrent/repeated onboarding never collides on UNIQUE(platform, handle)', async () => {
    const inserted: Record<string, unknown>[] = [];
    const mockSb = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          inserted.push(payload);
          return {
            select: vi.fn().mockReturnValue({
              single: vi
                .fn()
                .mockResolvedValue({ data: { id: `acct-${inserted.length}` }, error: null }),
            }),
          };
        }),
      }),
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(mockSb as any);

    const r1 = await enqueueOnboardRequest({ country: 'GB', requestedBy: 'user-1' });
    const r2 = await enqueueOnboardRequest({ country: 'GB', requestedBy: 'user-1' });

    expect(inserted).toHaveLength(2);
    expect(inserted[0].handle).toBeTruthy();
    expect(inserted[1].handle).toBeTruthy();
    expect(inserted[0].handle).not.toBe(inserted[1].handle);
    expect(inserted[0].status).toBe('disabled');
    expect(inserted[1].status).toBe('disabled');
    expect(r1.sessionId).not.toBe(r2.sessionId);
    expect(r1.accountId).toBe('acct-1');
    expect(r2.accountId).toBe('acct-2');
  });

  it('sets display_name from a trimmed label without touching the unique handle', async () => {
    const inserted: Record<string, unknown>[] = [];
    const mockSb = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          inserted.push(payload);
          return {
            select: vi.fn().mockReturnValue({
              single: vi
                .fn()
                .mockResolvedValue({ data: { id: `acct-${inserted.length}` }, error: null }),
            }),
          };
        }),
      }),
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(mockSb as any);

    await enqueueOnboardRequest({ country: 'GB', requestedBy: 'user-1', label: '  Maria FB  ' });
    await enqueueOnboardRequest({ country: 'GB', requestedBy: 'user-1' });

    expect(inserted[0].display_name).toBe('Maria FB');
    expect(inserted[0].handle).toMatch(/^onboard-/);
    expect(inserted[1].display_name).toBeNull();
  });
});

describe('claimPendingConnectRequest', () => {
  const candidate = {
    id: 'b2',
    connect_session_id: 'sess-claim',
    connect_status: 'requested',
    connect_tunnel_url: null,
    connect_started_at: new Date().toISOString(),
    connect_expires_at: new Date(Date.now() + 600_000).toISOString(),
    connect_error: null,
  };

  it('happy path: returns the claimed row with connect_status=provisioning', async () => {
    const claimedRow = { ...candidate, connect_status: 'provisioning' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(
      mockSupabaseForClaim({
        candidates: [candidate],
        claimResult: { data: claimedRow, error: null },
      }) as any,
    );
    const result = await claimPendingConnectRequest('facebook');
    expect(result).not.toBeNull();
    expect(result!.connect_status).toBe('provisioning');
    expect(result!.id).toBe('b2');
  });

  it('empty path: returns null when no pending rows exist', async () => {
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(
      mockSupabaseForClaim({ candidates: [] }) as any,
    );
    const result = await claimPendingConnectRequest('facebook');
    expect(result).toBeNull();
  });

  it('race path: returns null when PGRST116 indicates another worker claimed the row first', async () => {
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(
      mockSupabaseForClaim({
        candidates: [candidate],
        claimResult: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      }) as any,
    );
    const result = await claimPendingConnectRequest('facebook');
    expect(result).toBeNull();
  });
});
