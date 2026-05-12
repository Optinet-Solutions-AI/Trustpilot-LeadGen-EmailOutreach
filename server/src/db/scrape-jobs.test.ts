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

// Import after mocking
import {
  enqueueJob,
  claimNextPendingJob,
  heartbeat,
  markJobComplete,
  markJobFailed,
  releaseStaleClaims,
} from './scrape-jobs.js';

/**
 * Helper: build a chainable mock for a single supabase query.
 * Records every method call and returns terminal { data, error } from `result`.
 */
function makeQueryChain(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const terminal = ['single', 'maybeSingle'];
  // Methods that return the chain itself (for further chaining)
  const linkers = ['insert', 'update', 'select', 'eq', 'in', 'order', 'limit', 'not'];

  for (const m of linkers) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  for (const m of terminal) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return Promise.resolve(result);
    };
  }
  // The chain itself is thenable so awaiting it without .single() resolves to result
  chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);

  return { chain, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── enqueueJob ─────────────────────────────────────────────────

describe('enqueueJob', () => {
  test('inserts a pending row with default priority=100 for nightly source', async () => {
    const row = { id: 'job-1', status: 'pending', priority: 100 };
    const { chain, calls } = makeQueryChain({ data: row, error: null });
    mockSupabase.from.mockReturnValue(chain);

    const result = await enqueueJob({
      country: 'US',
      category: 'casino',
      min_rating: 1.0,
      max_rating: 3.5,
      enrich: false,
      verify: true,
      source: 'nightly',
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('scrape_jobs');
    const insert = calls.find((c) => c.method === 'insert')!;
    expect(insert.args[0]).toMatchObject({
      country: 'US',
      category: 'casino',
      status: 'pending',
      source: 'nightly',
      priority: 100,
      max_attempts: 3,
    });
    expect(result).toEqual(row);
  });

  test('uses priority=10 for manual source so manual jobs jump the queue', async () => {
    const { chain, calls } = makeQueryChain({ data: { id: 'job-2' }, error: null });
    mockSupabase.from.mockReturnValue(chain);

    await enqueueJob({
      country: 'GB',
      category: 'gambling',
      min_rating: 1.0,
      max_rating: 3.5,
      enrich: false,
      verify: false,
      source: 'manual',
    });

    const insert = calls.find((c) => c.method === 'insert')!;
    expect((insert.args[0] as { priority: number }).priority).toBe(10);
  });

  test('throws when the insert errors', async () => {
    const { chain } = makeQueryChain({ data: null, error: { message: 'unique violation' } });
    mockSupabase.from.mockReturnValue(chain);

    await expect(
      enqueueJob({
        country: 'US',
        category: 'casino',
        min_rating: 1,
        max_rating: 3.5,
        enrich: false,
        verify: false,
      }),
    ).rejects.toThrow('unique violation');
  });
});

// ── claimNextPendingJob ────────────────────────────────────────

describe('claimNextPendingJob', () => {
  test('calls the claim RPC with worker_id and max_concurrent', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: { id: 'job-1' }, error: null });

    await claimNextPendingJob('worker-ec2-sg-1', 3);

    expect(mockSupabase.rpc).toHaveBeenCalledWith('claim_next_pending_scrape_job', {
      p_worker_id: 'worker-ec2-sg-1',
      p_max_concurrent: 3,
    });
  });

  test('returns null when queue is empty (RPC returns null)', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });

    const result = await claimNextPendingJob('worker-1');

    expect(result).toBeNull();
  });

  test('unwraps array-shaped RPC return (some supabase-js versions wrap composites)', async () => {
    const row = { id: 'job-1', country: 'US' };
    mockSupabase.rpc.mockResolvedValue({ data: [row], error: null });

    const result = await claimNextPendingJob('worker-1');

    expect(result).toEqual(row);
  });

  test('returns object directly when RPC return is not wrapped in an array', async () => {
    const row = { id: 'job-1', country: 'US' };
    mockSupabase.rpc.mockResolvedValue({ data: row, error: null });

    const result = await claimNextPendingJob('worker-1');

    expect(result).toEqual(row);
  });

  test('throws on RPC error', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: null, error: { message: 'rpc fail' } });

    await expect(claimNextPendingJob('worker-1')).rejects.toThrow('rpc fail');
  });

  // Regression for the row-of-nulls bug: when an earlier version of the RPC
  // declared RETURNS scrape_jobs (single composite) and the queue was empty,
  // supabase-js unwrapped a NULL composite into {id: null, country: null, …}.
  // The worker treated this as a real claim and crashed on the null UUID.
  test('returns null when RPC returns a row of all-null fields (defensive against composite-null shape)', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: { id: null, country: null, category: null, status: null },
      error: null,
    });

    const result = await claimNextPendingJob('worker-1');

    expect(result).toBeNull();
  });

  test('returns null when RPC returns an empty array (SETOF with no rows — current empty-queue shape)', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: [], error: null });

    const result = await claimNextPendingJob('worker-1');

    expect(result).toBeNull();
  });

  test('returns null when RPC returns an array containing a row-of-nulls', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: [{ id: null, country: null }],
      error: null,
    });

    const result = await claimNextPendingJob('worker-1');

    expect(result).toBeNull();
  });
});

