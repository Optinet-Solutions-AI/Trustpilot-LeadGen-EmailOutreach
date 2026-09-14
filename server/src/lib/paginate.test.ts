import { describe, test, expect, vi } from 'vitest';
import { selectAllRows } from './paginate.js';

/**
 * PostgREST caps every response at 1,000 rows and says nothing about it: a
 * `.limit(20000)` comes back with exactly 1,000 and no error, no truncation
 * flag, no hint. Eight call sites believed their limit — the send calendar,
 * the queue re-pacer and the shared day-load among them — so each was
 * reasoning about the first thousand rows of a 1,400-row table and quietly
 * getting the wrong answer. The re-pacer "re-paced" 11 rows out of 692.
 *
 * Anything that must see a whole table pages through it.
 */

/** A fake PostgREST that holds `total` rows and never returns more than 1,000. */
function fakeTable(total: number, cap = 1000) {
  return vi.fn(async (from: number, to: number) => {
    const size = Math.min(to - from + 1, cap);
    const rows = Array.from({ length: Math.max(0, Math.min(size, total - from)) },
      (_, i) => ({ id: from + i }));
    return { data: rows, error: null };
  });
}

describe('selectAllRows', () => {
  test('pages past the 1,000-row cap instead of stopping at it', async () => {
    const query = fakeTable(1445);
    const rows = await selectAllRows(query);
    expect(rows).toHaveLength(1445);
    expect(rows[0]).toEqual({ id: 0 });
    expect(rows[1444]).toEqual({ id: 1444 });
  });

  test('a short page ends the walk — no wasted round trip', async () => {
    const query = fakeTable(1500);
    await selectAllRows(query);
    // 1000 + 500: the second page is short, so there is no third request.
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('an exact multiple of the page size needs one more request to know', async () => {
    const query = fakeTable(2000);
    const rows = await selectAllRows(query);
    expect(rows).toHaveLength(2000);
    expect(query).toHaveBeenCalledTimes(3); // 1000, 1000, then the empty page
  });

  test('a table smaller than one page is one request', async () => {
    const query = fakeTable(12);
    const rows = await selectAllRows(query);
    expect(rows).toHaveLength(12);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('an empty table yields nothing and does not loop', async () => {
    const query = fakeTable(0);
    expect(await selectAllRows(query)).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('an error is raised, never silently returned as a partial list', async () => {
    // Half a queue is more dangerous than no queue: it reads as authoritative.
    const query = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    await expect(selectAllRows(query)).rejects.toThrow('boom');
  });

  test('an error on a LATER page still raises', async () => {
    let call = 0;
    const query = vi.fn(async (from: number, to: number) => {
      call += 1;
      if (call > 1) return { data: null, error: { message: 'page 2 failed' } };
      return {
        data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })),
        error: null,
      };
    });
    await expect(selectAllRows(query)).rejects.toThrow('page 2 failed');
  });

  test('asks for each page by its own range', async () => {
    const query = fakeTable(2500);
    await selectAllRows(query);
    expect(query.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  test('a custom page size is honoured', async () => {
    const query = fakeTable(250, 100);
    const rows = await selectAllRows(query, { pageSize: 100 });
    expect(rows).toHaveLength(250);
    expect(query.mock.calls[0]).toEqual([0, 99]);
  });

  test('a runaway walk is stopped rather than fetching for ever', async () => {
    // A server that always returns a full page would otherwise loop until the
    // request timed out, with the memory to match.
    const query = vi.fn(async (from: number, to: number) => ({
      data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })),
      error: null,
    }));
    await expect(selectAllRows(query, { maxRows: 5000 })).rejects.toThrow(/more than 5000/);
  });
});
