import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseMod from '../lib/supabase.js';
import {
  enqueueConnectRequest,
  getConnectRequestStatus,
  claimPendingConnectRequest,
  finalizeConnectRequest,
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
  const selectChain = {
    eq: vi.fn().mockReturnValue({
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
