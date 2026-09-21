import { describe, test, expect, vi } from 'vitest';
import { acquireSchedulerLock, classifyLockError } from './scheduler-lock.js';

/**
 * The send loops run on every instance and this service scales to 10, so the
 * per-mailbox cap was judged ten times over: on 2026-09-19 two mailboxes
 * reached 25 against a cap of 20 and 70 emails left against a ceiling of 60.
 * The in-process guard added earlier cannot see the other instances.
 *
 * Exactly one instance must hold the lock. Just as important, a missing table
 * must NOT stop sending: the migration is applied by hand, and a deploy that
 * silently halted every campaign because a table did not exist yet would be a
 * worse failure than the one being fixed. That case reports `unavailable` and
 * the caller carries on with the older, narrower protection.
 */

const DUPLICATE = { code: '23505', message: 'duplicate key value violates unique constraint "scheduler_locks_pkey"' };
const NO_TABLE = { code: '42P01', message: 'relation "scheduler_locks" does not exist' };
const NO_TABLE_REST = { code: 'PGRST205', message: "Could not find the table 'public.scheduler_locks'" };

/** insertResult decides the INSERT; updateRows decides the takeover UPDATE. */
function fakeDb(insertResult: unknown, updateRows: unknown[] = []) {
  const select = vi.fn(async () => ({ data: updateRows, error: null }));
  const lt = vi.fn(() => ({ select }));
  const eq = vi.fn(() => ({ lt }));
  const update = vi.fn(() => ({ eq }));
  const insert = vi.fn(async () => ({ error: insertResult }));
  return {
    client: { from: vi.fn(() => ({ insert, update })) },
    insert, update, eq, lt, select,
  };
}

describe('acquireSchedulerLock', () => {
  test('an unheld lock is taken by a plain insert', async () => {
    const db = fakeDb(null);
    const got = await acquireSchedulerLock(db.client as never, 'send', 'instance-a', 60_000);
    expect(got).toBe('acquired');
    expect(db.insert).toHaveBeenCalledOnce();
  });

  test('a lock held by a live instance is refused', async () => {
    // Insert collides and no expired row matches the takeover.
    const db = fakeDb(DUPLICATE, []);
    const got = await acquireSchedulerLock(db.client as never, 'send', 'instance-b', 60_000);
    expect(got).toBe('held_by_other');
  });

  test('an EXPIRED lock is taken over, so a dead instance cannot block for ever', async () => {
    const db = fakeDb(DUPLICATE, [{ name: 'send' }]);
    const got = await acquireSchedulerLock(db.client as never, 'send', 'instance-b', 60_000);
    expect(got).toBe('acquired');
    expect(db.update).toHaveBeenCalled();
  });

  test('a missing table reports unavailable rather than blocking sending', async () => {
    // The migration is applied by hand. A deploy that reached production
    // first must not stop every campaign.
    for (const err of [NO_TABLE, NO_TABLE_REST]) {
      const db = fakeDb(err);
      const got = await acquireSchedulerLock(db.client as never, 'send', 'a', 60_000);
      expect(got).toBe('unavailable');
    }
  });

  test('any other database error is unavailable too, never a false acquire', async () => {
    const db = fakeDb({ code: '08006', message: 'connection failure' });
    expect(await acquireSchedulerLock(db.client as never, 'send', 'a', 60_000)).toBe('unavailable');
  });

  test('the holder and an expiry are written, so the lock can be taken over later', async () => {
    const db = fakeDb(null);
    await acquireSchedulerLock(db.client as never, 'send', 'instance-a', 60_000);
    const row = db.insert.mock.calls[0][0] as Record<string, string>;
    expect(row.name).toBe('send');
    expect(row.holder).toBe('instance-a');
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('classifyLockError', () => {
  test('knows a duplicate from a missing table', () => {
    expect(classifyLockError(DUPLICATE)).toBe('duplicate');
    expect(classifyLockError(NO_TABLE)).toBe('no_table');
    expect(classifyLockError(NO_TABLE_REST)).toBe('no_table');
  });

  test('anything else is just an error', () => {
    expect(classifyLockError({ code: '08006', message: 'connection failure' })).toBe('error');
    expect(classifyLockError(null)).toBe('none');
  });
});
