import { describe, it, expect } from 'vitest';
import { isTerminalOnboardStatus } from '../social-connect-worker.js';

// The onboard branch must HOLD the module-level `busy` guard (and keep the
// AdsPower CDP stream alive) for the whole session — it must NOT release at
// 'ready'. isTerminalOnboardStatus is the exact predicate handleOnboardRequest
// uses to decide when the session is actually over; the surrounding
// hold/teardown wiring (spawn, Supabase, setInterval) has no unit harness, so
// this is the one piece of that decision this suite can pin down directly.
describe('isTerminalOnboardStatus', () => {
  it('treats captured, expired, and ended as terminal', () => {
    expect(isTerminalOnboardStatus('captured')).toBe(true);
    expect(isTerminalOnboardStatus('expired')).toBe(true);
    expect(isTerminalOnboardStatus('ended')).toBe(true);
  });

  it('does NOT treat ready as terminal (this was the bug: releasing busy at ready)', () => {
    expect(isTerminalOnboardStatus('ready')).toBe(false);
  });

  it('does not treat provisioning, requested, failed, active, null, or undefined as terminal', () => {
    expect(isTerminalOnboardStatus('provisioning')).toBe(false);
    expect(isTerminalOnboardStatus('requested')).toBe(false);
    expect(isTerminalOnboardStatus('failed')).toBe(false);
    expect(isTerminalOnboardStatus('active')).toBe(false);
    expect(isTerminalOnboardStatus(null)).toBe(false);
    expect(isTerminalOnboardStatus(undefined)).toBe(false);
  });
});
