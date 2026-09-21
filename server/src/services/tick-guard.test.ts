import { describe, test, expect, vi } from 'vitest';
import { exclusive } from './tick-guard.js';

/**
 * Both send loops ran on a bare `setInterval`. The interval fires every 60
 * seconds whether or not the previous tick has finished, so a tick that runs
 * long overlaps the next one — and each overlapping tick had loaded its OWN
 * snapshot of "how much has this mailbox sent today", so each independently
 * allowed sends up to the cap.
 *
 * Measured 2026-09-19: 17 follow-ups left in 1.6 seconds from a single
 * instance, on a loop that paces sends 2 seconds apart — only possible with
 * several ticks in flight at once. Two mailboxes reached 25 sends against a
 * cap of 20, and 70 emails went out against a 60/day ceiling.
 *
 * A tick that is still running must not be started again.
 */

describe('exclusive', () => {
  test('a second call while the first is still running is skipped', async () => {
    let active = 0;
    let maxActive = 0;
    const work = exclusive(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    }, 'test');

    await Promise.all([work(), work(), work()]);
    expect(maxActive).toBe(1);
  });

  test('the skipped call returns without throwing', async () => {
    const work = exclusive(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'done';
    }, 'test');

    const [first, second] = await Promise.all([work(), work()]);
    expect(first).toBe('done');
    expect(second).toBeUndefined();
  });

  test('the guard releases so the NEXT tick can run', async () => {
    const calls: number[] = [];
    const work = exclusive(async () => { calls.push(1); }, 'test');
    await work();
    await work();
    await work();
    expect(calls).toHaveLength(3);
  });

  test('a throwing tick still releases the guard — it must not wedge for ever', async () => {
    // Without the finally, one failed tick would stop sending permanently.
    let attempts = 0;
    const work = exclusive(async () => {
      attempts += 1;
      throw new Error('boom');
    }, 'test');

    await expect(work()).rejects.toThrow('boom');
    await expect(work()).rejects.toThrow('boom');
    expect(attempts).toBe(2);
  });

  test('it reports the skip so a pile-up is visible in the logs', async () => {
    const log = vi.fn();
    const work = exclusive(async () => {
      await new Promise((r) => setTimeout(r, 20));
    }, 'SequenceScheduler', log);

    await Promise.all([work(), work()]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('SequenceScheduler');
  });

  test('two separate guards do not block each other', async () => {
    // The campaign loop and the follow-up loop each need their own.
    let a = 0; let b = 0;
    const workA = exclusive(async () => { a += 1; await new Promise((r) => setTimeout(r, 20)); }, 'a');
    const workB = exclusive(async () => { b += 1; await new Promise((r) => setTimeout(r, 20)); }, 'b');
    await Promise.all([workA(), workB()]);
    expect([a, b]).toEqual([1, 1]);
  });
});
