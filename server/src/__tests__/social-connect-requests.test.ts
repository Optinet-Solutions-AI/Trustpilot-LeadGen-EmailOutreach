import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseMod from '../lib/supabase.js';
import {
  enqueueConnectRequest,
  getConnectRequestStatus,
  claimPendingConnectRequest,
  finalizeConnectRequest,
} from '../db/social-connect-requests.js';

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

describe('enqueueConnectRequest', () => {
  beforeEach(() => vi.restoreAllMocks());

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
