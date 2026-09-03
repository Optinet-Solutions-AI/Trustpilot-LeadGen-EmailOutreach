import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockSupabase = vi.hoisted(() => ({ from: vi.fn() }));
const mockConfig = vi.hoisted(() => ({ value: { sendDedupeSince: '' } }));

vi.mock('../lib/supabase.js', () => ({ getSupabase: () => mockSupabase }));
vi.mock('../config.js', () => ({ get config() { return mockConfig.value; } }));

import { getSentEmails } from './campaigns.js';

/**
 * Chainable query-builder mock that records every call, mirroring the pattern
 * in leads.test.ts. `pages` lets one chain answer successive .range() reads
 * with different row batches, which is how the 1000-row cap is exercised.
 */
function makeChain(pages: Array<Array<{ email_used: string | null }>>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let pageIdx = 0;
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ['select', 'in', 'gte', 'eq', 'not', 'is', 'order', 'limit']) {
    chain[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return chain; };
  }
  chain.range = (...args: unknown[]) => {
    calls.push({ method: 'range', args });
    const data = pages[pageIdx] ?? [];
    pageIdx += 1;
    return Promise.resolve({ data, error: null });
  };
  return { chain, calls };
}

const rows = (...addrs: string[]) => addrs.map((email_used) => ({ email_used }));

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.value = { sendDedupeSince: '' };
});

describe('getSentEmails pagination', () => {
  /**
   * The presenting bug: the function did a single unbounded .select(), and
   * PostgREST caps a response at 1000 rows. With 2,031 real sends on file it
   * silently returned the first 1000 — so 1,031 already-emailed addresses
   * were NOT blocked, and the "never double-email" guarantee was only ever
   * true for lists under the cap. Measured live 2026-09-03.
   */
  test('pages past the 1000-row cap instead of truncating', async () => {
    const first = rows(...Array.from({ length: 1000 }, (_, i) => `a${i}@x.com`));
    const second = rows('tail@x.com');
    const { chain, calls } = makeChain([first, second, []]);
    mockSupabase.from.mockReturnValue(chain);

    const out = await getSentEmails();

    expect(out.size).toBe(1001);
    expect(out.has('tail@x.com')).toBe(true);
    // Two full reads plus the short page that ends the loop.
    expect(calls.filter((c) => c.method === 'range').length).toBeGreaterThanOrEqual(2);
  });

  test('lowercases every address so lookups are case-insensitive', async () => {
    const { chain } = makeChain([rows('MiXeD@Example.COM')]);
    mockSupabase.from.mockReturnValue(chain);

    const out = await getSentEmails();

    expect(out.has('mixed@example.com')).toBe(true);
  });
});

describe('getSentEmails recontact cutoff', () => {
  test('with no cutoff configured, every send status blocks regardless of date', async () => {
    const { chain, calls } = makeChain([rows('old@x.com')]);
    mockSupabase.from.mockReturnValue(chain);

    await getSentEmails();

    const statuses = calls.filter((c) => c.method === 'in').flatMap((c) => c.args[1] as string[]);
    expect(statuses).toEqual(
      expect.arrayContaining(['sent', 'opened', 'replied', 'auto_replied', 'bounced']),
    );
    expect(calls.some((c) => c.method === 'gte')).toBe(false);
  });

  /**
   * The operator switched sending domains, so mail sent from the old one is
   * not a reason to withhold a fresh approach. But a dead mailbox stays dead
   * and a live conversation stays live — 'bounced' and 'replied' must keep
   * blocking however old they are. Only sent/opened/auto_replied are
   * date-scoped.
   */
  test('with a cutoff, bounced and replied still block at any date', async () => {
    mockConfig.value = { sendDedupeSince: '2026-08-07' };
    const permanent = makeChain([rows('bounced@x.com')]);
    const recent = makeChain([rows('recent@x.com')]);
    mockSupabase.from.mockReturnValueOnce(permanent.chain).mockReturnValueOnce(recent.chain);

    const out = await getSentEmails();

    const permStatuses = permanent.calls.filter((c) => c.method === 'in').flatMap((c) => c.args[1] as string[]);
    expect(permStatuses).toEqual(expect.arrayContaining(['bounced', 'replied']));
    expect(permanent.calls.some((c) => c.method === 'gte')).toBe(false);
    expect(out.has('bounced@x.com')).toBe(true);
  });

  test('with a cutoff, sent/opened/auto_replied only block on or after it', async () => {
    mockConfig.value = { sendDedupeSince: '2026-08-07' };
    const permanent = makeChain([[]]);
    const recent = makeChain([rows('recent@x.com')]);
    mockSupabase.from.mockReturnValueOnce(permanent.chain).mockReturnValueOnce(recent.chain);

    const out = await getSentEmails();

    const recentStatuses = recent.calls.filter((c) => c.method === 'in').flatMap((c) => c.args[1] as string[]);
    expect(recentStatuses).toEqual(expect.arrayContaining(['sent', 'opened', 'auto_replied']));
    expect(recentStatuses).not.toEqual(expect.arrayContaining(['bounced']));
    expect(recent.calls.filter((c) => c.method === 'gte').map((c) => c.args))
      .toEqual([['sent_at', '2026-08-07']]);
    expect(out.has('recent@x.com')).toBe(true);
  });
});
