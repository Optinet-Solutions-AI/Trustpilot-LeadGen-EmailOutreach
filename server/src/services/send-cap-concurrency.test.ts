import { describe, test, expect } from 'vitest';
import { exclusive } from './tick-guard.js';

/**
 * The cap held in every test we had, and broke in production, because every
 * test ran one loop at a time.
 *
 * Both send loops poll on a 60-second interval and each tick begins by
 * loading a snapshot of how much each mailbox has already sent. That is safe
 * only while one tick runs at a time. When a tick overruns the interval, the
 * next starts anyway, takes its own snapshot, and the two independently fill
 * the same mailbox to the cap.
 *
 * Measured 2026-09-19: ethan and grace each sent 25 against a cap of 20, and
 * 70 emails went out against a 60/day ceiling — 17 of them inside 1.6 seconds
 * on a loop that paces sends 2 seconds apart.
 *
 * This reproduces the shape of that loop so the guarantee is pinned down.
 */

const CAP = 20;

/** A mailbox whose count is only persisted after each send, as in the real loop. */
function mailbox() {
  return { persisted: 0, delivered: [] as number[] };
}

/**
 * One tick: snapshot the count, then send while the snapshot says there is
 * room. This mirrors loadSentCounts() + recordSend() exactly.
 */
function makeTick(box: ReturnType<typeof mailbox>) {
  return async () => {
    let inMemory = box.persisted; // the snapshot taken at tick start
    while (inMemory < CAP) {
      await new Promise((r) => setTimeout(r, 1)); // send latency
      box.delivered.push(Date.now());
      box.persisted += 1;
      inMemory += 1;
    }
  };
}

describe('per-mailbox cap under overlapping ticks', () => {
  test('WITHOUT a guard, two overlapping ticks blow through the cap', async () => {
    // This is the production failure, reproduced. Kept as a test so the
    // regression is visible rather than theoretical.
    const box = mailbox();
    const tick = makeTick(box);
    await Promise.all([tick(), tick()]);

    expect(box.delivered.length).toBeGreaterThan(CAP);
  });

  test('WITH the guard, the cap holds however often the interval fires', async () => {
    const box = mailbox();
    const tick = exclusive(makeTick(box), 'test', () => {});

    // Five interval firings landing on top of each other.
    await Promise.all([tick(), tick(), tick(), tick(), tick()]);

    expect(box.delivered).toHaveLength(CAP);
  });

  test('the guard does not stop the NEXT tick once capacity frees up', async () => {
    const box = mailbox();
    const tick = exclusive(makeTick(box), 'test', () => {});
    await tick();
    expect(box.delivered).toHaveLength(CAP);

    // A day later the rolling window has moved and the mailbox has room again.
    box.persisted = 0;
    await tick();
    expect(box.delivered).toHaveLength(CAP * 2);
  });

  test('a tick that throws does not leave the loop permanently shut', async () => {
    const box = mailbox();
    let first = true;
    const tick = exclusive(async () => {
      if (first) { first = false; throw new Error('transient'); }
      await makeTick(box)();
    }, 'test', () => {});

    await expect(tick()).rejects.toThrow('transient');
    await tick();
    expect(box.delivered).toHaveLength(CAP);
  });
});
