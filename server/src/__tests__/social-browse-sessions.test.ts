import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as supabaseMod from '../lib/supabase.js';
import {
  enqueueBrowseSession,
  endBrowseSession,
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
 * Supports the two call shapes used by enqueueBrowseSession / endBrowseSession:
 *   SELECT shape:  .from().select().eq().single()
 *   UPDATE shape:  .from().update().eq().select().single()
 *   UPDATE (void): .from().update().eq()
 */
function makeFakeClient() {
  // Helper: resolve the row for a given account id value.
  function getRow(val: string) {
    return rows[val] ?? null;
  }

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
      // UPDATE branch — `.eq()` self-chains so multiple filters work
      // (real Supabase allows .update().eq().eq()...). The first .eq() whose
      // value matches a known row captures the target + applies the patch;
      // additional .eq() calls are filters that return the same chainable.
      update: vi.fn((patch: Record<string, any>) => {
        let targetVal: string | null = null;
        const settle = () =>
          Promise.resolve({ data: targetVal ? rows[targetVal] ?? null : null, error: null });
        const u: any = {
          eq: vi.fn((_col: string, val: string) => {
            if (rows[val]) {
              targetVal = val;
              Object.assign(rows[val], patch);
            }
            return u; // chainable for additional .eq filters
          }),
          select: vi.fn((_cols?: string) => ({
            single: vi.fn().mockImplementation(async () => ({
              data: targetVal ? rows[targetVal] ?? null : null,
              error: null,
            })),
          })),
          // thenable so `const { error } = await sb.from().update().eq()...` resolves
          then: (...a: any[]) => settle().then(...a),
          catch: (...a: any[]) => settle().catch(...a),
          finally: (...a: any[]) => settle().finally(...a),
        };
        return u;
      }),
    })),
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
});

describe('endBrowseSession', () => {
  it('sets connect_status=ended on the account', async () => {
    rows['acc1'] = { id: 'acc1', connect_status: 'active', connect_mode: 'browse' };
    vi.spyOn(supabaseMod, 'getSupabase').mockReturnValue(makeFakeClient() as any);

    await endBrowseSession('acc1');

    expect(rows['acc1'].connect_status).toBe('ended');
  });
});
