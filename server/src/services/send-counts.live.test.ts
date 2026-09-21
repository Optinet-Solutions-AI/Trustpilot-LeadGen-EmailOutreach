import { describe, test, expect, vi } from 'vitest';
import { decideAgainstLiveCount } from './send-counts.js';

/**
 * The per-mailbox cap was enforced against a snapshot taken once, at the top
 * of each tick. That is safe only while one tick runs at a time, and this
 * service runs up to ten instances: each takes its own snapshot and each
 * independently allows a full cap's worth on top of the others.
 *
 * The in-process guard stops a loop overlapping ITSELF. It cannot see the
 * other nine instances. Re-reading the real count in the instant before each
 * send narrows the window from a whole tick to a single send — worst case
 * becomes cap + (instances - 1) rather than cap x instances.
 *
 * Measured 2026-09-19 under the old behaviour: two mailboxes reached 25
 * against a cap of 20, 70 emails against a 60/day ceiling.
 */

describe('decideAgainstLiveCount', () => {
  test('sends when the live count is under the ceiling', async () => {
    const read = vi.fn(async () => 19);
    await expect(decideAgainstLiveCount('a@b.com', 20, read)).resolves.toEqual({ send: true });
  });

  test('refuses at the ceiling, even if the tick snapshot said otherwise', async () => {
    // The snapshot is exactly what was wrong; this asks the database instead.
    const read = vi.fn(async () => 20);
    await expect(decideAgainstLiveCount('a@b.com', 20, read))
      .resolves.toEqual({ send: false, reason: 'at_cap', count: 20 });
  });

  test('refuses when another instance has already pushed it over', async () => {
    const read = vi.fn(async () => 24);
    await expect(decideAgainstLiveCount('a@b.com', 20, read))
      .resolves.toEqual({ send: false, reason: 'at_cap', count: 24 });
  });

  test('a read failure refuses the send rather than assuming room', async () => {
    // Fail closed. Assuming zero on a failed read is how a cap becomes a
    // suggestion during a database blip.
    const read = vi.fn(async () => { throw new Error('timeout'); });
    await expect(decideAgainstLiveCount('a@b.com', 20, read))
      .resolves.toEqual({ send: false, reason: 'count_unavailable' });
  });

  test('a mailbox with no address cannot be checked, so it does not send', async () => {
    const read = vi.fn(async () => 0);
    await expect(decideAgainstLiveCount(null, 20, read))
      .resolves.toEqual({ send: false, reason: 'no_sender' });
    expect(read).not.toHaveBeenCalled();
  });

  test('the address is normalised before it is counted', async () => {
    const read = vi.fn(async () => 0);
    await decideAgainstLiveCount('  Grace@RP.Example.COM ', 20, read);
    expect(read).toHaveBeenCalledWith('grace@rp.example.com');
  });
});
