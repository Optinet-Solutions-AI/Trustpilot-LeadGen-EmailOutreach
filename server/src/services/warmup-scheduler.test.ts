import { describe, test, expect, vi, afterEach } from 'vitest';

// The module pulls in supabase via getSupabase(); mock it so importing the
// module for the pure gate helper has no side effects.
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({ from: vi.fn() }) }));

import { isWarmupSchedulerEnabled } from './warmup-scheduler.js';

const ORIGINAL = process.env.WARMUP_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WARMUP_ENABLED;
  else process.env.WARMUP_ENABLED = ORIGINAL;
});

describe('isWarmupSchedulerEnabled', () => {
  test('is OFF when WARMUP_ENABLED is unset — this tool does not run warm-up', () => {
    // It used to default ON, and the variable was never set on Cloud Run, so
    // the warm-up loop ran every 10 minutes for months against dead
    // credentials: 71 failed logins in two hours on 2026-09-21 alone. Warming
    // happens upstream at the delivery vendor; nothing here should send it,
    // and an unset variable must never be the thing that turns sending on.
    delete process.env.WARMUP_ENABLED;
    expect(isWarmupSchedulerEnabled()).toBe(false);
  });

  test('returns false when WARMUP_ENABLED=false', () => {
    process.env.WARMUP_ENABLED = 'false';
    expect(isWarmupSchedulerEnabled()).toBe(false);
  });

  test('is case-insensitive for false', () => {
    process.env.WARMUP_ENABLED = 'FALSE';
    expect(isWarmupSchedulerEnabled()).toBe(false);
  });

  test('returns true for any non-false value', () => {
    process.env.WARMUP_ENABLED = 'true';
    expect(isWarmupSchedulerEnabled()).toBe(true);
  });
});