// ── heartbeat ──────────────────────────────────────────────────

describe('heartbeat', () => {
  test('updates last_heartbeat_at only for the owner worker', async () => {
    const { chain, calls } = makeQueryChain({ data: null, error: null });
    mockSupabase.from.mockReturnValue(chain);

    await heartbeat('job-1', 'worker-ec2-sg-1');

    expect(mockSupabase.from).toHaveBeenCalledWith('scrape_jobs');
    const update = calls.find((c) => c.method === 'update')!;
    expect(update.args[0]).toHaveProperty('last_heartbeat_at');

    // CRITICAL: the eq() chain must include BOTH id AND worker_id so a stale
    // worker can't keep a job alive that has been re-claimed by someone else.
    const eqCalls = calls.filter((c) => c.method === 'eq');
    const eqMap = Object.fromEntries(eqCalls.map((c) => [c.args[0] as string, c.args[1]]));
    expect(eqMap).toMatchObject({ id: 'job-1', worker_id: 'worker-ec2-sg-1' });
  });
});

// ── markJobComplete ───────────────────────────────────────────

describe('markJobComplete', () => {
  test('writes status=completed with stats and completed_at', async () => {
    const { chain, calls } = makeQueryChain({ data: null, error: null });
    mockSupabase.from.mockReturnValue(chain);

    await markJobComplete('job-1', {
      total_found: 42,
      total_scraped: 40,
      total_enriched: 35,
      total_verified: 30,
    });

    const update = calls.find((c) => c.method === 'update')!;
    const patch = update.args[0] as Record<string, unknown>;
    expect(patch.status).toBe('completed');
    expect(patch.total_scraped).toBe(40);
    expect(typeof patch.completed_at).toBe('string');

    const eqArgs = calls.find((c) => c.method === 'eq')!.args;
    expect(eqArgs).toEqual(['id', 'job-1']);
  });
});

// ── markJobFailed ──────────────────────────────────────────────

describe('markJobFailed', () => {
  test('re-queues to status=pending when attempts < max_attempts (retry budget remains)', async () => {
    // First call: read attempts/max_attempts
    const readChain = makeQueryChain({ data: { attempts: 1, max_attempts: 3 }, error: null });
    // Second call: update patch
    const updateChain = makeQueryChain({ data: null, error: null });

    mockSupabase.from
      .mockReturnValueOnce(readChain.chain)
      .mockReturnValueOnce(updateChain.chain);

    await markJobFailed('job-1', 'transient network error');

    const update = updateChain.calls.find((c) => c.method === 'update')!;
    const patch = update.args[0] as Record<string, unknown>;
    expect(patch.status).toBe('pending');
    expect(patch.worker_id).toBeNull();
    expect(patch.claimed_at).toBeNull();
    expect(patch.last_error).toBe('transient network error');
  });

  test('marks status=failed permanently when attempts >= max_attempts (retry budget exhausted)', async () => {
    const readChain = makeQueryChain({ data: { attempts: 3, max_attempts: 3 }, error: null });
    const updateChain = makeQueryChain({ data: null, error: null });

    mockSupabase.from
      .mockReturnValueOnce(readChain.chain)
      .mockReturnValueOnce(updateChain.chain);

    await markJobFailed('job-1', 'permanent failure');

    const update = updateChain.calls.find((c) => c.method === 'update')!;
    const patch = update.args[0] as Record<string, unknown>;
    expect(patch.status).toBe('failed');
    expect(patch.error).toBe('permanent failure');
    expect(typeof patch.completed_at).toBe('string');
  });

  test('truncates error messages over 2000 chars to protect the column', async () => {
    const readChain = makeQueryChain({ data: { attempts: 0, max_attempts: 3 }, error: null });
    const updateChain = makeQueryChain({ data: null, error: null });
    mockSupabase.from
      .mockReturnValueOnce(readChain.chain)
      .mockReturnValueOnce(updateChain.chain);

    const longMsg = 'x'.repeat(5000);
    await markJobFailed('job-1', longMsg);

    const update = updateChain.calls.find((c) => c.method === 'update')!;
    const patch = update.args[0] as Record<string, unknown>;
    expect((patch.last_error as string).length).toBe(2000);
  });
});

// ── releaseStaleClaims ─────────────────────────────────────────

describe('releaseStaleClaims', () => {
  test('calls the RPC with the supplied max-age and returns the count', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: 4, error: null });

    const count = await releaseStaleClaims(15);

    expect(mockSupabase.rpc).toHaveBeenCalledWith('release_stale_scrape_claims', {
      p_max_age_min: 15,
    });
    expect(count).toBe(4);
  });

  test('defaults max-age to 10 minutes when omitted', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: 0, error: null });

    await releaseStaleClaims();

    expect(mockSupabase.rpc).toHaveBeenCalledWith('release_stale_scrape_claims', {
      p_max_age_min: 10,
    });
  });

  test('returns 0 when RPC returns null', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });

    expect(await releaseStaleClaims()).toBe(0);
  });
});
