import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseMod from '../lib/supabase.js';
import {
  enqueueBrowseSession,
  endBrowseSession,
  enqueueConnectRequest,
  AccountInUseError,
} from '../db/social-connect-requests.js';

// In-memory store shared across tests; reset each time.
const rows: Record<string, any> = {};

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
  vi.restoreAllMocks();
});

/**
 * Builds a chainable Supabase fake backed by `rows`.
 *
 * Supports the call shapes used by enqueueBrowseSession / endBrowseSession /
 * enqueueConnectRequest:
 *   SELECT shape:  .from().select().eq().single()
 *   UPDATE shape:  .from().update().eq()[.or()].select().single()
 *   UPDATE (void): .from().update().eq()[.eq()]
 *
 * opts.blockAtomicUpdate — when true, the conditional UPDATE (the one that
 * includes an .or() call) simulates "lost the race" by returning PGRST116
 * with 0 rows matched instead of applying the patch. Used for I1 race test.
 */
function makeFakeClient(opts: { blockAtomicUpdate?: boolean } = {}) {
  // Helper: resolve the row for a given account id value.
  function getRow(val: string) {
    return rows[val] ?? null;
  }

  // Captured update payloads keyed by call index (for C1 assertion).
  const capturedUpdates: Array<{ patch: Record<string, any>; isAtomic: boolean }> = [];
  (makeFakeClient as any)._capturedUpdates = capturedUpdates;

  const client = {
    from: vi.fn((_table: string) => ({
      // SELECT branch
      select: vi.fn((_cols?: string) => ({
        eq: vi.fn((_col: string, val: string) => ({
          single: vi.fn().mockImplementation(async () => {
            const row = getRow(val);
            return { data: row, error: row ? null : { message: 'not found', code: 'PGRST116' } };
          }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        })),
      })),
      // UPDATE branch — `.eq()` self-chains so multiple filters work.
      // `.or()` marks this as the atomic conditional update; when
      // blockAtomicUpdate is set, the subsequent .single() returns PGRST116.
      update: vi.fn((patch: Record<string, any>) => {
        let targetVal: string | null = null;
        let isAtomic = false;
        capturedUpdates.push({ patch, isAtomic: false }); // placeholder, updated on .or()
        const entry = capturedUpdates[capturedUpdates.length - 1];
        const settle = () =>
          Promise.resolve({ data: targetVal ? rows[targetVal] ?? null : null, error: null });
        const u: any = {
          eq: vi.fn((_col: string, val: string) => {
            if (rows[val]) {
              targetVal = val;
              if (!isAtomic || !opts.blockAtomicUpdate) {
                Object.assign(rows[val], patch);
              }
            }
            return u;
          }),
          or: vi.fn((_expr: string) => {
            isAtomic = true;
            entry.isAtomic = true;
            return u;
          }),
          select: vi.fn((_cols?: string) => ({
            single: vi.fn().mockImplementation(async () => {
              if (isAtomic && opts.blockAtomicUpdate) {
                return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
              }
              return {
                data: targetVal ? rows[targetVal] ?? null : null,
                error: null,
              };
            }),
          })),
          // thenable so `const { error } = await sb.from().update().eq()...` resolves
          then: (...a: any[]) => settle().then(...a),
          catch: (...a: any[]) => settle().catch(...a),
          finally: (...a: any[]) => settle().finally(...a),
        };
        return u;
      }),
    })),
    _capturedUpdates: capturedUpdates,
  };
  return client;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('enqueueBrowseSession', () => {
  it('sets mode=browse, status=requested, target, requestedBy when account is free', async () => {
    rows['acc1'] = { id: 'acc1', connect_status: null, connect_mode: 'connect' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const r = await enqueueBrowseSession('acc1', {
      targetUrl: 'https://fb.com/p/1',
      requestedBy: 'jane',
    });

    expect(rows['acc1'].connect_mode).toBe('browse');
    expect(rows['acc1'].connect_status).toBe('requested');
    expect(rows['acc1'].connect_target_url).toBe('https://fb.com/p/1');
    expect(rows['acc1'].connect_requested_by).toBe('jane');
    // Returned row mirrors what was written
    expect(r.connect_status).toBe('requested');
  });

  it('throws AccountInUseError (heldBy set) when status is active', async () => {
    rows['acc1'] = {
      id: 'acc1',
      connect_status: 'active',
      connect_mode: 'browse',
      connect_requested_by: 'bob',
      connect_expires_at: '2099-01-01T00:00:00.000Z',
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    await expect(
      enqueueBrowseSession('acc1', { targetUrl: null, requestedBy: 'jane' }),
    ).rejects.toBeInstanceOf(AccountInUseError);

    try {
      await enqueueBrowseSession('acc1', { targetUrl: null, requestedBy: 'jane' });
    } catch (err) {
      expect(err).toBeInstanceOf(AccountInUseError);
      expect((err as AccountInUseError).heldBy).toBe('bob');
      expect((err as AccountInUseError).expiresAt).toBe('2099-01-01T00:00:00.000Z');
    }
  });

  it('allows enqueue when prior status is a terminal state (ended)', async () => {
    rows['acc2'] = { id: 'acc2', connect_status: 'ended', connect_mode: 'browse' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const r = await enqueueBrowseSession('acc2', {
      targetUrl: 'https://fb.com/p/2',
      requestedBy: 'alice',
    });
    expect(r.connect_status).toBe('requested');
    expect(rows['acc2'].connect_mode).toBe('browse');
  });

  it('allows enqueue when prior status is captured (terminal)', async () => {
    rows['acc3'] = { id: 'acc3', connect_status: 'captured', connect_mode: 'connect' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const r = await enqueueBrowseSession('acc3', {
      targetUrl: null,
      requestedBy: 'carol',
    });
    expect(r.connect_status).toBe('requested');
  });

  // Reconnect: closing the viewer tab doesn't end the browse session (that
  // requires an explicit /browse/end call), so the account stays "active" for
  // the full TTL. The SAME operator clicking Message again must get their
  // live stream handed back, not an "in use" error.
  it('reconnects (returns the existing row, no throw) when the same requestedBy already holds a live session with a tunnel', async () => {
    rows['acc4'] = {
      id: 'acc4',
      connect_status: 'active',
      connect_mode: 'browse',
      connect_requested_by: 'jane',
      connect_expires_at: '2099-01-01T00:00:00.000Z',
      connect_tunnel_url: 'https://stream.example.com/acc4',
      connect_session_id: 'sess-acc4',
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const r = await enqueueBrowseSession('acc4', {
      targetUrl: 'https://fb.com/p/4',
      requestedBy: 'jane',
    });

    expect(r.connect_status).toBe('active');
    expect(r.connect_tunnel_url).toBe('https://stream.example.com/acc4');
    expect(r.connect_session_id).toBe('sess-acc4');
    // Reconnect is read-only — it must not touch/reset the existing session.
    expect(rows['acc4'].connect_requested_by).toBe('jane');
    expect(rows['acc4'].connect_status).toBe('active');
  });

  it('still throws AccountInUseError when a DIFFERENT operator holds a live session with a tunnel', async () => {
    rows['acc5'] = {
      id: 'acc5',
      connect_status: 'active',
      connect_mode: 'browse',
      connect_requested_by: 'bob',
      connect_expires_at: '2099-01-01T00:00:00.000Z',
      connect_tunnel_url: 'https://stream.example.com/acc5',
      connect_session_id: 'sess-acc5',
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    await expect(
      enqueueBrowseSession('acc5', { targetUrl: null, requestedBy: 'jane' }),
    ).rejects.toBeInstanceOf(AccountInUseError);
  });

  it('still throws AccountInUseError for the same requestedBy when there is no tunnel yet (genuinely in-flight)', async () => {
    rows['acc6'] = {
      id: 'acc6',
      connect_status: 'provisioning',
      connect_mode: 'browse',
      connect_requested_by: 'jane',
      connect_expires_at: '2099-01-01T00:00:00.000Z',
      connect_tunnel_url: null,
      connect_session_id: 'sess-acc6',
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    await expect(
      enqueueBrowseSession('acc6', { targetUrl: null, requestedBy: 'jane' }),
    ).rejects.toBeInstanceOf(AccountInUseError);
  });
});

describe('endBrowseSession', () => {
  it('sets connect_status=ended on the account', async () => {
    rows['acc1'] = { id: 'acc1', connect_status: 'active', connect_mode: 'browse' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    await endBrowseSession('acc1');

    expect(rows['acc1'].connect_status).toBe('ended');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// C1: enqueueConnectRequest must always write connect_mode='connect'
// ──────────────────────────────────────────────────────────────────────────────
describe('enqueueConnectRequest — C1 connect_mode reset', () => {
  it('includes connect_mode="connect" in the update payload after a prior browse session', async () => {
    // Simulate an account that was left in browse mode after a prior browse session.
    rows['acc10'] = {
      id: 'acc10',
      connect_status: 'ended',
      connect_mode: 'browse',
      connect_requested_by: null,
      connect_expires_at: null,
    };
    const fake = makeFakeClient();
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(fake as any);

    await enqueueConnectRequest('acc10');

    // The update payload must have reset connect_mode to 'connect'.
    expect(rows['acc10'].connect_mode).toBe('connect');
    // Confirm the update captured by the fake also carries connect_mode.
    const updatePayload = fake._capturedUpdates.find((u) => !u.isAtomic);
    expect(updatePayload?.patch.connect_mode).toBe('connect');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// I1: enqueueBrowseSession atomic lock — lost-race path
// ──────────────────────────────────────────────────────────────────────────────
describe('enqueueBrowseSession — I1 atomic lock', () => {
  it('throws AccountInUseError when the conditional UPDATE matches 0 rows (lost the race)', async () => {
    // Account looks free in the pre-read but the DB update rejects (race condition).
    rows['acc20'] = {
      id: 'acc20',
      connect_status: null,
      connect_mode: null,
      connect_requested_by: null,
      connect_expires_at: null,
    };
    const fake = makeFakeClient({ blockAtomicUpdate: true });
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(fake as any);

    await expect(
      enqueueBrowseSession('acc20', { targetUrl: null, requestedBy: 'racer' }),
    ).rejects.toBeInstanceOf(AccountInUseError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// I2: enqueueConnectRequest must refuse to stomp an active browse session
// ──────────────────────────────────────────────────────────────────────────────
describe('enqueueConnectRequest — I2 browse occupancy guard', () => {
  it('throws AccountInUseError when account is in an active browse session', async () => {
    rows['acc30'] = {
      id: 'acc30',
      connect_status: 'active',
      connect_mode: 'browse',
      connect_requested_by: 'operator1',
      connect_expires_at: '2099-01-01T00:00:00.000Z',
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    await expect(enqueueConnectRequest('acc30')).rejects.toBeInstanceOf(AccountInUseError);

    try {
      await enqueueConnectRequest('acc30');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountInUseError);
      expect((err as AccountInUseError).heldBy).toBe('operator1');
      expect((err as AccountInUseError).expiresAt).toBe('2099-01-01T00:00:00.000Z');
    }
  });

  it('succeeds (and writes connect_mode="connect") when account is free (connect_status=null)', async () => {
    rows['acc31'] = {
      id: 'acc31',
      connect_status: null,
      connect_mode: null,
      connect_requested_by: null,
      connect_expires_at: null,
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const result = await enqueueConnectRequest('acc31');

    expect(result.connect_status).toBe('requested');
    expect(rows['acc31'].connect_mode).toBe('connect');
  });

  it('succeeds when account is in connect mode (non-browse active state)', async () => {
    // connect_mode='connect', connect_status='active' — this is a normal
    // in-progress login, not a browse session. Should NOT block a Re-login.
    rows['acc32'] = {
      id: 'acc32',
      connect_status: 'active',
      connect_mode: 'connect',
      connect_requested_by: null,
      connect_expires_at: null,
    };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    const result = await enqueueConnectRequest('acc32');
    expect(result.connect_status).toBe('requested');
    expect(rows['acc32'].connect_mode).toBe('connect');
  });
});
